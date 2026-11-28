/**
 * #5321 (cor:acl:140:02 `memory.read`, its two forms (Holger, 2026-11-27 afternoon), cor:agt:010:01, cor:dmo:060:22, cor:acl:010:01 and :04): an App that acts
 * with no person behind it (a pure App key, a userless run) reads a memory outside its own ONLY through a grant. An attachment gives
 * no access. Every reach case runs through the MCP gate (`canReadMemory`) AND the GraphQL node set (`getAccessibleMemoryIds`).
 *
 * The grants are ACTIVE rows written around the signing ceremony (`insertGrantUnguarded`), so these pins judge the READ, not the
 * ceremony; the doors that create a pending grant of these actions are pinned in their own describe below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds } from './resolvers.helpers.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, raw, insertGrantUnguarded, type World } from '../../../lib/grants/grantFixtures3668.js';
import { APP_KEY_SCOPES } from '../../../lib/appKeyScopes/scopes.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let otherOrg: { id: string; urn: string };
let alice: string; // OWNER of her own organization's knowledge memory: its manager, the giver
let bob: string; // org reader and App member, manages nothing
let admin: string; // ADMIN of the org: manages its knowledge
let app: { id: string; urn: string };
let app2: { id: string; urn: string };
let keyId: string; // a key of `app`
let key2Id: string; // a key of `app2`

const asUser = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as Context);
const keyAuth = (appId: string, appKeyId: string): AuthContext => ({ appId, appKeyId, roles: [], clientId: `app:${appId}` } as AuthContext);
const runAuth = (appId: string): AuthContext => ({ appId, roles: [], clientId: 'run:r5321' } as AuthContext);

async function reachFor(auth: AuthContext, memoryId: string) {
  const mcp = await canReadMemory(db as never, auth, memoryId);
  const graphql = (await getAccessibleMemoryIds({ db, ...auth } as unknown as Context, memoryId)).includes(memoryId);
  return { mcp, graphql };
}
const NONE = { mcp: false, graphql: false };
const BOTH = { mcp: true, graphql: true };

/**
 * alice's knowledge memory: she manages it, and nobody else reads it. It lives in an organization alice alone belongs to (as
 * OWNER), not her user tenant: a user-owned memory is no grant target since #5345 (`memoryReadTargetRefusal`, `user-owned`).
 */
