/**
 * spec 047 Phase 2c-2b — user-owned App creation + install/license + the
 * owner-only surfaces this makes reachable (security blockers 2 & 3).
 *
 * `createApp` with NO `orgId` creates an App owned by the caller (`ownerUserId`
 * set, org NULL) namespaced under `@<handle>`. A personal App may install only
 * a PUBLIC (marketplace) agent or the caller's OWN agent; a PUBLIC install is
 * licensed by an auto-provisioned `AgentSubscription` (no `AgentOrgGrant`). The
 * App is owner-only: platform admins get no bypass on its keys / AI config /
 * member management, and its foreign user-owned memories never fold into its
 * access map.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentImport, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getAppMemoryAccess } from '../../../mcp/access-control.js';
import { isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { emitEntityUrnV2 } from '../../../lib/urnEmit.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(over: Partial<Context> = {}): Context {
  return { db, ...over };
}

let ownerId: string;
let otherId: string;
let pubOrgId: string;
let publicAgentId: string;

/** An org-owned PUBLIC (marketplace) agent + its system memory. */
async function seedPublicAgent() {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Publisher', urn: `publisher-${generateId()}` },
  });
  const sys = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'GA System', urn: `${org.urn}:gmail-agent-system`, organizationId: org.id, acceptsUploads: false },
  });
  const agent = await db.agent.create({
    data: { id: generateId(), name: 'Gmail Agent', urn: `${org.urn}:gmail-agent`, organizationId: org.id, visibility: 'PUBLIC', systemMemoryId: sys.id },
  });
  return { orgId: org.id, agentId: agent.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const owner = await db.user.create({ data: { id: generateId(), name: 'App Owner', handle: 'appowner', roles: ['READER'] } });
  const other = await db.user.create({ data: { id: generateId(), name: 'Other', handle: 'appother', roles: ['READER'] } });
  ownerId = owner.id;
  otherId = other.id;
  const seeded = await seedPublicAgent();
  pubOrgId = seeded.orgId;
  publicAgentId = seeded.agentId;
});

