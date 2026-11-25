/**
 * #5015 (Billing A7b): every write that adds a live node to an owner refuses at the owner's `nodes` limit, or counts and is
 * never refused (cor:acl:150:03-:05, Proposed). One case per acceptance line of the issue; the doors are called the way a
 * client calls them (the GraphQL executor where the error's wire form matters, the resolver otherwise).
 *
 * RED on main: every case named "refuses" wrote the node (no door called `requireOwnerHeadroom`). The cases named
 * "succeeds at the cap" pass on main by design and guard against over-refusal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS } from '../../../lib/ownerLimits/keys.js';
import { requireNodeHeadroom } from '../../../lib/ownerLimits/nodes.js';
import type { OwnerRef } from '../../../lib/owner.js';
import { formatGraphQLError } from '../formatError.js';
import { mergeMemoryGraph } from '../../../controller/operations/mergeMemories.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());
interface Result { data?: Record<string, any> | null; errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }> }
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>): Promise<Result> {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult as Result;
}
const CREATE = `mutation($input: CreateNodeInput!) { createNode(input: $input) { id loc } }`;
const UPDATE = `mutation($input: UpdateNodeInput!) { updateNode(input: $input) { id } }`;
const DELETE = `mutation($ref: ID!) { deleteNode(nodeRef: $ref) }`;
const RESTORE = `mutation($ref: ID!) { restoreNode(nodeRef: $ref) { id } }`;
const MOVE = `mutation($src: ID!, $to: ID!) { moveNode(sourceRef: $src, targetMemoryRef: $to) { id } }`;
const CLONE = `mutation($src: ID!, $to: ID!) { cloneNode(sourceRef: $src, targetMemoryRef: $to) { id } }`;
const MERGE = `mutation($input: MergeMemoriesInput!) { mergeMemories(input: $input) { id } }`;
const CLONE_MEMORY = `mutation($ref: ID!, $urn: String!) { cloneMemory(ref: $ref, targetUrn: $urn) { id } }`;
const EXTRACT = `mutation($ref: ID!, $urn: String!, $move: Boolean) { extractParentNodeToMemory(parentRef: $ref, targetUrn: $urn, move: $move) { id } }`;

const M = resolvers.Mutation as any;
const ctxOf = (userId: string): Partial<Context> => ({ userId, roles: ['READER'] as never });
const err = (r: Result) => r.errors?.[0];
const code = (r: Result) => err(r)?.extensions?.code ?? null;
const defaults = (value: unknown) => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify(value) });
const liveCount = (owner: OwnerRef) => OWNER_LIMIT_KEYS.nodes.count(db, owner);
/** Put an owner exactly at its `nodes` limit with an owner_limits row. */
async function capAtCurrent(owner: OwnerRef) {
  const limitValue = await liveCount(owner);
  await db.ownerLimit.create({
    data: { id: generateId(), ...('userId' in owner ? { ownerUserId: owner.userId } : { organizationId: owner.organizationId }),
      key: 'nodes', limitValue, sourceType: 'manual', sourceId: 't', note: 't' },
  });
  return limitValue;
}
/** Cap an owner with room for exactly `room` more nodes. */
async function capWithRoom(owner: OwnerRef, room: bigint) {
  const limitValue = (await capAtCurrent(owner)) + room;
  await db.ownerLimit.updateMany({
    where: { ...('userId' in owner ? { ownerUserId: owner.userId } : { organizationId: owner.organizationId }), key: 'nodes' }, data: { limitValue },
  });
}
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...extra } });

