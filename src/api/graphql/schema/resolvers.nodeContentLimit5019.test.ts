/**
 * #5019 (Billing A11, cor:dmo:060:19 Proposed): a write that would leave a node over `NODE_CONTENT_MAX_BYTES` is refused
 * `NODE_CONTENT_TOO_LARGE` on every GraphQL content door, and nothing is written. RED on main: each "refused" case wrote.
 * The "still" cases pass on main and guard against over-refusal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { encryptWithSecret } from '../../../test/encryptMemoryWithSecret.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());
interface Result { data?: Record<string, any> | null; errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }> }
let u: string, admin: string, orgId: string, mem: string;
async function gql(query: string, variables: Record<string, unknown>, ctx: Partial<Context> = {}): Promise<Result> {
  const contextValue = { db, userId: u, roles: ['READER'], ...ctx } as Context;
  const res = await server.executeOperation({ query, variables }, { contextValue });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult as Result;
}
const CREATE = `mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }`;
const UPDATE = `mutation($input: UpdateNodeInput!) { updateNode(input: $input) { id } }`;
const UPDATE_DATA = `mutation($ref: ID!, $data: JSON!) { updateNodeData(nodeRef: $ref, data: $data) { id } }`;
const UPDATE_PROPS = `mutation($ref: ID!, $p: JSON!) { updateNodeProperties(nodeRef: $ref, properties: $p) { id } }`;
const REPLACE = `mutation($input: SearchReplaceInNodesInput!) { searchReplaceInNodes(input: $input) { nodesChanged } }`;
const MERGE = `mutation($input: MergeNodesInput!) { mergeNodes(input: $input) { id } }`;
const RESTORE = `mutation($ref: String!) { restoreNodeRevision(nodeRevRef: $ref) { id } }`;
const IMPORT = `mutation($input: ImportNodeInput!) { importNode(input: $input) { status } }`;
const CLONE = `mutation($src: ID!, $urn: String!) { cloneNode(sourceRef: $src, targetUrn: $urn) { id } }`;
const DELETE = `mutation($ref: ID!) { deleteNode(nodeRef: $ref) }`;

const cap = (n: number | '') => vi.stubEnv('NODE_CONTENT_MAX_BYTES', String(n));
const a = (n: number) => 'a'.repeat(n);
/** A JSON object whose serialized form is exactly `n` bytes. */
const json = (n: number) => ({ k: a(n - 8) });
const refusedAt = (r: Result, maxBytes = 1000) => {
  expect(r.errors?.[0]?.extensions).toMatchObject({ code: 'NODE_CONTENT_TOO_LARGE', maxBytes });
  expect(r.errors![0].message).toBe(`A node can hold at most ${maxBytes} bytes.`);
};
const ok = (r: Result) => expect(r.errors).toBeUndefined();
const node = (loc: string, extra: Record<string, unknown> = {}, memoryId = mem) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...extra } });
const row = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const create = (input: Record<string, unknown>) => gql(CREATE, { input: { memoryId: mem, loc: 'n', name: 'n', ...input } });

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  u = (await db.user.create({ data: { id: generateId(), handle: 'nc5019-u', email: 'nc5019-u@example.test', roles: ['READER'] } })).id;
  admin = (await db.user.create({ data: { id: generateId(), handle: 'nc5019-a', email: 'nc5019-a@example.test', roles: ['ADMIN'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'nc5019', urn: 'nc5019-org' } })).id;
  for (const userId of [u, admin]) await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'OWNER' } });
  mem = (await db.memory.create({ data: { id: generateId(), name: 'm', urn: 'nc5019-org:m', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  cap(1000);
});
afterEach(() => { vi.unstubAllEnvs(); sessionKeyCache.clear(); });

describe('#5019 create and update', () => {
  it('a create with 1,001 bytes is refused and writes nothing; 1,000 is accepted', async () => {
    refusedAt(await create({ content: a(1001) }));
    expect(await db.node.count({ where: { memoryId: mem } })).toBe(0);
    ok(await create({ content: a(1000) }));
  });

  it('bytes, not characters', async () => refusedAt(await create({ content: '€'.repeat(334) })));

  it.each(['data', 'description', 'properties'])('content plus %s are counted together', async (field) => {
    const value = field === 'description' ? a(600) : json(600);
    refusedAt(await create({ content: a(600), [field]: value }));
    ok(await create({ content: a(400), [field]: value }));
  });

  it('an update is refused and leaves the row and its revision unchanged', async () => {
    const n = await node('n', { content: 'before' });
    const before = await row(n.id);
    refusedAt(await gql(UPDATE, { input: { id: n.id, content: a(1001) } }));
    expect(await row(n.id)).toEqual(before);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
    ok(await gql(UPDATE, { input: { id: n.id, content: a(1000) } }));
  });

  it('a partial update is judged on the resulting node', async () => {
    const n = await node('n', { content: a(600) });
    refusedAt(await gql(UPDATE, { input: { id: n.id, data: json(600) } }));
    ok(await gql(UPDATE, { input: { id: n.id, data: json(400) } }));
    ok(await gql(UPDATE, { input: { id: n.id, content: null, data: json(1000) } }));
  });

  it('reviving a tombstone counts the fields it keeps', async () => {
    await node('n', { data: json(600), deletedAt: new Date() });
    refusedAt(await create({ content: a(600) }));
    expect((await db.node.findFirstOrThrow({ where: { memoryId: mem, loc: 'n' } })).deletedAt).not.toBeNull();
  });

  it('applies to a platform admin too', async () => {
    refusedAt(await gql(CREATE, { input: { memoryId: mem, loc: 'n', name: 'n', content: a(1001) } }, { userId: admin, roles: ['ADMIN'] as never }));
  });

  it('a node already over the ceiling: an edit that leaves it over is refused (a tag-only one too); shortening and deleting work', async () => {
    const n = await node('n', { content: a(2000) });
    refusedAt(await gql(UPDATE, { input: { id: n.id, content: a(1500) } }));
    refusedAt(await gql(UPDATE, { input: { id: n.id, tags: ['x'] } }));
    const t = await node('t', { loc: 't' });
    // An edge-only or unchanged save is not an edit of the node's content.
    ok(await gql(UPDATE, { input: { id: n.id, edges: [{ targetId: t.id, name: 'to' }] } }));
    ok(await gql(UPDATE, { input: { id: n.id, content: a(2000) } }));
    expect((await gql(`query($r: ID!) { node(ref: $r) { content } }`, { r: n.id })).data!.node.content).toHaveLength(2000);
    ok(await gql(UPDATE, { input: { id: n.id, content: a(900) } }));
    const over = await node('over', { content: a(2000) });
    ok(await gql(DELETE, { ref: over.id }));
  });

  it('unset: a 2 MB node is written as today', async () => {
    cap('');
    ok(await create({ content: a(2 * 1024 * 1024) }));
  });
});

describe('#5019 an encrypted memory is measured in plaintext', () => {
  it('accepts 1,000 bytes and refuses 1,001, on create and on a partial update', async () => {
    const dataKey = Buffer.alloc(32, 7).toString('base64');
    mem = (await db.memory.create({ data: { id: generateId(), name: 'p', urn: 'nc5019-u:p', class: 'private', userId: u, ownerUserId: u, vectorIndexEnabled: false } })).id;
    await encryptWithSecret(null, { memoryRef: mem, dataKey }, { db, userId: u, roles: ['READER'] } as Context);
    sessionKeyCache.set('nc5019', mem, parseDataKey(dataKey));
    ok(await create({ content: a(1000) }));
    refusedAt(await create({ loc: 'n2', content: a(1001) }));
    const n = await db.node.findFirstOrThrow({ where: { memoryId: mem, loc: 'n' } });
    expect(n.content!.length).toBeGreaterThan(1000);
    refusedAt(await gql(UPDATE, { input: { id: n.id, description: 'd' } }));
    ok(await gql(UPDATE, { input: { id: n.id, content: a(990), description: a(10) } }));
    // A merge of a plaintext field needs no session key: the stored body is measured from its envelope.
    const src = await node('src', { description: a(20) });
    sessionKeyCache.clear();
    refusedAt(await gql(MERGE, { input: { source: src.id, target: n.id, include: ['DESCRIPTION'] } }));
  });
});

describe('#5019 the other content doors', () => {
  it('updateNodeData and updateNodeProperties measure the merged object', async () => {
    const n = await node('n', { data: { first: a(600) }, properties: { first: a(300) } });
    refusedAt(await gql(UPDATE_DATA, { ref: n.id, data: { second: a(600) } }));
    refusedAt(await gql(UPDATE_PROPS, { ref: n.id, p: { second: a(600) } }));
    ok(await gql(UPDATE_DATA, { ref: n.id, data: { first: a(5) } }));
  });

  it('searchReplaceInNodes refuses the whole batch and writes nothing, in a dry run too', async () => {
    const small = await node('a-small', { content: 'cat' });
    const big = await node('b-big', { content: `cat${a(990)}` });
    const input = { oldText: 'cat', newText: a(20), nodeIds: [small.id, big.id], fields: ['content'] };
    refusedAt(await gql(REPLACE, { input: { ...input, dryRun: true } }));
    refusedAt(await gql(REPLACE, { input }));
    expect((await row(small.id)).content).toBe('cat');
    expect(await db.nodeRevision.count({ where: { nodeId: { in: [small.id, big.id] } } })).toBe(0);
    ok(await gql(REPLACE, { input: { ...input, nodeIds: [small.id] } }));
  });

  it('mergeNodes measures the merged target and writes nothing on refusal', async () => {
    const s = await node('s', { content: a(600) });
    const t = await node('t', { content: a(600) });
    refusedAt(await gql(MERGE, { input: { source: s.id, target: t.id, deleteSource: true } }));
    expect((await row(t.id)).content).toBe(a(600));
    expect((await row(s.id)).deletedAt).toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId: t.id } })).toBe(0);
  });

  it('restoreNodeRevision refuses a revision over a lowered ceiling', async () => {
    cap('');
    const n = await node('n', { content: a(2000) });
    ok(await gql(UPDATE, { input: { id: n.id, content: 'short' } }));
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id } });
    cap(1000);
    const before = await row(n.id);
    refusedAt(await gql(RESTORE, { ref: rev.id }));
    expect(await row(n.id)).toEqual(before);
    cap(2000);
    ok(await gql(RESTORE, { ref: rev.id }));
  });

  it('searchReplaceInSpecNodes is refused and writes nothing', async () => {
    const draft = await resolvers.Mutation.createMemory(null, { orgRef: orgId, name: 'specs-draft', draftCorpus: true } as never, { db, roles: ['ADMIN'], userId: admin } as Context) as { id: string };
    const spec = await node('pas:010:01', { content: `cat ${a(990)}`, role: 'spec' }, draft.id);
    const input = { memoryRef: draft.id, nodeIds: [spec.id], oldText: 'cat', newText: a(20), fields: ['content'], dryRun: true };
    const run = (extra = {}) => resolvers.Mutation.searchReplaceInSpecNodes(null, { input: { ...input, ...extra } } as never, { db, roles: ['ADMIN'], userId: admin } as Context);
    cap('');
    const { plan } = await run() as { plan: string };
    cap(1000);
    await expect(run({ dryRun: false, expectedPlan: plan })).rejects.toMatchObject({ extensions: { code: 'NODE_CONTENT_TOO_LARGE', maxBytes: 1000 } });
    await expect(run()).rejects.toMatchObject({ extensions: { code: 'NODE_CONTENT_TOO_LARGE' } });
    expect((await row(spec.id)).content).toContain('cat');
  });

  it('importNode is refused and writes nothing', async () => {
    refusedAt(await gql(IMPORT, { input: { memoryId: mem, loc: 'i', name: 'i', content: a(1001), contentType: 'text/markdown' } }));
    expect(await db.node.count({ where: { memoryId: mem, loc: 'i' } })).toBe(0);
  });

  it('a copy is not checked: cloneNode of a node over the ceiling still works', async () => {
    const n = await node('n', { content: a(2000) });
    ok(await gql(CLONE, { src: n.id, urn: "hrn:node:nc5019-org:m:copy" }));
    expect((await db.node.findFirstOrThrow({ where: { memoryId: mem, loc: 'copy' } })).content).toHaveLength(2000);
  });
});
