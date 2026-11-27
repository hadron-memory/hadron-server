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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { getMemoryAccess, canReadMemory } from '../../../mcp/access-control.js';
import { linkedReachFor, judgeAppLinks } from '../../../lib/appMemoryLinks.js';
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
const keyCtx = (appId: string): Context => ({ db, ...keyAuth(appId) } as unknown as Context);
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
  it('the judge refuses it: linkedReachFor omits it and the link row sits inert (red on main)', async () => {
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await linkedReachFor(db as never, keyAuth(userApp.id))).toEqual(new Set());
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
    expect(await linkedReachFor(db as never, keyAuth(userApp.id))).toEqual(new Set());
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
    expect(await linkedReachFor(db as never, keyAuth(userApp.id))).toEqual(new Set());
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

  it('control: node reads through an owner-linked personal and an org-owned linked memory still work', async () => {
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
    expect((await Q.node({}, { ref: a.id }, keyCtx(userApp.id)))?.id).toBe(a.id);
    expect((await Q.node({}, { ref: b.id }, keyCtx(orgApp.id)))?.id).toBe(b.id);
  });

  it('control: a personal memory its owner linked still lists on BOTH surfaces and memory(ref:) answers it', async () => {
    const own = await db.memory.create({
      data: { id: generateId(), name: 'own', urn: `hrn-test-${generateId().slice(-8)}`, class: 'personal', userId: otto, ownerUserId: otto, organizationId: null, visibility: null } as never,
    });
    await attach(asUser(otto), own.id, userApp.id);
    expect(await listIds(keyCtx(userApp.id))).toEqual([own.id]);
    expect(await mcpIds(userApp.id)).toEqual([own.id]);
    expect(await recordRead(keyCtx(userApp.id), own.id)).toBe(true);
  });

  it('control: an org-owned linked memory still reaches the key on both surfaces (the narrowing is the owner axis only)', async () => {
    const ok = await db.memory.create({
      data: { id: generateId(), name: 'ok', urn: `${org.urn}:ok-${generateId().slice(-6)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never,
    });
    await attach(asUser(alice), ok.id, orgApp.id);
    expect(await listIds(keyCtx(orgApp.id))).toEqual([ok.id]);
    expect(await mcpIds(orgApp.id)).toEqual([ok.id]);
    expect(await recordRead(keyCtx(orgApp.id), ok.id)).toBe(true);
  });

  it('controls: a run principal, and a lapsed link', async () => {
    // A userless run of the App reads a linked org memory and refuses the user-owned one.
    const ok = await db.memory.create({
      data: { id: generateId(), name: 'ok2', urn: `${org.urn}:ok2-${generateId().slice(-6)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never,
    });
    await attach(asUser(alice), ok.id, orgApp.id);
    const uk = await userOwned('knowledge');
    await attach(asUser(otto), uk.id, userApp.id);
    expect(await canReadMemory(db as never, runAuth(orgApp.id), ok.id)).toBe(true);
    expect(await canReadMemory(db as never, runAuth(userApp.id), uk.id)).toBe(false);
    // A link that lapses (the attacher loses read) drops out of both surfaces at once, and returns with the read.
    expect(await mcpIds(orgApp.id)).toEqual([ok.id]);
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: alice }, data: { deletedAt: new Date() } });
    expect(await mcpIds(orgApp.id)).toEqual([]);
    expect(await listIds(keyCtx(orgApp.id))).toEqual([]);
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: alice }, data: { deletedAt: null } });
    expect(await mcpIds(orgApp.id)).toEqual([ok.id]);
  });
});
