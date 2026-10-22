/**
 * #2044 (S7), cor:agt:040:06 / cor:acl:010:01 — the audience of an App's INSTALL
 * MEMORY, asked through every shared gate (MCP point gates and map, the GraphQL
 * record / write / delete gates, the effective-access audit).
 *
 * Content: the live App's participants. Write: whoever manages the App, while
 * the App is live and the Agent installed. Delete (R45): whoever manages the
 * App, also after the App was soft-deleted, which opens the record and nothing
 * else. Every refusal is the same not-found shape as a missing memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess, getAccessibleMemoryIds as mcpAccessible } from '../../mcp/access-control.js';
import type { AuthContext } from '../../middleware/auth.js';
import {
  canReadMemoryRecord, getAccessibleMemoryIds, requireMemoryWriteAccess, type Context,
} from '../../api/graphql/schema/resolvers.helpers.js';
import { computeEffectiveAccess } from './effectiveAccess.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { installMemoryAudience } from './installMemory.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'im-org', urn: 'im-org' } })).id;
});

async function user(name: string) {
  return db.user.create({ data: { id: generateId(), name } });
}
async function orgRole(userId: string, role: 'ADMIN' | 'OWNER' | 'CONTRIBUTOR' | 'READER', organizationId = orgId) {
  await db.orgMember.create({ data: { organizationId, userId, role } });
}

async function fixture() {
  const agent = await db.agent.create({
    data: { id: generateId(), name: 'Team Agent', urn: `${orgId}:team-agent`, organizationId: orgId },
  });
  const { app } = await createDbAppWithKey(db, 'im-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const install = await db.memory.create({
    data: {
      id: generateId(), class: 'system', name: 'im-app-install', urn: `${orgId}:im-app-team-agent-install`,
      organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true,
    },
  });
  await db.node.create({ data: { id: generateId(), memoryId: install.id, loc: 'prompts:lane', name: 'Lane', nodeType: 'page' } });

  const admin = await user('org-admin'); await orgRole(admin.id, 'ADMIN');
  const appOwner = await user('app-owner'); await createDbAppMember(db, app.id, appOwner.id, 'owner');
  const member = await user('plain-member'); await createDbAppMember(db, app.id, member.id, 'member');
  const contributor = await user('contributor'); await orgRole(contributor.id, 'CONTRIBUTOR');
  const stranger = await user('stranger');
  const revokedAdmin = await user('revoked-admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: revokedAdmin.id, role: 'ADMIN', deletedAt: new Date() } });
  // A plain member of ANOTHER App of the same org, with no org role at all.
  const { app: other } = await createDbAppWithKey(db, 'other-app', orgId);
  const otherMember = await user('other-app-member'); await createDbAppMember(db, other.id, otherMember.id, 'member');
  // An admin of a different org.
  const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'foreign', urn: 'foreign' } });
  const foreignAdmin = await user('foreign-admin'); await orgRole(foreignAdmin.id, 'ADMIN', foreignOrg.id);
  return { agent, app, other, install, admin, appOwner, member, contributor, stranger, revokedAdmin, otherMember, foreignAdmin };
}

const auth = (userId: string, extra: Partial<AuthContext> = {}) =>
  ({ userId, organizationId: orgId, roles: [], clientId: `user:${userId}`, ...extra }) as AuthContext;
const gql = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ db, userId, roles: [], clientId: `user:${userId}`, ...extra }) as unknown as Context;

type Who = keyof Awaited<ReturnType<typeof fixture>>;

describe('#2044 install memory — read / write / delete audience (live App)', () => {
  it('participants read; only managers write; everyone else gets nothing', async () => {
    const f = await fixture();
    const expectations: Array<[Who, boolean, boolean]> = [
      ['member', true, false],
      ['contributor', true, false],
      ['appOwner', true, true],
      ['admin', true, true],
      ['stranger', false, false],
      ['revokedAdmin', false, false],
      ['otherMember', false, false],
      ['foreignAdmin', false, false],
    ];
    for (const [who, canRead, canWrite] of expectations) {
      const u = (f[who] as { id: string }).id;
      expect(await canReadMemory(db, auth(u), f.install.id), `${who} read`).toBe(canRead);
      // The MCP point gate never writes it: the fenced door is the GraphQL one (`install` target).
      expect(await canWriteToMemory(db, auth(u), f.install.id), `${who} mcp write`).toBe(false);
      const map = await getMemoryAccess(db, auth(u));
      expect(map.get(f.install.id) ?? null, `${who} map`).toBe(canRead ? 'READ_ONLY' : null);
      expect((await getAccessibleMemoryIds(gql(u), f.install.id))?.includes(f.install.id) ?? false, `${who} gql ids`).toBe(canRead);
      expect(await canReadMemoryRecord(gql(u), f.install), `${who} record`).toBe(canRead);
      const eff = await computeEffectiveAccess(db, { id: u, roles: [] }, { kind: 'memory', memory: { ...(await db.memory.findUniqueOrThrow({ where: { id: f.install.id }, include: { workerOf: true } })) } as never });
      expect(eff.canRead, `${who} effective read`).toBe(canRead);
      expect(eff.canWrite, `${who} effective write`).toBe(canWrite);
      // The door's pooled pre-flight (writeNodeCore sets the marker; any other pooled writer fails closed).
      if (canWrite) await expect(requireMemoryWriteAccess(gql(u, { installWritePreflight: true }), f.install.id)).resolves.toBeUndefined();
      else await expect(requireMemoryWriteAccess(gql(u, { installWritePreflight: true }), f.install.id)).rejects.toThrow('Forbidden');
      await expect(requireMemoryWriteAccess(gql(u), f.install.id), `${who} unmarked pooled`).rejects.toThrow('Forbidden');
    }
  });

  it('no platform-role shortcut: a platform ADMIN who does not participate reads nothing, and a stale role grants nothing', async () => {
    const f = await fixture();
    const platform = await user('platform-admin');
    const a = auth(platform.id, { roles: ['ADMIN'] });
    expect(await canReadMemory(db, a, f.install.id)).toBe(false);
    expect(await mcpAccessible(db, a)).toBeNull(); // the "all" marker is the caller's job to filter
    expect((await getAccessibleMemoryIds(gql(platform.id, { roles: ['ADMIN'] }), f.install.id))).not.toContain(f.install.id);
  });

  it('an App key, a bound session, an impersonation and an AppRun principal never reach it', async () => {
    const f = await fixture();
    const appKey = { appId: f.app.id, organizationId: orgId, roles: [], clientId: `app:${f.app.id}` } as AuthContext;
    expect(await canReadMemory(db, appKey, f.install.id)).toBe(false);
    expect(await canWriteToMemory(db, appKey, f.install.id)).toBe(false);
    const run = auth(f.admin.id, { appId: f.app.id, clientId: 'run:abc' });
    expect(await canReadMemory(db, run, f.install.id)).toBe(false);
    expect(await canWriteToMemory(db, run, f.install.id)).toBe(false);
    const imp = auth(f.admin.id, { impersonation: { orgId } } as Partial<AuthContext>);
    expect(await canWriteToMemory(db, imp, f.install.id)).toBe(false);
  });

  it('an Agent that is no longer installed keeps the memory readable but takes no write', async () => {
    const f = await fixture();
    await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } });
    expect(await canReadMemory(db, auth(f.member.id), f.install.id)).toBe(true);
    expect(await canWriteToMemory(db, auth(f.admin.id), f.install.id)).toBe(false);
    await expect(requireMemoryWriteAccess(gql(f.admin.id), f.install.id)).rejects.toThrow('Forbidden');
  });

  it('a plain AppMember of another App in the same org reads nothing (no org-wide narrowing is tested here)', async () => {
    const f = await fixture();
    expect(await canReadMemory(db, auth(f.otherMember.id), f.install.id)).toBe(false);
    expect(await canReadMemoryRecord(gql(f.otherMember.id), f.install)).toBe(false);
  });
});

describe('#2044 install memory — after the App is soft-deleted (ruling A, R45)', () => {
  async function deleted() {
    const f = await fixture();
    await db.app.update({ where: { id: f.app.id }, data: { deletedAt: new Date() } });
    return f;
  }

  it('the memory is kept; nobody reads its content or writes it; managers find the record', async () => {
    const f = await deleted();
    const row = await db.memory.findUniqueOrThrow({ where: { id: f.install.id } });
    expect(row.deletedAt).toBeNull();
    for (const who of ['member', 'contributor', 'appOwner', 'admin'] as const) {
      const u = f[who].id;
      expect(await canReadMemory(db, auth(u), f.install.id), `${who} read`).toBe(false);
      expect(await canWriteToMemory(db, auth(u), f.install.id), `${who} write`).toBe(false);
      expect((await getAccessibleMemoryIds(gql(u), f.install.id)) ?? []).not.toContain(f.install.id);
    }
    for (const [who, record] of [['admin', true], ['appOwner', true], ['member', false], ['contributor', false],
      ['stranger', false], ['revokedAdmin', false], ['foreignAdmin', false], ['otherMember', false]] as const) {
      expect(await canReadMemoryRecord(gql(f[who].id), f.install), `${who} record`).toBe(record);
    }
  });

  it('whoever manages the App deletes it by hand; everyone else gets the same not-found', async () => {
    for (const [who, ok] of [['admin', true], ['appOwner', true], ['member', false], ['contributor', false],
      ['stranger', false], ['revokedAdmin', false], ['foreignAdmin', false], ['otherMember', false]] as const) {
      const f = await deleted();
      const run = () => (resolvers.Mutation as any).deleteMemory({}, { id: f.install.id }, gql(f[who].id));
      if (ok) {
        await expect(run(), who).resolves.toBe(true);
        expect((await db.memory.findUniqueOrThrow({ where: { id: f.install.id } })).deletedAt, who).not.toBeNull();
      } else {
        // The same not-found a missing memory gives: nothing about the record leaks.
        await expect(run(), who).rejects.toThrow(/MEMORY_NOT_FOUND/);
        expect((await db.memory.findUniqueOrThrow({ where: { id: f.install.id } })).deletedAt, who).toBeNull();
      }
      await cleanDb(db);
      orgId = (await db.organization.create({ data: { id: generateId(), name: 'im-org', urn: 'im-org' } })).id;
    }
  });

  it('a live-App manager deletes it too, and an Agent system memory is still undeletable by hand', async () => {
    const f = await fixture();
    await expect((resolvers.Mutation as any).deleteMemory({}, { id: f.install.id }, gql(f.admin.id))).resolves.toBe(true);
    const own = await db.memory.create({
      data: { id: generateId(), class: 'system', name: 'brain', urn: `${orgId}:brain`, organizationId: orgId },
    });
    await expect((resolvers.Mutation as any).deleteMemory({}, { id: own.id }, gql(f.admin.id)))
      .rejects.toThrow(/system memory/i);
  });

  it('the audience is computed once: a deleted App yields record+delete for managers only', async () => {
    const f = await deleted();
    const row = await db.memory.findUniqueOrThrow({ where: { id: f.install.id } });
    expect(await installMemoryAudience(db, { userId: f.admin.id, roles: [] }, row)).toEqual({ read: false, record: true, write: false, delete: true });
    expect(await installMemoryAudience(db, { userId: f.member.id, roles: [] }, row)).toEqual({ read: false, record: false, write: false, delete: false });
  });
});

describe('#2044 install memory — user-owned App', () => {
  it('participants read, the owner writes and deletes, and a deleted App leaves the owner record+delete only', async () => {
    const owner = await user('uo-owner');
    const member = await user('uo-member');
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Mine', urn: `uo:mine`, ownerUserId: owner.id } });
    const app = await db.app.create({ data: { id: generateId(), name: 'uo-app', urn: 'uo:uo-app', ownerUserId: owner.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await createDbAppMember(db, app.id, member.id, 'member');
    const install = await db.memory.create({
      data: { id: generateId(), class: 'system', name: 'uo-install', urn: 'uo:uo-install', ownerUserId: owner.id, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true },
    });
    expect(await canReadMemory(db, auth(member.id), install.id)).toBe(true);
    expect(await canWriteToMemory(db, auth(member.id), install.id)).toBe(false);
    expect(await canReadMemory(db, auth(owner.id), install.id)).toBe(true);
    expect(await canWriteToMemory(db, auth(owner.id), install.id)).toBe(false);
    await expect(requireMemoryWriteAccess(gql(owner.id, { installWritePreflight: true }), install.id)).resolves.toBeUndefined();
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    // The owner-column blanket (READ_WRITE on everything user-owned) must not outlive the App.
    expect(await canReadMemory(db, auth(owner.id), install.id)).toBe(false);
    expect((await getMemoryAccess(db, auth(owner.id))).has(install.id)).toBe(false);
    expect((await getAccessibleMemoryIds(gql(owner.id), install.id)) ?? []).not.toContain(install.id);
    expect(await canReadMemoryRecord(gql(owner.id), install)).toBe(true);
    await expect((resolvers.Mutation as any).deleteMemory({}, { id: install.id }, gql(member.id))).rejects.toThrow();
    await expect((resolvers.Mutation as any).deleteMemory({}, { id: install.id }, gql(owner.id))).resolves.toBe(true);
  });
});

describe('#2044 install memory — database invariants', () => {
  it('rejects a system row with an app and no Agent, install_of_agent_id on another class, and a second live install', async () => {
    const f = await fixture();
    const base = { id: generateId(), organizationId: orgId };
    await expect(db.memory.create({ data: { ...base, class: 'system', name: 'x1', urn: `${orgId}:x1`, appId: f.app.id } })).rejects.toThrow();
    await expect(db.memory.create({ data: { ...base, id: generateId(), class: 'system', name: 'x2', urn: `${orgId}:x2`, installOfAgentId: f.agent.id } })).rejects.toThrow();
    await expect(db.memory.create({ data: { ...base, id: generateId(), class: 'knowledge', name: 'x3', urn: `${orgId}:x3`, installOfAgentId: f.agent.id } })).rejects.toThrow();
    await expect(db.memory.create({ data: { ...base, id: generateId(), class: 'system', name: 'x4', urn: `${orgId}:x4`, appId: f.app.id, installOfAgentId: f.agent.id } })).rejects.toThrow();
    // A tombstoned install does not hold the slot.
    await db.memory.update({ where: { id: f.install.id }, data: { deletedAt: new Date() } });
    await expect(db.memory.create({ data: { ...base, id: generateId(), class: 'system', name: 'x5', urn: `${orgId}:x5`, appId: f.app.id, installOfAgentId: f.agent.id, isInstallMemory: true } })).resolves.toBeTruthy();
    // R94 C: the Agent link may be NULL (a detached install) but the discriminator may not.
    const detached = { ...base, class: 'system' as const, appId: f.app.id, isInstallMemory: true };
    await expect(db.memory.create({ data: { ...detached, id: generateId(), name: 'd0', urn: `${orgId}:d0`, appId: null } })).rejects.toThrow();
    await expect(db.memory.create({ data: { ...base, id: generateId(), class: 'knowledge', name: 'd1', urn: `${orgId}:d1`, isInstallMemory: true } })).rejects.toThrow();
    await expect(db.memory.create({ data: { ...base, id: generateId(), class: 'system', name: 'd2', urn: `${orgId}:d2`, installOfAgentId: f.agent.id, appId: f.app.id } })).rejects.toThrow();
    await expect(db.memory.create({ data: { ...detached, id: generateId(), name: 'd3', urn: `${orgId}:d3` } })).resolves.toBeTruthy();
    // Erasing the Agent detaches the install row instead of failing on the FK or deleting it.
    const row = await db.memory.findFirstOrThrow({ where: { appId: f.app.id, installOfAgentId: f.agent.id, deletedAt: null } });
    await db.appAgent.deleteMany({ where: { agentId: f.agent.id } });
    await db.agent.delete({ where: { id: f.agent.id } });
    expect(await db.memory.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ installOfAgentId: null, isInstallMemory: true });
  });
});
