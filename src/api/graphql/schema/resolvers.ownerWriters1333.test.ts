/**
 * #1333 — `NodeRoleRule.writers = OWNER` (cor:acl:010:03), built on the #1331 authorization layer.
 *
 * OWNER audience for a memory owned by org X: the owning-party people (contributors and above in X, platform admins,
 * through the ONE shared predicate `requireMemoryManageAccess`) plus an App PUBLISHED by X: an active App
 * (`uninstalledAt IS NULL`) with an `AppAgent` row whose Agent is not deleted and has `organizationId = X` (Vera's
 * ruling A, Holger via Fiona 2026-10-27; no schema change). A user-owned memory: `Agent.ownerUserId` = the owning
 * user. Evaluated at write time on live rows. A headless run is the App service identity (D23): the triggering user's
 * own standing never counts, only the App's. OWNER is never read as ALL. Memory write access stays necessary.
 *
 * The recorded consequence (issue body, Vera's items 3-4): a non-member who can drive an owning-org-published App
 * writes at owner level through it. Interactive human-through-App identity is out of scope: a principal with a
 * userId and no run client keeps the person's own standing (established behavior), never the App's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { roleWritersRefusal } from '../../../lib/nodeRoleWriters.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const UNSUPPORTED = 'ROLE_WRITERS_UNSUPPORTED';
const REFUSED = 'ROLE_WRITER_LEVEL_REQUIRED';

let n: number;
let org: { id: string; urn: string };
let vendorOrg: { id: string; urn: string };
let memoryId: string;
const user: Record<string, string> = {};

const as = (who: string, roles: Context['roles'] = []): Context => ({ db, userId: user[who], roles, clientId: `user:${user[who]}` });
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
}
async function rule(mem: string, role: string, writers: 'ALL' | 'ADMIN' | 'OWNER') {
  const config = (await db.memoryConfig.findUnique({ where: { memoryId: mem } }))
    ?? await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem } });
  return db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, writers } });
}
const create = (ctx: Context, loc: string, mem = memoryId) =>
  resolvers.Mutation.createNode(null, { input: { memoryId: mem, loc, name: loc, content: 'x', role: 'vault' } }, ctx);
const exists = async (loc: string, mem = memoryId) => (await db.node.count({ where: { memoryId: mem, loc } })) > 0;

async function agent(orgId: string | null, ownerUserId: string | null, extra: Record<string, unknown> = {}) {
  const id = generateId();
  return (await db.agent.create({
    data: { id, name: `a-${id}`, urn: `ag-${id}`.toLowerCase(), organizationId: orgId, ownerUserId, ...extra },
  })).id;
}
async function app(opts: { orgId?: string | null; ownerUserId?: string | null; agents?: string[]; uninstalled?: boolean }) {
  const id = generateId();
  await db.app.create({
    data: {
      id, name: `app-${id}`, urn: `app-${id}`.toLowerCase(),
      organizationId: opts.orgId ?? null, ownerUserId: opts.ownerUserId ?? null,
      uninstalledAt: opts.uninstalled ? new Date() : null,
    },
  });
  for (const agentId of opts.agents ?? []) await db.appAgent.create({ data: { appId: id, agentId } });
  return id;
}
const principalOf = (appId: string, extra: Record<string, unknown> = {}) =>
  ({ ...runAuthContext({ id: generateId(), appId, userId: null, organizationId: org.id }), ...extra }) as never;
const refusal = async (p: never, mem = memoryId) =>
  (await roleWritersRefusal(db, p, mem, { priorRole: null, nextRole: 'vault' }))?.extensions.code ?? null;

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Owner', urn: `own1333-${n}` }, select: { id: true, urn: true } });
  vendorOrg = await db.organization.create({ data: { name: 'Vendor', urn: `vend1333-${n}` }, select: { id: true, urn: true } });
  for (const who of ['owner', 'admin', 'contrib', 'reader', 'outsider', 'platform', 'grantee']) {
    user[who] = (await db.user.create({
      data: { handle: `o1333-${who}-${n}`, roles: who === 'platform' ? ['ADMIN'] : ['READER'] },
    })).id;
  }
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: user.owner!, role: 'OWNER' },
    { organizationId: org.id, userId: user.admin!, role: 'ADMIN' },
    { organizationId: org.id, userId: user.contrib!, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: user.reader!, role: 'READER' },
  ] });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  })).id;
  await rule(memoryId, 'vault', 'OWNER');
});

describe('people: the owning party writes, OWNER is never read as ALL', () => {
  it('org OWNER, ADMIN, CONTRIBUTOR and a platform admin write; a reader, an outsider and a share grantee do not', async () => {
    expect(await code(create(as('owner'), 'v1'))).toBe('OK');
    expect(await code(create(as('admin'), 'v2'))).toBe('OK');
    expect(await code(create(as('contrib'), 'v3'))).toBe('OK');
    expect(await code(create(as('platform', ['ADMIN']), 'v4'))).toBe('OK');
    await db.memoryShare.create({ data: { memoryId, granteeId: user.grantee!, grantorId: user.owner!, role: 'writer' as never } });
    for (const who of ['reader', 'outsider', 'grantee']) {
      const c = await code(create(as(who), `x-${who}`));
      expect(c, who).not.toBe('OK');
      expect(await exists(`x-${who}`)).toBe(false);
    }
  });

  it('a revoked (soft-deleted) membership does not qualify', async () => {
    expect(await code(create(as('contrib'), 'live'))).toBe('OK');
    await db.orgMember.updateMany({ where: { userId: user.contrib! }, data: { deletedAt: new Date() } });
    expect(await code(create(as('contrib'), 'gone'))).not.toBe('OK');
    expect(await exists('gone')).toBe(false);
  });

  it('the level check itself refuses a principal outside the audience with the writer-level code, not UNSUPPORTED', async () => {
    const p = { userId: user.reader!, roles: [] as never, clientId: 'x' } as never;
    expect(await refusal(p)).toBe(REFUSED);
  });
});

describe('Apps: published by the owning org vs merely installed', () => {
  it('publisher: an active App holding an agent of the owning org qualifies; the run writes through the real door', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: vendorOrg.id, agents: [own] });
    expect(await refusal(principalOf(a))).toBeNull();
  });

  it('installer: an App the owner owns but that only carries a vendor agent does not qualify', async () => {
    const vendor = await agent(vendorOrg.id, null);
    const a = await app({ orgId: org.id, agents: [vendor] });
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  });

  it('multi-agent mix: one owning-org agent among vendor agents qualifies (accepted consequence)', async () => {
    const a = await app({ orgId: vendorOrg.id, agents: [await agent(vendorOrg.id, null), await agent(org.id, null)] });
    expect(await refusal(principalOf(a))).toBeNull();
  });

  it('an App with no agents does not qualify', async () => {
    expect(await refusal(principalOf(await app({ orgId: org.id })))).toBe(REFUSED);
  });

  it('an uninstalled App never qualifies, at write time on live rows', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const p = principalOf(a);
    expect(await refusal(p)).toBeNull();
    await db.app.update({ where: { id: a }, data: { uninstalledAt: new Date() } });
    expect(await refusal(p)).toBe(REFUSED);
  });

  it('a deleted Agent does not count, taking effect on the next write', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: org.id, agents: [own] });
    const p = principalOf(a);
    expect(await refusal(p)).toBeNull();
    await db.agent.update({ where: { id: own }, data: { deletedAt: new Date() } });
    expect(await refusal(p)).toBe(REFUSED);
  });

  it('an unknown appId never qualifies', async () => {
    expect(await refusal(principalOf(generateId()))).toBe(REFUSED);
  });
});

describe('headless identity (D23): the App service identity, not the triggering user', () => {
  it('an external, non-member driver through an owning-org-published App writes at owner level (recorded consequence)', async () => {
    const a = await app({ orgId: vendorOrg.id, agents: [await agent(org.id, null)] });
    const p = principalOf(a, { userId: user.outsider! });
    expect(await refusal(p)).toBeNull();
  });

  it('an org OWNER triggering a run of an App that only carries a vendor agent does NOT write at owner level', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    const p = principalOf(a, { userId: user.owner! });
    expect(await refusal(p)).toBe(REFUSED);
  });

  it('a pure App key (no user, no run client) is judged as its App', async () => {
    const own = await agent(org.id, null);
    const yes = await app({ orgId: org.id, agents: [own] });
    const no = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    expect(await refusal({ appId: yes, roles: [], clientId: 'app:k' } as never)).toBeNull();
    expect(await refusal({ appId: no, roles: [], clientId: 'app:k' } as never)).toBe(REFUSED);
  });

  it('interactive person-through-App (userId, no run client) keeps the person\'s own standing, never the App\'s', async () => {
    const publisher = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const vendorApp = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    // A non-member through the owning org's own App: the App does not lift the person.
    expect(await refusal({ userId: user.outsider!, appId: publisher, roles: [], clientId: `user:${user.outsider}` } as never)).toBe(REFUSED);
    // A contributor through a vendor-only App keeps the contributor's own standing.
    expect(await refusal({ userId: user.contrib!, appId: vendorApp, roles: [], clientId: `user:${user.contrib}` } as never)).toBeNull();
  });
});

describe('user-owned memory: Agent.ownerUserId is the owning user', () => {
  let ownedMemory: string;
  beforeEach(async () => {
    ownedMemory = (await db.memory.create({
      data: { id: generateId(), ownerUserId: user.contrib!, urn: `o1333-${n}:mem`, name: 'own', class: 'knowledge' },
    })).id;
    await rule(ownedMemory, 'vault', 'OWNER');
  });

  it('an App with the owning user\'s agent qualifies; an org agent or another user\'s agent does not', async () => {
    const mine = await app({ ownerUserId: user.contrib!, agents: [await agent(null, user.contrib!)] });
    const orgs = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const others = await app({ ownerUserId: user.outsider!, agents: [await agent(null, user.outsider!)] });
    expect(await refusal(principalOf(mine), ownedMemory)).toBeNull();
    expect(await refusal(principalOf(orgs), ownedMemory)).toBe(REFUSED);
    expect(await refusal(principalOf(others), ownedMemory)).toBe(REFUSED);
  });

  it('the owning user writes; another user does not', async () => {
    expect(await code(create(as('contrib'), 'u1', ownedMemory))).toBe('OK');
    expect(await code(create(as('outsider'), 'u2', ownedMemory))).not.toBe('OK');
    expect(await exists('u2', ownedMemory)).toBe(false);
  });
});

describe('the old fail-closed refusal is gone for OWNER, kept for an unknown level', () => {
  it('an OWNER rule no longer answers ROLE_WRITERS_UNSUPPORTED', async () => {
    expect(await code(create(as('contrib'), 'v9'))).not.toBe(UNSUPPORTED);
  });
});

describe('the write doors: generic GraphQL, MCP and the run tool path share the one check', () => {
  /**
   * The driver is a platform admin, so memory write access (necessary, never widened) is not what decides: the run
   * is judged as its App and the driver's own standing must not lift a vendor-only App (D23).
   */
  const appWithWriteAccess = (agentOrgId: string, appOrgId: string) => app({ orgId: appOrgId, agents: [] }).then(async (a) => {
    await db.appAgent.create({ data: { appId: a, agentId: await agent(agentOrgId, null) } });
    return a;
  });
  const driver = (a: string) => principalOf(a, { userId: user.platform!, roles: ['ADMIN'], db }) as Context;
  const mcpCreate = (p: Record<string, unknown>, loc: string) =>
    createTestableMcpServer(p as never).callToolText('hadron_create_node', {
      urn: `hrn:node:${org.urn}:mem:${loc}`, name: loc, content: 'x', role: 'vault',
    });

  it('GraphQL createNode: a headless run of the publisher App writes, a run of an installed vendor App is refused', async () => {
    const pub = await appWithWriteAccess(org.id, vendorOrg.id);
    const ven = await appWithWriteAccess(vendorOrg.id, org.id);
    expect(await code(create(driver(pub), 'run-ok'))).toBe('OK');
    expect(await code(create(driver(ven), 'run-no'))).toBe(REFUSED);
    expect(await exists('run-ok')).toBe(true);
    expect(await exists('run-no')).toBe(false);
  });

  it('MCP hadron_create_node: the same split, and the refusal is the typed writer-level text', async () => {
    const pub = await appWithWriteAccess(org.id, vendorOrg.id);
    const ven = await appWithWriteAccess(vendorOrg.id, org.id);
    expect(await mcpCreate(driver(ven) as never, 'm-no')).toContain('[role_writer_level_required]');
    expect(await exists('m-no')).toBe(false);
    expect(await mcpCreate(driver(pub) as never, 'm-ok')).not.toContain('role_writer');
    expect(await exists('m-ok')).toBe(true);
  });

  it('MCP, a person: a contributor writes and a reader is refused (OWNER is not ALL)', async () => {
    const mcpAs = (who: string) => createTestableMcpServer({ userId: user[who]!, roles: [] as never, clientId: `user:${user[who]}` });
    expect(await mcpAs('contrib').callToolText('hadron_create_node', { urn: `hrn:node:${org.urn}:mem:mc`, name: 'mc', content: 'x', role: 'vault' }))
      .not.toContain('role_writer');
    expect(await mcpAs('reader').callToolText('hadron_create_node', { urn: `hrn:node:${org.urn}:mem:mr`, name: 'mr', content: 'x', role: 'vault' }))
      .not.toContain('role_writers_unsupported');
    expect(await exists('mr')).toBe(false);
  });
});