let u: string, w: string, orgAdmin: string, contributor: string, orgId: string, orgUrn: string;
let mU1: string, mU2: string, mO: string;
const asU = () => ctxOf(u);

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  const mk = async (handle: string) => (await db.user.create({ data: { id: generateId(), handle, email: `${handle}@example.test`, roles: ['READER'] } })).id;
  [u, w, orgAdmin, contributor] = await Promise.all(['nd5015-u', 'nd5015-w', 'nd5015-oa', 'nd5015-c'].map(mk));
  orgUrn = 'nd5015-org';
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'nd5015', urn: orgUrn } })).id;
  for (const [userId, role] of [[u, 'OWNER'], [orgAdmin, 'ADMIN'], [contributor, 'CONTRIBUTOR']] as const) {
    await db.orgMember.create({ data: { organizationId: orgId, userId, role } });
  }
  const personal = (name: string, owner: string) => db.memory.create({
    data: { id: generateId(), name, urn: `nd5015-${name}:private`, class: 'private', userId: owner, ownerUserId: owner, vectorIndexEnabled: false },
  });
  mU1 = (await personal('u1', u)).id;
  mU2 = (await personal('u2', u)).id;
  await personal('w1', w);
  mO = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: `${orgUrn}:o`, class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  await node(mU1, 'a');
  await node(mU1, 'b');
});
afterEach(() => { vi.restoreAllMocks(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5015 createNode at the owner\'s nodes limit', () => {
  it('refuses a third node for a person at a default of 2, in the limited person\'s form, and writes nothing', async () => {
    defaults({ user: { nodes: 2 } });
    const r = await gql(CREATE, asU(), { input: { memoryId: mU1, loc: 'c', name: 'c' } });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(err(r)!.extensions).toMatchObject({ limitKey: 'nodes', ownerType: 'user', callerCanManageOwner: true, ownerId: u, limit: '2' });
    expect(await db.node.count({ where: { memoryId: mU1, loc: 'c' } })).toBe(0);
  });

  it('refuses a create at the loc of a tombstone (the revive branch) and leaves the tombstone deleted', async () => {
    const t = await node(mU1, 't', { deletedAt: new Date() });
    defaults({ user: { nodes: 2 } });
    const r = await gql(CREATE, asU(), { input: { memoryId: mU1, loc: 't', name: 't again' } });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).not.toBeNull();
  });

  it('succeeds at the cap: an update of an existing node', async () => {
    defaults({ user: { nodes: 2 } });
    const a = await db.node.findFirstOrThrow({ where: { memoryId: mU1, loc: 'a' } });
    const r = await gql(UPDATE, asU(), { input: { memoryId: mU1, loc: 'a', description: 'edited' } });
    expect(r.errors).toBeUndefined();
    expect((await db.node.findUniqueOrThrow({ where: { id: a.id } })).description).toBe('edited');
  });

  it('deleting one node lets the next creation through at once', async () => {
    defaults({ user: { nodes: 2 } });
    const a = await db.node.findFirstOrThrow({ where: { memoryId: mU1, loc: 'a' } });
    expect((await gql(DELETE, asU(), { ref: a.id })).errors).toBeUndefined();
    const r = await gql(CREATE, asU(), { input: { memoryId: mU1, loc: 'c', name: 'c' } });
    expect(r.errors).toBeUndefined();
  });

  it('with OWNER_DEFAULT_LIMITS unset, a create is not limited', async () => {
    const r = await gql(CREATE, asU(), { input: { memoryId: mU1, loc: 'c', name: 'c' } });
    expect(r.errors).toBeUndefined();
  });

  it('an organization: its ADMIN gets the managing form, a CONTRIBUTOR the form with no owner and no number', async () => {
    await node(mO, 'x');
    defaults({ organization: { nodes: 1 } });
    const admin = await gql(CREATE, ctxOf(orgAdmin), { input: { memoryId: mO, loc: 'y', name: 'y' } });
    expect(code(admin)).toBe('OWNER_LIMIT_REACHED');
    expect(err(admin)!.extensions).toMatchObject({ ownerType: 'organization', callerCanManageOwner: true, ownerId: orgId, limit: '1' });
    const contrib = await gql(CREATE, ctxOf(contributor), { input: { memoryId: mO, loc: 'y', name: 'y' } });
    expect(code(contrib)).toBe('OWNER_LIMIT_REACHED');
    expect(err(contrib)!.extensions).toMatchObject({ ownerType: 'organization', callerCanManageOwner: false });
    expect(err(contrib)!.extensions).not.toHaveProperty('ownerId');
    expect(err(contrib)!.extensions).not.toHaveProperty('limit');
    expect(err(contrib)!.message).not.toMatch(/\d/);
    expect(await db.node.count({ where: { memoryId: mO, loc: 'y' } })).toBe(0);
  });
});

describe('#5015 the refusal under impersonation', () => {
  it('names no owner and no number when a platform admin acts as the organization\'s OWNER (A7a: the caller is null)', async () => {
    // An impersonation session is organization-scoped (a private memory is hidden under it), so the limited owner is the
    // organization, and the acted-as person is its OWNER: without impersonation the same create gets the managing form.
    await node(mO, 'x');
    defaults({ organization: { nodes: 1 } });
    const plain = await gql(CREATE, asU(), { input: { memoryId: mO, loc: 'y', name: 'y' } });
    expect(err(plain)?.extensions).toMatchObject({ code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: true, ownerId: orgId });
    const imp = { sessionId: generateId(), actorUserId: w, orgId, expiresAt: new Date(Date.now() + 3_600_000) };
    const r = await gql(CREATE, { ...asU(), impersonation: imp } as Partial<Context>, { input: { memoryId: mO, loc: 'y', name: 'y' } });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(err(r)?.extensions).toMatchObject({ callerCanManageOwner: false });
    expect(err(r)?.extensions).not.toHaveProperty('ownerId');
    expect(err(r)?.extensions).not.toHaveProperty('limit');
    expect(await db.node.count({ where: { memoryId: mO, loc: 'y' } })).toBe(0);
  });
});

describe('#5015 restoreNode', () => {
  it('refuses to restore a deleted node at the cap', async () => {
    const t = await node(mU1, 't', { deletedAt: new Date() });
    defaults({ user: { nodes: 2 } });
    const r = await gql(RESTORE, asU(), { ref: t.id });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).deletedAt).not.toBeNull();
  });
});