describe('createApp — user-owned (no orgId), installing a PUBLIC agent', () => {
  it('creates a user-owned App under the bare handle root, licensed by a subscription (no org grant)', async () => {
    const app = await resolvers.Mutation.createApp(
      {},
      { agentRef: publicAgentId, name: 'My Gmail' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(app.organizationId).toBeNull();
    expect(app.ownerUserId).toBe(ownerId);
    // #697 v2: the user-owned root is the BARE handle — no `@` sigil.
    expect(app.urn).toBe('appowner:my-gmail');
    // Round-trip (Codex P2, #720): the emitted v2 URN resolves back to this row.
    const emittedApp = emitEntityUrnV2('app', app.urn);
    expect(emittedApp).toBe('hrn:app:appowner:my-gmail');
    expect(await resolveAppRef(db, emittedApp)).toEqual({ id: app.id });

    // The agent is linked.
    const link = await db.appAgent.findFirst({ where: { appId: app.id, agentId: publicAgentId } });
    expect(link).not.toBeNull();

    // Licensed by an active AgentSubscription — NOT an AgentOrgGrant.
    const sub = await db.agentSubscription.findUnique({
      where: { userId_agentId: { userId: ownerId, agentId: publicAgentId } },
    });
    expect(sub?.activatedAt).toBeTruthy();
    expect(sub?.revokedAt).toBeNull();
    const grantCount = await db.agentOrgGrant.count({ where: { agentId: publicAgentId } });
    expect(grantCount).toBe(0);

    // The owner is auto-added as an owner AppMember.
    const member = await db.appMember.findUnique({
      where: { appId_userId: { appId: app.id, userId: ownerId } },
    });
    expect(member?.role).toBe('owner');
  });

  it('removes a foreign PUBLIC Agent from a personal App access fold and list when its subscription is revoked', async () => {
    const memory = await db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', name: 'Publisher note',
        urn: `${generateId()}:publisher-note`, organizationId: pubOrgId, visibility: 'PUBLIC',
      },
    });
    await db.agentMemoryItem.create({ data: { agentId: publicAgentId, memoryId: memory.id, role: 'read' } });
    const app = await resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Subscribed App' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const list = () => resolvers.Query.memories(null, { filter: { memoryClasses: ['knowledge'] } }, ctx({ appId: app.id }));
    expect(await isAgentInstalledAndLicensed(db, app.id, publicAgentId)).toBe(true);
    expect((await getAppMemoryAccess(db, app.id)).has(memory.id)).toBe(true);
    expect((await list()).items.map((m: { id: string }) => m.id)).toContain(memory.id);

    await db.agentSubscription.update({
      where: { userId_agentId: { userId: ownerId, agentId: publicAgentId } },
      data: { revokedAt: new Date() },
    });
    expect(await isAgentInstalledAndLicensed(db, app.id, publicAgentId)).toBe(false);
    expect((await getAppMemoryAccess(db, app.id)).has(memory.id)).toBe(false);
    expect((await list()).items.map((m: { id: string }) => m.id)).not.toContain(memory.id);
  });

  it('does not list the owner’s legacy holding to a pure personal App key', async () => {
    const holding = await db.memory.create({
      data: {
        id: generateId(), class: 'knowledge', name: 'Owner holding',
        urn: `@appowner:holding-${generateId()}`, ownerUserId: ownerId,
        visibility: 'PUBLIC', userMemoryOfAgentId: publicAgentId, createdBy: ownerId,
      },
    });
    await db.agentMemoryItem.create({ data: { agentId: publicAgentId, memoryId: holding.id, role: 'read' } });
    const app = await resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Holding App' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const page = await resolvers.Query.memories(
      null, { filter: { memoryClasses: ['knowledge'] } }, ctx({ appId: app.id }),
    );
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(holding.id);
    expect((await getAppMemoryAccess(db, app.id)).has(holding.id)).toBe(false);
  });

  it('rejects an empty-string orgId', async () => {
    await expect(
      resolvers.Mutation.createApp({}, { orgRef: '', agentRef: publicAgentId, name: 'X' }, ctx({ userId: ownerId })),
    ).rejects.toThrow(/non-empty organization/i);
  });

  it('requires an authenticated user', async () => {
    await expect(
      resolvers.Mutation.createApp({}, { agentRef: publicAgentId, name: 'X' }, ctx({})),
    ).rejects.toThrow(/authenticated/i);
  });

  it('rejects installing another tenant’s NON-public agent into a personal App', async () => {
    const privateOrg = await db.organization.create({ data: { id: generateId(), name: 'Priv', urn: `priv-${generateId()}` } });
    const privAgent = await db.agent.create({
      data: { id: generateId(), name: 'Private', urn: `${privateOrg.urn}:private-agent`, organizationId: privateOrg.id, visibility: 'ORGANIZATION' },
    });
    await expect(
      resolvers.Mutation.createApp({}, { agentRef: privAgent.id, name: 'Sneaky' }, ctx({ userId: ownerId, roles: ['READER'] })),
    // #1946: an Agent the caller can't read answers as absent.
    ).rejects.toThrow(/AGENT_NOT_FOUND/);
  });
});

describe('Query.apps — user-owned App listing', () => {
  it('the owner sees their user-owned App; another user + admin-unscoped do not', async () => {
    const app = await resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Mine' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const ownerList = await resolvers.Query.apps(null, {}, ctx({ userId: ownerId, roles: ['READER'] }));
    expect(ownerList.items.map((a: { id: string }) => a.id)).toContain(app.id);

    const otherList = await resolvers.Query.apps(null, {}, ctx({ userId: otherId, roles: ['READER'] }));
    expect(otherList.items.map((a: { id: string }) => a.id)).not.toContain(app.id);

    const adminList = await resolvers.Query.apps(null, {}, ctx({ userId: otherId, roles: ['ADMIN'] }));
    expect(adminList.items.map((a: { id: string }) => a.id)).not.toContain(app.id);
  });

  // #782 — the owner-only "My apps" slice: apps(filter: { ownedByMe: true })
  // returns ONLY the caller's own user-owned (org-less) Apps, for every caller
  // including a platform admin (no fetch-everything-then-filter, no admin
  // cross-tenant reach).
  it('Query.apps(ownedByMe): returns only the caller’s own org-less Apps, admin included', async () => {
    const mine = await resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Mine' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    // An org-owned App the admin would otherwise see in the unscoped list.
    const orgApp = await db.app.create({
      data: { id: generateId(), name: 'Org App', urn: `${pubOrgId}-app-${generateId()}`, organizationId: pubOrgId },
    });
    // Another user's user-owned App.
    const othersApp = await resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Others' }, ctx({ userId: otherId, roles: ['READER'] }),
    );

    // Owner: sees only their own.
    const ownerList = await resolvers.Query.apps(
      null, { filter: { ownedByMe: true } }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(ownerList.items.map((a: { id: string }) => a.id)).toEqual([mine.id]);
    expect(ownerList.total).toBe(1);

    // Platform admin: ownedByMe returns the admin's own org-less Apps only —
    // NOT the whole apps table.
    const adminList = await resolvers.Query.apps(
      null, { filter: { ownedByMe: true } }, ctx({ userId: otherId, roles: ['ADMIN'] }),
    );
    const adminIds = adminList.items.map((a: { id: string }) => a.id);
    expect(adminIds).toContain(othersApp.id); // the admin's OWN user-owned App
    expect(adminIds).not.toContain(mine.id); // not another user's
    expect(adminIds).not.toContain(orgApp.id); // not org-owned
  });

  it('Query.apps(ownedByMe): App-key caller (no user) gets an empty page', async () => {
    await resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Mine' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const res = await resolvers.Query.apps(
      null, { filter: { ownedByMe: true } }, ctx({ appId: 'some-app', roles: ['READER'] }),
    );
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });
});