async function alicesMemory() {
  const own = await db.organization.create({ data: { id: generateId(), name: `alice-${generateId().slice(-8)}`, urn: `alice-${generateId().slice(-8)}` } });
  await db.orgMember.create({ data: { organizationId: own.id, userId: alice, role: 'OWNER' } });
  return db.memory.create({
    data: { id: generateId(), name: 'a', urn: `${own.urn}:kb`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: own.id } as never,
  });
}
async function orgKnowledge(orgId: string, orgUrn: string, extra: Record<string, unknown> = {}) {
  return db.memory.create({
    data: { id: generateId(), name: 'k', urn: `${orgUrn}:k-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId, ...extra } as never,
  });
}

/** The World shape the grant fixtures read: only the App and a user are used, since the holder is overridden. */
const world = (appId: string): World => ({ appId, userId: alice } as World);

/** An ACTIVE grant of `action` held by `appId`, given by `issuer`. */
async function activeGrant(appId: string, action: string, values: Record<string, unknown>, issuer: string | null = alice, over: Record<string, unknown> = {}) {
  return insertGrantUnguarded(world(appId), {
    user_id: null, grantee_app_id: appId, issuer_user_id: issuer, action, action_values: values,
    activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: issuer ?? 'gone', ...over,
  } as never);
}
async function grantScope(appKeyId: string, scope = 'grant:read') {
  await db.$executeRawUnsafe(
    `INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, $3, $4)`, generateId(), appKeyId, scope, admin);
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  org = (await createDbOrgAndGraph(db, { orgName: 'rg5321', graphName: 'base' })).org;
  otherOrg = (await createDbOrgAndGraph(db, { orgName: 'rg5321b', graphName: 'base' })).org;
  const person = async (h: string, roles: string[] = []) =>
    (await db.user.create({ data: { id: generateId(), handle: `${h}-${generateId().slice(-6)}`, roles } as never })).id;
  [alice, bob, admin] = [await person('alice'), await person('bob'), await person('admin')];
  await db.orgMember.create({ data: { organizationId: org.id, userId: alice, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: bob, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } as never });
  app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App2', urn: `${org.urn}:app2` } as never });
  for (const u of [alice, bob]) await db.appMember.create({ data: { appId: app.id, userId: u, role: 'member' } });
  keyId = (await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'k1' } })).id;
  key2Id = (await db.appKey.create({ data: { appId: app2.id, keyHash: generateId(), keyPreview: 'k2' } })).id;
});

describe('the action is seeded (cor:acl:140:02)', () => {
  // #5412 added the two optional parameters (`branch`, `automation`); `memory` stays the one required one and the one that takes a list.
  it('memory.read exists with one required wildcard-refusing parameter that takes a list, enforced by the server; there is no knowledge.read', async () => {
    const rows = await db.action.findMany({ where: { name: { in: ['memory.read', 'knowledge.read'] } }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => ({ name: r.name, enforcement: r.enforcement, tool: r.tool, parameters: r.parameters }))).toEqual([
      { name: 'memory.read', enforcement: 'SERVER', tool: null, parameters: [
        { name: 'memory', type: 'memory-ref', refusesWildcard: true },
        { name: 'branch', type: 'loc-prefix', refusesWildcard: true, optional: true },
        { name: 'automation', type: 'automation-ref', refusesWildcard: true, optional: true },
      ] },
    ]);
    expect(PLATFORM_ACTIONS.map((a) => a.name)).toContain('memory.read');
    expect(PLATFORM_ACTIONS.map((a) => a.name)).not.toContain('knowledge.read');
    expect(PLATFORM_ACTIONS.find((a) => a.name === 'memory.read')?.listParameters).toEqual(['memory']);
  });

  it('grant:read is a scope of the closed list', () => {
    expect(APP_KEY_SCOPES as readonly string[]).toContain('grant:read');
  });
});

describe('an attachment gives no access (cor:dmo:060:22; the #5258 interim ends)', () => {
  it('a pure key and a userless run get the missing-memory answer for an attached memory with no grant, on both surfaces', async () => {
    const m = await alicesMemory();
    await M.attachMemoryToApp(null, { memoryRef: m.id, appRef: app.id }, asUser(alice));
    expect(await db.appMemoryLink.count({ where: { memoryId: m.id } })).toBe(1); // the attachment stands: it is the App's scope list
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(NONE);
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(NONE);
  });

  it('hadron_get_node through the key does not read a node of an attached memory', async () => {
    const m = await alicesMemory();
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'note', name: 'N', content: 'attached-body-5321' } });
    await M.attachMemoryToApp(null, { memoryRef: m.id, appRef: app.id }, asUser(alice));
    const urn = `hrn:node:${m.urn}:note`;
    expect(await createTestableMcpServer(keyAuth(app.id, keyId)).callToolText('hadron_get_node', { urn })).not.toContain('attached-body-5321');
  });
});

describe('memory.read: the App reads through its grant', () => {
  it('a scoped pure key and a userless run read; an unscoped key does not', async () => {
    const m = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(NONE); // no scope: "only keys whose scopes say so"
    await grantScope(keyId);
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(BOTH);
  });

  it('the scope doors: the App\'s manager gives grant:read and the key reads; revoking it ends the read at the key\'s next call', async () => {
    const m = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(NONE);
    await M.grantAppKeyScope(null, { id: keyId, scope: 'grant:read' }, asUser(admin));
    expect(await db.appKeyScope.count({ where: { appKeyId: keyId, scope: 'grant:read', revokedAt: null, hostId: null } })).toBe(1);
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(BOTH);
    // A host id is not taken: grant:read is not bound to a host.
    await expect(M.grantAppKeyScope(null, { id: key2Id, scope: 'grant:read', hostId: 'orca1' }, asUser(admin))).rejects.toThrow(/grant:read is not granted for a host/);
    await M.revokeAppKeyScope(null, { id: keyId, scope: 'grant:read' }, asUser(admin));
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(NONE);
  });

  it('reads only: the key cannot write the granted memory', async () => {
    const m = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    await grantScope(keyId);
    const { canWriteToMemory } = await import('../../../mcp/access-control.js');
    expect(await canWriteToMemory(db as never, keyAuth(app.id, keyId), m.id)).toBe(false);
  });

  it('hadron_get_node through a scoped key reads a node of the granted memory', async () => {
    const m = await alicesMemory();
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'note', name: 'N', content: 'granted-body-5321' } });
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    await grantScope(keyId);
    const urn = `hrn:node:${m.urn}:note`;
    expect(await createTestableMcpServer(keyAuth(app.id, keyId)).callToolText('hadron_get_node', { urn })).toContain('granted-body-5321');
  });

  it('names one or more memories: a list opens each, and only those', async () => {
    const [a, b, c] = [await alicesMemory(), await alicesMemory(), await alicesMemory()];
    await activeGrant(app.id, 'memory.read', { memory: [a.id, b.id] });
    await grantScope(keyId);
    for (const x of [a, b]) {
      expect(await reachFor(runAuth(app.id), x.id)).toEqual(BOTH);
      expect(await reachFor(keyAuth(app.id, keyId), x.id)).toEqual(BOTH);
    }
    expect(await reachFor(runAuth(app.id), c.id)).toEqual(NONE);
  });

  it('a grant on one App never reaches another App\'s key or runs', async () => {
    const m = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    await grantScope(key2Id);
    expect(await reachFor(keyAuth(app2.id, key2Id), m.id)).toEqual(NONE);
    expect(await reachFor(runAuth(app2.id), m.id)).toEqual(NONE);
  });

  it('a person, with or without the App selected, an impersonation, a session-bound key and a run with a user gain nothing', async () => {
    const m = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    await grantScope(keyId);
    expect(await reachFor(keyAuth(app.id, keyId), m.id)).toEqual(BOTH); // the control
    const shapes: Array<[string, AuthContext]> = [
      ['bob, App selected', { userId: bob, appId: app.id, roles: [], clientId: `user:${bob}` } as AuthContext],
      ['bob, no selection', { userId: bob, roles: [], clientId: `user:${bob}` } as AuthContext],
      ['impersonation', { ...keyAuth(app.id, keyId), impersonation: { orgId: org.id } } as AuthContext],
      ['session-bound key', { ...keyAuth(app.id, keyId), sessionId: generateId() } as AuthContext],
      ['refused binding', { ...keyAuth(app.id, keyId), sessionBindingRefused: true } as AuthContext],
      ['run with a user id', { ...runAuth(app.id), userId: bob } as AuthContext],
    ];
    for (const [name, auth] of shapes) expect({ name, ...(await reachFor(auth, m.id)) }).toEqual({ name, ...NONE });
  });

  it('revoking ends the read at the next request; a pending, expired or departed grant allows nothing', async () => {
    const m = await alicesMemory();
    const g = await activeGrant(app.id, 'memory.read', { memory: m.id });
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
    await db.$executeRawUnsafe(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = $1 WHERE id = $2`, alice, g);
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(NONE);
    const m2 = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m2.id }, alice, { activated_at: null, verification_kind: null, verified_by: null });
    const m3 = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m3.id }, alice, { expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    const m4 = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m4.id }, alice, { holder_departed_at: raw(DB_NOW), holder_departure_reason: 'APP_DELETED' });
    for (const x of [m2, m3, m4]) expect(await reachFor(runAuth(app.id), x.id)).toEqual(NONE);
  });

  it('the App must be live: an uninstalled or deleted App, or a deleted organization, reads nothing through its grant', async () => {
    const m = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: m.id });
    await grantScope(keyId);
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
    for (const [model, id, data, undo] of [
      ['app', app.id, { uninstalledAt: new Date() }, { uninstalledAt: null }],
      ['app', app.id, { deletedAt: new Date() }, { deletedAt: null }],
      ['organization', org.id, { deletedAt: new Date() }, { deletedAt: null }],
    ] as const) {
      await (db as any)[model].update({ where: { id }, data });
      expect({ model, data, run: await reachFor(runAuth(app.id), m.id), key: await reachFor(keyAuth(app.id, keyId), m.id) })
        .toEqual({ model, data, run: NONE, key: NONE });
      await (db as any)[model].update({ where: { id }, data: undo });
    }
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
  });

  it('judged at every read: allows nothing while its giver cannot read the memory, and again once they can (R4)', async () => {
    // An org knowledge memory the giver reads as an org member; removing her membership takes her read away.
    const m = await orgKnowledge(org.id, org.urn);
    await activeGrant(app.id, 'memory.read', { memory: m.id }, admin);
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin }, data: { deletedAt: new Date() } });
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(NONE);
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin }, data: { deletedAt: null } });
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
  });

  it('an erased giver leaves the grant active (cor:acl:140:08)', async () => {
    const m = await orgKnowledge(org.id, org.urn);
    await activeGrant(app.id, 'memory.read', { memory: m.id }, null);
    expect(await reachFor(runAuth(app.id), m.id)).toEqual(BOTH);
  });

  it('never reaches a deleted, personal or private memory, even under an ACTIVE row', async () => {
    const gone = await alicesMemory();
    await activeGrant(app.id, 'memory.read', { memory: gone.id });
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const pers = await db.memory.create({ data: { id: generateId(), name: 'p', urn: `${org.urn}:p-${generateId().slice(-6)}`, class: 'personal', userId: alice, organizationId: org.id } as never });
    const priv = await db.memory.create({ data: { id: generateId(), name: 'q', urn: `${org.urn}:q-${generateId().slice(-6)}`, class: 'private', userId: alice, organizationId: org.id } as never });
    await activeGrant(app.id, 'memory.read', { memory: pers.id });
    await activeGrant(app.id, 'memory.read', { memory: priv.id });
    await grantScope(keyId);
    for (const x of [gone, pers, priv]) {
      expect(await reachFor(runAuth(app.id), x.id)).toEqual(NONE);
      expect(await reachFor(keyAuth(app.id, keyId), x.id)).toEqual(NONE);
    }
  });

  it('never reaches a user-owned knowledge memory (#5345), so no surface serves what memory(ref:) refuses', async () => {
    // alice's own (user-tenant) knowledge memory: she owns and reads it, and an ACTIVE grant she gave names it.
    const mine = await db.memory.create({
      data: { id: generateId(), name: 'u', urn: `alice-${generateId().slice(-8)}:uk`, class: 'knowledge', visibility: null, ownerUserId: alice } as never,
    });
    await activeGrant(app.id, 'memory.read', { memory: mine.id });
    await grantScope(keyId);
    for (const auth of [runAuth(app.id), keyAuth(app.id, keyId)]) {
      expect(await reachFor(auth, mine.id)).toEqual(NONE);
      const record = await (resolvers.Query as any).memory(null, { ref: mine.id }, { db, ...auth }).then((m: unknown) => m != null, () => false);
      expect(record).toBe(false);
    }
  });
});