describe('#5015 moveNode and cloneNode', () => {
  it('refuses a move from another owner\'s memory into the limited owner\'s', async () => {
    const x = await node(mO, 'x');
    defaults({ user: { nodes: 2 } });
    const r = await gql(MOVE, asU(), { src: x.id, to: mU1 });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).memoryId).toBe(mO);
  });

  it('refuses a subtree move whose nodes exceed the headroom, counting every node of the subtree', async () => {
    const x = await node(mO, 'x');
    await node(mO, 'x:child');
    await db.ownerLimit.create({ data: { id: generateId(), ownerUserId: u, key: 'nodes', limitValue: 3n, sourceType: 'manual', sourceId: 't', note: 't' } });
    const r = await gql(MOVE, asU(), { src: x.id, to: mU1 });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: mO, deletedAt: null } })).toBe(2);
  });

  it('refuses a subtree move whose nodes fit the headroom but whose carried comment thread does not', async () => {
    const x = await node(mO, 'x');
    await node(mO, 'x:child');
    await M.createComment({}, { targetRef: x.id, body: 'a thread carried with the move' }, { db, userId: u, roles: ['READER'] } as Context);
    // The destination must hold comments (a private memory refuses the move with COMMENT_MOVE_UNCOMMENTABLE first):
    // a free-standing knowledge memory the person owns.
    const mK = (await db.memory.create({
      data: { id: generateId(), name: 'k', urn: 'nd5015-k:knowledge', class: 'knowledge', ownerUserId: u, vectorIndexEnabled: false },
    })).id;
    const at = await capAtCurrent({ userId: u });
    await db.ownerLimit.updateMany({ where: { ownerUserId: u, key: 'nodes' }, data: { limitValue: at + 2n } });
    const r = await gql(MOVE, asU(), { src: x.id, to: mK });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: mO, loc: { in: ['x', 'x:child'] }, deletedAt: null } })).toBe(2);
  });

  it('a cross-owner subtree move of two nodes into room for exactly two succeeds', async () => {
    const x = await node(mO, 'x');
    await node(mO, 'x:child');
    await capWithRoom({ userId: u }, 2n);
    const before = await liveCount({ userId: u });
    expect((await gql(MOVE, asU(), { src: x.id, to: mU1 })).errors).toBeUndefined();
    expect(await liveCount({ userId: u })).toBe(before + 2n);
    expect(await db.node.count({ where: { memoryId: mO, loc: { in: ['x', 'x:child'] }, deletedAt: null } })).toBe(0);
  });

  it('succeeds at the cap: a move between two memories of the same owner', async () => {
    const z = await node(mU2, 'z');
    await capAtCurrent({ userId: u });
    const r = await gql(MOVE, asU(), { src: z.id, to: mU1 });
    expect(r.errors).toBeUndefined();
  });

  it('refuses cloneNode into the limited owner\'s memory', async () => {
    const z = await node(mU2, 'z');
    await capAtCurrent({ userId: u });
    const r = await gql(CLONE, asU(), { src: z.id, to: mU1 });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: mU1, loc: 'z' } })).toBe(0);
  });
});