describe('user-owned App is owner-only (blocker 3 — no platform-admin bypass)', () => {
  async function makeApp() {
    return resolvers.Mutation.createApp(
      {}, { agentRef: publicAgentId, name: 'Private App' }, ctx({ userId: ownerId, roles: ['READER'] }),
    );
  }

  it('appKeys / appAIConfig deny a non-owner platform admin', async () => {
    const app = await makeApp();
    const adminCtx = ctx({ userId: otherId, roles: ['ADMIN'] });
    await expect(resolvers.Query.appKeys(null, { appRef: app.id }, adminCtx)).rejects.toThrow('Forbidden');
    await expect(resolvers.Query.appAIConfig(null, { appRef: app.id }, adminCtx)).rejects.toThrow('Forbidden');
  });

  it('regenerateAppKey + ensureAppMember deny a non-owner platform admin', async () => {
    const app = await makeApp();
    const adminCtx = ctx({ userId: otherId, roles: ['ADMIN'] });
    await expect(resolvers.Mutation.regenerateAppKey(null, { appRef: app.id }, adminCtx)).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.ensureAppMember(null, { appId: app.id, userId: otherId, role: 'owner' }, adminCtx),
    ).rejects.toThrow('Forbidden');
  });

  it('the owner CAN read their App keys', async () => {
    const app = await makeApp();
    const keys = await resolvers.Query.appKeys(null, { appRef: app.id }, ctx({ userId: ownerId, roles: ['READER'] }));
    expect(Array.isArray(keys)).toBe(true);
  });
});