describe('memory.read, the organization form: a userless run reads its organization\'s ORGANIZATION knowledge', () => {
  it('without the grant a run reads none of it; with it, read only, never a key', async () => {
    const k = await orgKnowledge(org.id, org.urn);
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(NONE);
    await activeGrant(app.id, 'memory.read', { memory: org.id }, admin);
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(BOTH);
    const { canWriteToMemory } = await import('../../../mcp/access-control.js');
    expect(await canWriteToMemory(db as never, runAuth(app.id), k.id)).toBe(false);
    await grantScope(keyId);
    expect(await reachFor(keyAuth(app.id, keyId), k.id)).toEqual(NONE); // cor:acl:010:04: a key never reads ORGANIZATION knowledge
    expect(await reachFor(runAuth(app2.id), k.id)).toEqual(NONE); // another App's runs
  });

  it('never another organization\'s knowledge, a group, personal or private memory, or an App-scoped one', async () => {
    await activeGrant(app.id, 'memory.read', { memory: org.id }, admin);
    const foreign = await orgKnowledge(otherOrg.id, otherOrg.urn);
    const group = await orgKnowledge(org.id, org.urn, { class: 'group', visibility: null });
    const pers = await db.memory.create({ data: { id: generateId(), name: 'p', urn: `${org.urn}:p-${generateId().slice(-6)}`, class: 'personal', userId: alice, organizationId: org.id } as never });
    const scoped = await orgKnowledge(org.id, org.urn, { appId: app2.id });
    for (const x of [foreign, group, pers, scoped]) expect(await reachFor(runAuth(app.id), x.id)).toEqual(NONE);
    // The control: the org's own ORGANIZATION knowledge.
    const k = await orgKnowledge(org.id, org.urn);
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(BOTH);
  });

  it('only ORGANIZATION knowledge: a PUBLIC knowledge memory of the organization is not opened by the organization form', async () => {
    await activeGrant(app.id, 'memory.read', { memory: org.id }, admin);
    const pub = await orgKnowledge(org.id, org.urn, { visibility: 'PUBLIC' });
    // A PUBLIC memory is read through its own visibility rule, so the surfaces cannot tell; the judge itself must not name it.
    const { appReadGrantReach } = await import('../../../lib/grants/readGrant.js');
    expect((await appReadGrantReach(db as never, app.id, { run: true, onlyMemoryIds: [pub.id] })).has(pub.id)).toBe(false);
  });

  it('the giver must still be a live member: a giver whose membership is removed opens nothing (an erased giver still counts)', async () => {
    const k = await orgKnowledge(org.id, org.urn);
    await activeGrant(app.id, 'memory.read', { memory: org.id }, admin);
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(BOTH);
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: admin } }, data: { deletedAt: new Date() } });
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(NONE);
    await db.user.update({ where: { id: admin }, data: { deletedAt: new Date() } });
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(BOTH); // cor:acl:140:08
  });

  it('a memory.read grant naming another organization opens nothing', async () => {
    const k = await orgKnowledge(otherOrg.id, otherOrg.urn);
    await activeGrant(app.id, 'memory.read', { memory: otherOrg.id }, admin);
    expect(await reachFor(runAuth(app.id), k.id)).toEqual(NONE);
  });
});
