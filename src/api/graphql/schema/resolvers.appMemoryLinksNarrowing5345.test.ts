/**
 * #5345: a user-owned non-personal memory (`ownerUserId` set, class not personal/private) linked to an App reaches NO surface
 * of its pure App key (cor:dmo:060:22 D-2026-11-26: attaching gives no access, the #5258/#5185 interim key read covering own
 * personal/private only; cor:api:120:03: a list equals the reads on every surface). On main the two non-personal class
 * families differed: for knowledge/group the record gate's ownerUserId branch has no link arm, so memory(ref:) and the
 * memories list refused while the ONE judge and MCP admitted (Babaya's #5343 measurement: judged=true, mcp=true,
 * record=false), and node reads (node(ref:), findNodes) admitted too, because they read the accessible set whose link arm
 * is the judge (Joran's LOCAL delta at bfc5ab7a). The judge, MCP and node-read pins are red on main and flip with the
 * narrowing; the record read stays green. For class app that branch fell through to the accessible set as well, so EVERY
 * surface admitted it (each assertion in that test is red on main on its own).
 * Every control here was green on main and must stay green.
 *
 * #5321 (merged in after #5345): a link gives NO read at all; an App reads outside its own memories only through a
 * `memory.read` grant (src/lib/grants/readGrant.ts). So `linkedReachFor` is gone (its assertions now read the MCP listing),
 * and the controls whose link alone reached the key are restated: a link alone reaches nothing, and an org-owned memory
 * reaches the key (with the `grant:read` scope) or a userless run through a grant. Each flipped expectation is marked
 * `#5321: was`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getMemoryAccess, canReadMemory } from '../../../mcp/access-control.js';
import { judgeAppLinks } from '../../../lib/appMemoryLinks.js';
import { DB_NOW, raw, insertGrantUnguarded, type World } from '../../../lib/grants/grantFixtures3668.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;

let org: { id: string; urn: string };
let alice: string; // org READER and App member: the usual attacher of org-owned memories
let otto: string; // owner of the user-owned App: the owner linking his own memories
let orgApp: { id: string }; // the org's App
let userApp: { id: string }; // otto's App

const asUser = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const keyAuth = (appId: string): AuthContext => ({ appId, roles: [], clientId: `app:${appId}` } as AuthContext);
const runAuth = (appId: string): AuthContext => ({ appId, roles: [], clientId: 'run:r1' } as AuthContext);
const keyCtx = (appId: string, auth: AuthContext = keyAuth(appId)): Context => ({ db, ...auth } as unknown as Context);
/** #5321: a pure key of `appId` holding the `grant:read` scope (what a `memory.read` grant needs to reach a key). */
async function scopedKey(appId: string): Promise<AuthContext> {
  const k = await db.appKey.create({ data: { appId, keyHash: generateId(), keyPreview: 'k' } });
  await db.$executeRawUnsafe(
    `INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, 'grant:read', $3)`, generateId(), k.id, otto);
  return { ...keyAuth(appId), appKeyId: k.id } as AuthContext;
}
/** #5321: an ACTIVE `memory.read` grant held by `appId`, given by `giver`, written around the ceremony (the read is what is pinned). */
const grantRead = (appId: string, memoryId: string, giver: string) => insertGrantUnguarded({ appId, userId: giver } as World, {
  user_id: null, grantee_app_id: appId, issuer_user_id: giver, action: 'memory.read', action_values: { memory: memoryId },
  activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: giver,
} as never);
const attach = (c: Context, memoryRef: string, appRef: string) =>
  (resolvers.Mutation as any).attachMemoryToApp(null, { memoryRef, appRef }, c);
const listIds = async (c: Context) =>
  ((await Q.memories(null, { limit: 100 }, c)).items as { id: string }[]).map((m) => m.id).sort();
const mcpIds = async (appId: string) => [...(await getMemoryAccess(db as never, keyAuth(appId))).keys()].sort();
const recordRead = async (c: Context, ref: string) =>
  Q.memory(null, { ref }, c).then((m: unknown) => m != null, () => false);