describe('getAppMemoryAccess — blocker 2 (foreign user-owned memory never folds)', () => {
  it('excludes a user-owned memory owned by someone other than the App owner', async () => {
    // Construct the leak scenario directly (the createApp/install gates prevent
    // it in normal flow, so wire raw rows): a user-owned App owned by `owner`
    // whose primary agent carries a memoryItem that is a user-owned memory owned
    // by `other`.
    const foreignMem = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'foreign', urn: `@appother:foreign-${generateId()}`, ownerUserId: otherId },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), name: 'UO Agent', urn: `@appowner:uo-agent-${generateId()}`, ownerUserId: ownerId,
        memoryItems: { create: [{ memoryId: foreignMem.id, role: 'read' }] } },
    });
    const app = await db.app.create({
      data: { id: generateId(), name: 'UO App', urn: `@appowner:uo-app-${generateId()}`, ownerUserId: ownerId,
        appAgents: { create: { agentId: agent.id } } },
    });
    const access = await getAppMemoryAccess(db, app.id);
    expect(access.has(foreignMem.id)).toBe(false);
  });

  it('includes a user-owned memory owned by the App owner', async () => {
    const ownMem = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'own', urn: `@appowner:own-${generateId()}`, ownerUserId: ownerId },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), name: 'UO Agent', urn: `@appowner:uo-agent-${generateId()}`, ownerUserId: ownerId,
        memoryItems: { create: [{ memoryId: ownMem.id, role: 'read' }] } },
    });
    const app = await db.app.create({
      data: { id: generateId(), name: 'UO App', urn: `@appowner:uo-app-${generateId()}`, ownerUserId: ownerId,
        appAgents: { create: { agentId: agent.id } } },
    });
    const access = await getAppMemoryAccess(db, app.id);
    expect(access.get(ownMem.id)).toBe('READ_ONLY');
  });

  /**
   * #758 — the GraphQL twin of the same blocker. The #676 fix landed only in
   * `getAppMemoryAccess` (MCP); the App-key branch of `Query.memories` folded
   * every `appAgents[].agent.memoryItems` row with no owner filter, so the same
   * foreign user-owned memory was listed to an App-key caller. The older
   * expectation that the App owner's row was listable by a pure App key was
   * also too broad: strict ownership requires a user principal, even when
   * the App and Memory share an owner.
   */
  it('Query.memories (App-key) excludes both foreign and owner-owned memories', async () => {
    const foreignMem = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'foreign', urn: `@appother:foreign-${generateId()}`, ownerUserId: otherId },
    });
    const ownMem = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'own', urn: `@appowner:own-${generateId()}`, ownerUserId: ownerId },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), name: 'UO Agent', urn: `@appowner:uo-agent-${generateId()}`, ownerUserId: ownerId,
        memoryItems: { create: [{ memoryId: foreignMem.id, role: 'read' }, { memoryId: ownMem.id, role: 'read' }] } },
    });
    const app = await db.app.create({
      data: { id: generateId(), name: 'UO App', urn: `@appowner:uo-app-${generateId()}`, ownerUserId: ownerId,
        appAgents: { create: { agentId: agent.id } } },
    });

    const page = await resolvers.Query.memories(
      null,
      { filter: { memoryClasses: ['knowledge'] } },
      ctx({ appId: app.id }),
    );
    const ids = page.items.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(foreignMem.id);
    expect(ids).not.toContain(ownMem.id);
  });

  it('Query.memories still lists an ORG-owned memory through an App member (no regression; a bare key does not, #1376)', async () => {
    const orgMem = await db.memory.create({
      data: { id: generateId(), class: 'knowledge', name: 'orgmem', urn: `${generateId()}:orgmem`, organizationId: pubOrgId },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), name: 'Org Agent', urn: `${generateId()}:org-agent`, organizationId: pubOrgId,
        memoryItems: { create: [{ memoryId: orgMem.id, role: 'read' }] } },
    });
    const app = await db.app.create({
      data: { id: generateId(), name: 'Org App', urn: `${generateId()}:org-app`, organizationId: pubOrgId,
        appAgents: { create: { agentId: agent.id } } },
    });
    // #1376: the fold over an org-owned memory is for a request with a user behind it (an App member);
    // a bare key no longer lists it.
    const member = await db.user.create({ data: { id: generateId(), handle: `uo-org-member-${generateId()}`, roles: ['READER'] } });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const bare = await resolvers.Query.memories(
      null,
      { filter: { memoryClasses: ['knowledge'] } },
      ctx({ appId: app.id }),
    );
    expect(bare.items.map((m: { id: string }) => m.id)).not.toContain(orgMem.id);
    const page = await resolvers.Query.memories(
      null,
      { filter: { memoryClasses: ['knowledge'] } },
      ctx({ appId: app.id, userId: member.id }),
    );
    expect(page.items.map((m: { id: string }) => m.id)).toContain(orgMem.id);
  });
});

describe('createApp — personal-App dependency rejection leaves no orphan (codex #685)', () => {
  it('rejects an agent with required deps BEFORE any write (no App, no subscription)', async () => {
    // Give the public agent a required import so the personal path must reject.
    const depAgent = await db.agent.create({
      data: { id: generateId(), name: 'Dep', urn: `dep-${generateId()}`, organizationId: pubOrgId, visibility: 'PUBLIC' },
    });
    await createDbAgentOrgGrant(db, pubOrgId, depAgent.id);
    await createDbAgentImport(db, publicAgentId, depAgent.id, { required: true, position: 0 });
    await expect(
      resolvers.Mutation.createApp({}, { agentRef: publicAgentId, name: 'Has Deps' }, ctx({ userId: ownerId, roles: ['READER'] })),
    ).rejects.toThrow(/required dependencies/i);
    // No orphan App and no subscription were written.
    expect(await db.app.count({ where: { ownerUserId: ownerId } })).toBe(0);
    expect(
      await db.agentSubscription.count({ where: { userId: ownerId, agentId: publicAgentId } }),
    ).toBe(0);
  });
});