describe('#5015 mergeMemories', () => {
  it('refuses a merge from another owner\'s memory into the limited owner\'s before any node moves', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    defaults({ user: { nodes: 3 } });
    const r = await gql(MERGE, asU(), { input: { source: mO, target: mU1 } });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.node.count({ where: { memoryId: mO, deletedAt: null } })).toBe(2);
    expect(await db.node.count({ where: { memoryId: mU1, deletedAt: null } })).toBe(2);
  });

  it('succeeds at the cap: a merge between two memories of the same owner', async () => {
    await node(mU2, 'z');
    await capAtCurrent({ userId: u });
    const r = await gql(MERGE, asU(), { input: { source: mU2, target: mU1 } });
    expect(r.errors).toBeUndefined();
  });
});

describe('#5015 mergeMemories judges each batch once, at an exact fit', () => {
  const merge = (target: string, batchSize?: number) => mergeMemoryGraph(db, {
    ownerLimitCaller: { userId: u }, sourceMemoryId: mO, targetMemoryId: target,
    fields: new Set(['CONTENT', 'EDGES']), deleteSourceMem: false, editor: { userId: u }, batchSize,
  });
  const inMemory = (memoryId: string) => db.node.count({ where: { memoryId, deletedAt: null } });

  it('a cross-owner merge of two nodes into room for exactly two succeeds', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    await capWithRoom({ userId: u }, 2n);
    const r = await gql(MERGE, asU(), { input: { source: mO, target: mU1 } });
    expect(r.errors).toBeUndefined();
    expect(await inMemory(mU1)).toBe(4);
  });

  it('it also succeeds across batches (batch size 1), so a merge that fits never stops half way', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    await capWithRoom({ userId: u }, 2n);
    await merge(mU1, 1);
    expect([await inMemory(mO), await inMemory(mU1)]).toEqual([0, 4]);
  });

  it('counts a carried thread once too: one node and its comment into room for exactly two succeeds, for one refuses', async () => {
    const x = await node(mO, 'x');
    await M.createComment({}, { targetRef: x.id, body: 'carried with the merge' }, { db, userId: u, roles: ['READER'] } as Context);
    const mK = (await db.memory.create({
      data: { id: generateId(), name: 'k', urn: 'nd5015-k:knowledge', class: 'knowledge', ownerUserId: u, vectorIndexEnabled: false },
    })).id;
    await capWithRoom({ userId: u }, 1n);
    await expect(merge(mK)).rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).memoryId).toBe(mO);
    const limit = { ownerUserId: u, key: 'nodes' };
    await db.ownerLimit.updateMany({ where: limit, data: { limitValue: (await liveCount({ userId: u })) + 2n } });
    await merge(mK);
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).memoryId).toBe(mK);
  });

  it('refuses in the batch when the room went away after the preflight (only the per-batch check can refuse)', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    await capWithRoom({ userId: u }, 2n);
    // The limit drops between the preflight's transaction and the first batch's: the preflight is this merge's first one.
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      const out = await real(...a);
      calls += 1;
      if (calls === 1) await db.ownerLimit.updateMany({ where: { ownerUserId: u, key: 'nodes' }, data: { limitValue: 2n } });
      return out;
    }) as never);
    const outcome = await merge(mU1).then(() => null, (e: unknown) => e);
    spy.mockRestore();
    // One transaction committed, the preflight's; the batch's refused (`calls` counts commits).
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    expect([await inMemory(mO), await inMemory(mU1)]).toEqual([2, 2]);
  });

  it('the batch counts the carried thread: room for the node alone, after the preflight passed, refuses', async () => {
    const x = await node(mO, 'x');
    await M.createComment({}, { targetRef: x.id, body: 'carried with the merge' }, { db, userId: u, roles: ['READER'] } as Context);
    const mK = (await db.memory.create({
      data: { id: generateId(), name: 'k', urn: 'nd5015-k:knowledge', class: 'knowledge', ownerUserId: u, vectorIndexEnabled: false },
    })).id;
    await capWithRoom({ userId: u }, 2n);
    const roomForOne = (await liveCount({ userId: u })) + 1n;
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      const out = await real(...a);
      calls += 1;
      if (calls === 1) await db.ownerLimit.updateMany({ where: { ownerUserId: u, key: 'nodes' }, data: { limitValue: roomForOne } });
      return out;
    }) as never);
    const outcome = await merge(mK).then(() => null, (e: unknown) => e);
    spy.mockRestore();
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).memoryId).toBe(mO);
  });

  it('refuses before the first batch commits anything (only the preflight can: each batch alone would fit at first)', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    await capWithRoom({ userId: u }, 1n);
    await expect(merge(mU1, 1)).rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    expect([await inMemory(mO), await inMemory(mU1)]).toEqual([2, 2]);
  });
});