/** A user-owned memory of a non-personal class: the spec-047 tenant owner set, no org, no strict owner (class-independent axis). */
async function userOwned(klass: 'knowledge' | 'group' | 'app' = 'knowledge', extra: Record<string, unknown> = {}) {
  return db.memory.create({
    data: {
      id: generateId(), name: 'uk', urn: `hrn-test-${generateId().slice(-8)}`,
      class: klass, visibility: null, organizationId: null, ownerUserId: otto, ...extra,
    } as never,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  org = (await createDbOrgAndGraph(db, { orgName: 'narrow5345', graphName: 'base' })).org;
  const person = async (n: number, h: string) =>
    (await db.user.create({ data: { id: generateId(), githubId: 5_345_000 + n, githubUsername: h, handle: `${h}-${generateId().slice(-6)}` } })).id;
  [alice, otto] = [await person(1, 'alice'), await person(2, 'otto')];
  await db.orgMember.create({ data: { organizationId: org.id, userId: alice, role: 'READER' } });
  orgApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'OrgApp', urn: `${org.urn}:orgapp` } as never });
  await db.appMember.create({ data: { appId: orgApp.id, userId: alice, role: 'member' } });
  userApp = await db.app.create({ data: { id: generateId(), ownerUserId: otto, name: 'UserApp', urn: `otto-${generateId().slice(-6)}:userapp` } as never });
  await db.appMember.create({ data: { appId: userApp.id, userId: otto, role: 'owner' } });
});