describe('installAgentIntoApp — personal-App accessibility gate (#756)', () => {
  /** A personal App owned by `ownerId`, created via the licensed PUBLIC path. */
  async function seedPersonalApp() {
    return resolvers.Mutation.createApp(
      {},
      { agentRef: publicAgentId, name: 'My Gmail' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
  }

  it('rejects installing ANOTHER user’s personal agent — the null-org bypass', async () => {
    // The victim's user-owned agent: organizationId NULL, visibility PERSONAL.
    const victimAgent = await resolvers.Mutation.createAgent(
      {},
      { name: 'Victim Helper' },
      ctx({ userId: otherId, roles: ['READER'] }),
    );
    expect(victimAgent.organizationId).toBeNull();
    expect(victimAgent.visibility).toBe('PERSONAL');

    const app = await seedPersonalApp();
    // Pre-#756 this passed the guard (`null !== null` ⇒ false) and returned
    // the victim's agent with AGENT_INCLUDE — its whole definition.
    await expect(
      resolvers.Mutation.installAgentIntoApp(
        {},
        { appRef: app.id, agentRef: victimAgent.id },
        ctx({ userId: ownerId, roles: ['READER'] }),
      ),
    ).rejects.toThrow(/AGENT_NOT_FOUND/); // #1946: unreadable answers as absent

    // No link and no license were written.
    expect(await db.appAgent.count({ where: { appId: app.id, agentId: victimAgent.id } })).toBe(0);
    expect(await db.agentSubscription.count({ where: { agentId: victimAgent.id } })).toBe(0);
  });

  it('rejects another ORG’s non-PUBLIC agent into a personal App', async () => {
    const privOrg = await db.organization.create({
      data: { id: generateId(), name: 'Priv', urn: `priv-${generateId()}` },
    });
    const privAgent = await db.agent.create({
      data: { id: generateId(), name: 'Private', urn: `${privOrg.urn}:private-agent`, organizationId: privOrg.id, visibility: 'ORGANIZATION' },
    });
    const app = await seedPersonalApp();
    await expect(
      resolvers.Mutation.installAgentIntoApp(
        {},
        { appRef: app.id, agentRef: privAgent.id },
        ctx({ userId: ownerId, roles: ['READER'] }),
      ),
    ).rejects.toThrow(/AGENT_NOT_FOUND/); // #1946: unreadable answers as absent
  });

  it('allows the owner’s OWN personal agent, unlicensed (ownership licenses it)', async () => {
    const ownAgent = await resolvers.Mutation.createAgent(
      {},
      { name: 'My Own Helper' },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    const app = await seedPersonalApp();
    const res = await resolvers.Mutation.installAgentIntoApp(
      {},
      { appRef: app.id, agentRef: ownAgent.id },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    expect(res.appAgent.agentId).toBe(ownAgent.id);
    // Own agent ⇒ no subscription, and never an org grant (the App has no org).
    expect(
      await db.agentSubscription.count({ where: { userId: ownerId, agentId: ownAgent.id } }),
    ).toBe(0);
    expect(await db.agentOrgGrant.count({ where: { agentId: ownAgent.id } })).toBe(0);
  });

  it('licenses a PUBLIC agent installed through this path with an AgentSubscription', async () => {
    const otherPublic = await db.agent.create({
      data: { id: generateId(), name: 'Other Public', urn: `${generateId()}:other-public`, organizationId: pubOrgId, visibility: 'PUBLIC' },
    });
    const app = await seedPersonalApp();
    await resolvers.Mutation.installAgentIntoApp(
      {},
      { appRef: app.id, agentRef: otherPublic.id },
      ctx({ userId: ownerId, roles: ['READER'] }),
    );
    // #756: previously the install linked the agent but provisioned no license.
    const sub = await db.agentSubscription.findUnique({
      where: { userId_agentId: { userId: ownerId, agentId: otherPublic.id } },
    });
    expect(sub?.activatedAt).toBeTruthy();
    expect(sub?.revokedAt).toBeNull();
    // Still no AgentOrgGrant — a personal install is org-less.
    expect(await db.agentOrgGrant.count({ where: { agentId: otherPublic.id } })).toBe(0);
  });
});