describe('#5015 cloneMemory and extractParentNodeToMemory', () => {
  it('refuses a clone into the limited organization for the whole batch', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    await capAtCurrent({ organizationId: orgId });
    const before = await db.memory.count();
    const r = await gql(CLONE_MEMORY, ctxOf(orgAdmin), { ref: mO, urn: `hrn:mem:${orgUrn}:o-copy` });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.memory.count()).toBe(before);
  });

  it('refuses a clone of two nodes into an organization one below its limit (the batch is judged whole, not as one)', async () => {
    await node(mO, 'x');
    await node(mO, 'y');
    const at = await capAtCurrent({ organizationId: orgId });
    await db.ownerLimit.updateMany({ where: { organizationId: orgId, key: 'nodes' }, data: { limitValue: at + 1n } });
    const before = await db.memory.count();
    const r = await gql(CLONE_MEMORY, ctxOf(orgAdmin), { ref: mO, urn: `hrn:mem:${orgUrn}:o-copy` });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.memory.count()).toBe(before);
  });

  it('succeeds at the cap: an extract-and-move that stays within one owner is net zero', async () => {
    const p = await node(mO, 'p');
    await node(mO, 'p:q');
    await node(mO, 'stays');
    await capAtCurrent({ organizationId: orgId });
    const r = await gql(EXTRACT, ctxOf(orgAdmin), { ref: p.id, urn: `hrn:mem:${orgUrn}:extracted`, move: true });
    expect(r.errors).toBeUndefined();
  });

  it('refuses an extract that copies (no move) at the cap: the copies are new live nodes', async () => {
    const p = await node(mO, 'p');
    await capAtCurrent({ organizationId: orgId });
    const r = await gql(EXTRACT, ctxOf(orgAdmin), { ref: p.id, urn: `hrn:mem:${orgUrn}:extracted`, move: false });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(await db.memory.count({ where: { urn: `${orgUrn}:extracted` } })).toBe(0);
  });

  // #5145 (follow-up to #5127): a move that crosses owners adds every moved row to the target owner (cor:acl:150:04: a node moved in
  // from another owner's memory adds). Red under `addsNodes = !args.move` in extractParentNode.ts (every move free).
  it('a cross-owner extract-and-move of two nodes: room for one refuses and writes nothing, room for exactly two succeeds', async () => {
    const p = await node(mU1, 'p');
    await node(mU1, 'p:q');
    const sources = { memoryId: mU1, loc: { in: ['p', 'p:q'] }, deletedAt: null };
    const target = `${orgUrn}:xo`;
    await capWithRoom({ organizationId: orgId }, 1n);
    const r = await gql(EXTRACT, asU(), { ref: p.id, urn: `hrn:mem:${target}`, move: true });
    expect(code(r)).toBe('OWNER_LIMIT_REACHED');
    expect(err(r)?.extensions?.limitKey).toBe('nodes');
    expect(await db.memory.count({ where: { urn: target } })).toBe(0);
    expect(await db.node.count({ where: sources })).toBe(2);
    await db.ownerLimit.updateMany({ where: { organizationId: orgId, key: 'nodes' }, data: { limitValue: (await liveCount({ organizationId: orgId })) + 2n } });
    expect((await gql(EXTRACT, asU(), { ref: p.id, urn: `hrn:mem:${target}`, move: true })).errors).toBeUndefined();
    expect(await db.memory.count({ where: { urn: target } })).toBe(1);
    expect(await db.node.count({ where: sources })).toBe(0);
  });

  // #5145: a same-owner move adds 0 and `requireOwnerHeadroomMany` skips a zero amount, so an owner already OVER its limit (a
  // downgrade) can still reorganise. At the cap an unskipped zero would also pass; only below the count tells the two apart.
  it('succeeds below the cap: a same-owner extract-and-move by an owner already over its nodes limit', async () => {
    const p = await node(mO, 'p');
    await node(mO, 'p:q');
    await node(mO, 'stays');
    const at = await capAtCurrent({ organizationId: orgId });
    await db.ownerLimit.updateMany({ where: { organizationId: orgId, key: 'nodes' }, data: { limitValue: at - 2n } });
    expect(await liveCount({ organizationId: orgId })).toBeGreaterThan(at - 2n);
    const r = await gql(EXTRACT, ctxOf(orgAdmin), { ref: p.id, urn: `hrn:mem:${orgUrn}:over`, move: true });
    expect(r.errors).toBeUndefined();
    expect(await db.memory.count({ where: { urn: `${orgUrn}:over` } })).toBe(1);
    expect(await liveCount({ organizationId: orgId })).toBe(at);
  });
});