describe('#5345 a user-owned non-personal linked memory reaches no surface of the App key', () => {
  it('the judge refuses it: the key lists nothing and the link row sits inert (red on main)', async () => {
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await mcpIds(userApp.id)).toEqual([]); // #5321: was linkedReachFor, removed with the link reach
    const judged = await judgeAppLinks(db as never, userApp.id, { onlyMemoryIds: [uk.id] });
    expect(judged).toHaveLength(1); // the row is there — the attach is still the consent step, it just grants the key nothing
    expect(judged[0]!.active).toBe(false);
  });

  it('MCP hadron_list_memories does not list it and canReadMemory refuses it (red on main)', async () => {
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await mcpIds(userApp.id)).toEqual([]);
    expect(await canReadMemory(db as never, keyAuth(userApp.id), uk.id)).toBe(false);
  });

  it('GraphQL memory(ref:) still refuses it, and the memories list excludes it (green on main, stay green)', async () => {
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await recordRead(keyCtx(userApp.id), uk.id)).toBe(false);
    expect(await listIds(keyCtx(userApp.id))).toEqual([]);
  });

  it('the same narrowing holds for a group-class user-owned memory (the judge keys on the owner axis, not the class)', async () => {
    const grp = await userOwned('group');
    await attach(asUser(otto), grp.id, userApp.id);
    expect(await mcpIds(userApp.id)).toEqual([]); // #5321: was linkedReachFor, removed with the link reach
  });

  it('an app-class user-owned memory loses every surface, node reads included (all red on main)', async () => {
    // Another user-owned App's own app-class memory, linked into this App by the owner. On main the record gate's ownerUserId
    // branch fell through to the accessible set for class 'app', and that set's link arm is the ONE judge — so the judge, MCP
    // and GraphQL (memory(ref:), the list, node reads) all admitted it. The narrowing refuses it at the judge, so every
    // surface refuses together (cor:api:120:03); this is the part of #5345 that is wider than "the read gate is unchanged".
    const otherApp = await db.app.create({ data: { id: generateId(), ownerUserId: otto, name: 'Other', urn: `otto-${generateId().slice(-6)}:other` } as never });
    const team = await userOwned('app', { appId: otherApp.id });
    const doc = await db.node.create({ data: { id: generateId(), memoryId: team.id, loc: 'teamdoc', name: 'T', content: 'app-class body' } });
    await attach(asUser(otto), team.id, userApp.id);
    expect(await mcpIds(userApp.id)).toEqual([]); // #5321: was linkedReachFor, removed with the link reach
    expect(await canReadMemory(db as never, keyAuth(userApp.id), team.id)).toBe(false);
    expect(await recordRead(keyCtx(userApp.id), team.id)).toBe(false);
    expect(await listIds(keyCtx(userApp.id))).toEqual([]);
    expect(await Q.node({}, { ref: doc.id }, keyCtx(userApp.id))).toBeNull();
  });

  it.each([
    ['knowledge', null],
    ['knowledge', 'ORGANIZATION'],
    ['group', null],
  ] as const)('a %s (visibility %s) user-owned memory loses node reads: node(ref:) and findNodes (red on main)', async (klass, visibility) => {
    // Joran's LOCAL delta at bfc5ab7a: on main, memory(ref:) and the memories list refused such a memory, but its NODES were
    // readable through node(ref:) and returned by findNodes once the owner linked it (both read the accessible set, whose link
    // arm is the judge). The narrowing removes them; before the link they were refused too.
    const mem = await userOwned(klass, { visibility });
    const token = `narrow5345${generateId().slice(-8)}`;
    const doc = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'doc', name: token, content: `${token} body` } });
    const hits = async (c: Context) =>
      ((await Q.findNodes(null, { query: token, mode: 'keyword' }, c)).hits as { node: { id: string } }[]).map((h) => h.node.id);
    expect(await Q.node({}, { ref: doc.id }, keyCtx(userApp.id))).toBeNull();
    await attach(asUser(otto), mem.id, userApp.id);
    expect(await Q.node({}, { ref: doc.id }, keyCtx(userApp.id))).toBeNull();
    expect(await hits(keyCtx(userApp.id))).toEqual([]);
    // Control on the same memory: its owner still reads the node and finds it.
    expect((await Q.node({}, { ref: doc.id }, asUser(otto)))?.id).toBe(doc.id);
    expect(await hits(asUser(otto))).toEqual([doc.id]);
  });

  it('control: node reads through an owner-linked personal and an org-owned linked memory (#5321: a link alone reads neither; a grant opens the org one)', async () => {
    const own = await db.memory.create({
      data: { id: generateId(), name: 'own', urn: `hrn-test-${generateId().slice(-8)}`, class: 'personal', userId: otto, ownerUserId: otto, organizationId: null, visibility: null } as never,
    });
    const ok = await db.memory.create({
      data: { id: generateId(), name: 'ok', urn: `${org.urn}:ok-${generateId().slice(-6)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never,
    });
    const a = await db.node.create({ data: { id: generateId(), memoryId: own.id, loc: 'doc', name: 'P', content: 'personal body' } });
    const b = await db.node.create({ data: { id: generateId(), memoryId: ok.id, loc: 'doc', name: 'O', content: 'org body' } });
    await attach(asUser(otto), own.id, userApp.id);
    await attach(asUser(alice), ok.id, orgApp.id);
    const key = await scopedKey(orgApp.id);
    expect(await Q.node({}, { ref: a.id }, keyCtx(userApp.id))).toBeNull(); // #5321: was a.id
    expect(await Q.node({}, { ref: b.id }, keyCtx(orgApp.id, key))).toBeNull(); // #5321: was b.id
    await grantRead(orgApp.id, ok.id, alice);
    expect((await Q.node({}, { ref: b.id }, keyCtx(orgApp.id, key)))?.id).toBe(b.id);
  });

  it('control: a personal memory its owner linked lists on neither surface and memory(ref:) refuses it (#5321)', async () => {
    const own = await db.memory.create({
      data: { id: generateId(), name: 'own', urn: `hrn-test-${generateId().slice(-8)}`, class: 'personal', userId: otto, ownerUserId: otto, organizationId: null, visibility: null } as never,
    });
    await attach(asUser(otto), own.id, userApp.id);
    expect(await listIds(keyCtx(userApp.id))).toEqual([]); // #5321: was [own.id]
    expect(await mcpIds(userApp.id)).toEqual([]); // #5321: was [own.id]
    expect(await recordRead(keyCtx(userApp.id), own.id)).toBe(false); // #5321: was true
  });

  it('control: an org-owned linked memory reaches the key on both surfaces through a grant, never through the link (#5321)', async () => {
    const ok = await db.memory.create({
      data: { id: generateId(), name: 'ok', urn: `${org.urn}:ok-${generateId().slice(-6)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never,
    });
    await attach(asUser(alice), ok.id, orgApp.id);
    const auth = await scopedKey(orgApp.id);
    const key = keyCtx(orgApp.id, auth);
    expect(await listIds(key)).toEqual([]); // #5321: was [ok.id]
    expect(await canReadMemory(db as never, auth, ok.id)).toBe(false); // #5321: was true
    expect(await recordRead(key, ok.id)).toBe(false); // #5321: was true
    await grantRead(orgApp.id, ok.id, alice);
    expect(await listIds(key)).toEqual([ok.id]);
    expect(await canReadMemory(db as never, auth, ok.id)).toBe(true);
    expect(await recordRead(key, ok.id)).toBe(true);
  });

  it('controls: a run principal, and a giver who loses read (#5321: was a lapsed link)', async () => {
    // A userless run of the App reads a linked org memory only through a grant, and never the user-owned one.
    const ok = await db.memory.create({
      data: { id: generateId(), name: 'ok2', urn: `${org.urn}:ok2-${generateId().slice(-6)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never,
    });
    await attach(asUser(alice), ok.id, orgApp.id);
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await canReadMemory(db as never, runAuth(orgApp.id), ok.id)).toBe(false); // #5321: was true through the link
    await grantRead(orgApp.id, ok.id, alice);
    expect(await canReadMemory(db as never, runAuth(orgApp.id), ok.id)).toBe(true);
    expect(await canReadMemory(db as never, runAuth(userApp.id), uk.id)).toBe(false);
    // The giver is judged at every read: alice loses read, the run loses it at once, and regains it with her read.
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: alice }, data: { deletedAt: new Date() } });
    expect(await canReadMemory(db as never, runAuth(orgApp.id), ok.id)).toBe(false);
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: alice }, data: { deletedAt: null } });
    expect(await canReadMemory(db as never, runAuth(orgApp.id), ok.id)).toBe(true);
  });
});

/**
 * #5375 item 2: the inert link is visible to its owner and fully reversible. The pins above assert the judge row only; these
 * pin what a person sees through App.attachedMemories (the link listed with active: false) and that detach drops it while
 * re-attach restores it, still inert. Item 3 is ruled "Keep silent" (cor:dmo:060:22, Decided 2026-11-27: attaching a memory
 * the App's key cannot reach succeeds, silently), so the attach itself is pinned to succeed and nothing refuses or warns.
 */
describe('#5375 the inert link is listed with active: false, and detach / re-attach round-trip it', () => {
  const M = resolvers.Mutation as any;
  const detach = (c: Context, memoryRef: string, appRef: string) => M.detachMemoryFromApp(null, { memoryRef, appRef }, c);
  type Entry = { memory: { id: string }; attachedById: string | null; active: boolean };
  const listed = async (appId: string, c: Context) =>
    ((await (resolvers as any).App.attachedMemories({ id: appId }, {}, c)) as Entry[])
      .map((e) => ({ memoryId: e.memory.id, attachedById: e.attachedById, active: e.active }))
      .sort((x, y) => x.memoryId.localeCompare(y.memoryId));
  const ownPersonal = () => db.memory.create({
    data: { id: generateId(), name: 'own', urn: `hrn-test-${generateId().slice(-8)}`, class: 'personal', userId: otto, ownerUserId: otto, organizationId: null, visibility: null } as never,
  });

  it.each(['knowledge', 'group', 'app'] as const)(
    'App.attachedMemories lists a linked user-owned %s memory with active: false, beside an active control', async (klass) => {
      const extra = klass === 'app'
        ? { appId: (await db.app.create({ data: { id: generateId(), ownerUserId: otto, name: 'Other', urn: `otto-${generateId().slice(-6)}:other` } as never })).id }
        : {};
      const inert = await userOwned(klass, extra);
      const own = await ownPersonal();
      // Keep silent (cor:dmo:060:22): the attach of a memory the key can never reach succeeds and returns the memory.
      expect((await attach(asUser(otto), inert.id, userApp.id)).id).toBe(inert.id);
      await attach(asUser(otto), own.id, userApp.id);
      expect(await listed(userApp.id, asUser(otto))).toEqual(
        [
          { memoryId: inert.id, attachedById: otto, active: false },
          { memoryId: own.id, attachedById: otto, active: true },
        ].sort((x, y) => x.memoryId.localeCompare(y.memoryId)),
      );
      // #5321: `active` says whether the link would count, not that it reads. A link gives the key nothing on its own, and a
      // personal memory is never a memory.read target, so the key reaches neither entry.
      expect(await mcpIds(userApp.id)).toEqual([]);
    },
  );

  it('detach drops the inert link from the listing and the judge; re-attach restores it, still inert', async () => {
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await listed(userApp.id, asUser(otto))).toEqual([{ memoryId: uk.id, attachedById: otto, active: false }]);

    expect(await detach(asUser(otto), uk.id, userApp.id)).toBe(true);
    expect(await listed(userApp.id, asUser(otto))).toEqual([]);
    expect(await judgeAppLinks(db as never, userApp.id, { onlyMemoryIds: [uk.id] })).toEqual([]);
    expect(await db.appMemoryLink.count({ where: { appId: userApp.id, memoryId: uk.id } })).toBe(0);

    expect((await attach(asUser(otto), uk.id, userApp.id)).id).toBe(uk.id);
    expect(await listed(userApp.id, asUser(otto))).toEqual([{ memoryId: uk.id, attachedById: otto, active: false }]);
    const judged = await judgeAppLinks(db as never, userApp.id, { onlyMemoryIds: [uk.id] });
    expect(judged.map((j) => [j.memoryId, j.active])).toEqual([[uk.id, false]]);
    // Re-attaching grants the key nothing: still no reach on any surface.
    // #5321: was linkedReachFor, removed with the link reach; the MCP listing and the record read below carry it.
    expect(await mcpIds(userApp.id)).toEqual([]);
    expect(await recordRead(keyCtx(userApp.id), uk.id)).toBe(false);
  });
});
