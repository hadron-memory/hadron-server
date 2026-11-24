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
import type { OwnerRef } from '../../../lib/owner.js';
import { formatGraphQLError } from '../formatError.js';
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
});

describe('#5015 Agent revisions', () => {
  async function makeAgent() {
    return resolvers.Mutation.createAgent({}, { orgRef: orgId, name: 'nd5015-agent', visibility: 'PERSONAL' }, { db, roles: ['READER'], userId: orgAdmin } as Context);
  }
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