describe('#5015 a negative amount is a door bug', () => {
  it('requireNodeHeadroom throws instead of passing', async () => {
    await expect(db.$transaction((tx) => requireNodeHeadroom(tx, { memoryId: mU1, amount: -1n, caller: null })))
      .rejects.toThrow('requireNodeHeadroom: amount must not be negative');
  });
});

describe('#5015/#5016 clone and extract ask `memories` and `nodes` together', () => {
  const limits = async (nodes: bigint, memories: bigint) => {
    await db.ownerLimit.deleteMany({ where: { organizationId: orgId } });
    for (const [key, limitValue] of [['nodes', nodes], ['memories', memories]] as const) {
      await db.ownerLimit.create({ data: { id: generateId(), organizationId: orgId, key, limitValue, sourceType: 'manual', sourceId: 't', note: 't' } });
    }
  };
  it.each([['cloneMemory'], ['extractParentNodeToMemory']])('%s: room for exactly one memory and one node succeeds; one short of either refuses and writes nothing', async (door) => {
    const p = await node(mO, 'p');
    const extra = door === 'cloneMemory' ? (await db.node.count({ where: { memoryId: mO, deletedAt: null } })) : 1;
    const nodes = await liveCount({ organizationId: orgId });
    const memories = await OWNER_LIMIT_KEYS.memories.count(db, { organizationId: orgId });
    const run = () => door === 'cloneMemory'
      ? gql(CLONE_MEMORY, ctxOf(orgAdmin), { ref: mO, urn: `hrn:mem:${orgUrn}:both` })
      : gql(EXTRACT, ctxOf(orgAdmin), { ref: p.id, urn: `hrn:mem:${orgUrn}:both`, move: false });
    for (const [n, m, key] of [[nodes + BigInt(extra) - 1n, memories + 1n, 'nodes'], [nodes + BigInt(extra), memories, 'memories']] as const) {
      await limits(n, m);
      const r = await run();
      expect(code(r)).toBe('OWNER_LIMIT_REACHED');
      expect(r.errors?.[0].extensions?.limitKey).toBe(key);
      expect(await db.memory.count({ where: { urn: `${orgUrn}:both` } })).toBe(0);
    }
    await limits(nodes + BigInt(extra), memories + 1n);
    expect((await run()).errors).toBeUndefined();
    expect(await liveCount({ organizationId: orgId })).toBe(nodes + BigInt(extra));
  });
});

describe('#5015 Agent revisions', () => {
  async function makeAgent() {
    return resolvers.Mutation.createAgent({}, { orgRef: orgId, name: 'nd5015-agent', visibility: 'PERSONAL' }, { db, roles: ['READER'], userId: orgAdmin } as Context);
  }
  it('the first createRevision adds two nodes (the parent and the revision): room for exactly two succeeds, for one refuses', async () => {
    const asAdmin = { db, roles: ['READER'], userId: orgAdmin } as Context;
    const agent = await makeAgent();
    await capWithRoom({ organizationId: orgId }, 1n);
    const before = await liveCount({ organizationId: orgId });
    await expect(resolvers.Mutation.createRevision({}, { agentRef: agent.id }, asAdmin))
      .rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    expect(await liveCount({ organizationId: orgId })).toBe(before);
    await db.ownerLimit.updateMany({ where: { organizationId: orgId, key: 'nodes' }, data: { limitValue: before + 2n } });
    await resolvers.Mutation.createRevision({}, { agentRef: agent.id }, asAdmin);
    expect(await liveCount({ organizationId: orgId })).toBe(before + 2n);
  });

  it('refuses createRevision at the cap; restoreRevision (its auto-save included) succeeds at the cap', async () => {
    const agent = await makeAgent();
    const asAdmin = { db, roles: ['READER'], userId: orgAdmin } as Context;
    await resolvers.Mutation.createRevision({}, { agentRef: agent.id }, asAdmin);
    await capAtCurrent({ organizationId: orgId });
    await expect(resolvers.Mutation.createRevision({}, { agentRef: agent.id }, asAdmin))
      .rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    await expect(resolvers.Mutation.restoreRevision({}, { agentRef: agent.id, revisionLoc: 'revisions:rev-1' }, asAdmin))
      .resolves.toBeTruthy();
  });
});
