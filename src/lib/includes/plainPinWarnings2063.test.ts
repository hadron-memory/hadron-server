/** #2063 P4: advice requires the writer's own history read, never a privileged probe. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { signaturePayloadBytes } from '../signing/payload.js';
import { completeSigningRequestInTransaction } from '../signing/requests.js';
import { maySignInMemory } from '../../api/graphql/schema/resolvers.signing.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { getAccessibleMemoryIds } from '../../api/graphql/schema/resolvers.helpers.js';
import { taskWarningsPlugin } from '../../api/graphql/taskWarningsPlugin.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import * as warnings from './plainPinWarnings.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string;
let memoryId: string;
const ctx = (id = userId): Context => ({ db, userId: id, roles: ['READER'] });
const check = (text: string, c = ctx()) => warnings.plainPinWarnings(c, { memoryId }, text);
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Pin warnings', urn: 'pins2063.example' } });
  const user = await db.user.create({ data: { githubId: 206302, githubUsername: 'pins2063', handle: 'pins2063', roles: [] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'pins2063' }, ctx())).id;
});
it('warns for a readable plain revision with fixed text and no target details', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Secret title', content: 'Secret text' } });
  expect(await check('{{> target rev=1}}')).toEqual([{ code: 'include.pin.unkept', text: 'A pinned include revision carries no recorded approval or signature and may be automatically pruned, breaking the include.' }]);
});
it('omits warnings for missing or unreadable history uniformly', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  const other = await db.user.create({ data: { githubId: 206303, githubUsername: 'other2063', handle: 'other2063', roles: [] } });
  expect(await check('{{> target rev=1}}', ctx(other.id))).toEqual([]);
  expect(await check('{{> missing rev=1}}', ctx(other.id))).toEqual([]);
  expect(await check('{{> target rev=999}}')).toEqual([]);
});
it('no-pin writes and recorded-approval pins have no false warning; covered siblings still warn', async () => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, ctx());
  expect(await check('{{> target}}')).toEqual([]);
  expect(await check('{{> target rev=1 approved}}')).toEqual([]);
  await resolvers.Mutation.updateNode(null, { input: { id: n.id, tags: ['metadata'] } }, ctx());
  expect(await check('{{> target rev=2 approved}}')).toHaveLength(1);
});
it('a moved snapshot is concealed unless both current and capture memories are readable', async () => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  await resolvers.Mutation.updateNode(null, { input: { id: n.id, content: 'new' } }, ctx());
  const foreignOwner = await db.user.create({ data: { githubId: 206304, githubUsername: 'foreign2063', handle: 'foreign2063', roles: [] } });
  const foreign = await db.memory.create({ data: { id: generateId(), name: 'foreign', urn: 'pins2063.example:foreign', class: 'private', userId: foreignOwner.id, ownerUserId: foreignOwner.id } });
  await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { memoryId: foreign.id } });
  expect(await check('{{> target rev=1}}')).toEqual([]);
});

it('GraphQL exposes advice only on committed content writes, never reads/no-op/omission', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
  const execute = async (query: string, variables: Record<string, unknown>, contextValue = ctx()) => {
    const r = await server.executeOperation({ query, variables }, { contextValue });
    if (r.body.kind !== 'single') throw new Error('unexpected response');
    return r.body.singleResult;
  };
  const selection = '{ id }';
  const created = await execute(`mutation($i:CreateNodeInput!){createNode(input:$i)${selection}}`,
    { i: { memoryId, loc: 'source', name: 'Source', content: '{{> target rev=1}}' } });
  expect(created.errors).toBeUndefined();
  const n = (created.data as any).createNode;
  expect(created.extensions?.warnings).toEqual([expect.objectContaining({ path: 'createNode', code: 'include.pin.unkept' })]);
  const read = await execute(`query($id:ID!){node(ref:$id)${selection}}`, { id: n.id });
  expect(read.errors).toBeUndefined();
  expect(read.extensions?.warnings).toBeUndefined();
  const omitted = await execute(`mutation($i:UpdateNodeInput!){updateNode(input:$i)${selection}}`,
    { i: { id: n.id, description: 'changed metadata' } });
  expect(omitted.errors).toBeUndefined();
  expect(omitted.extensions?.warnings).toBeUndefined();
  const noop = await execute(`mutation($i:UpdateNodeInput!){updateNode(input:$i)${selection}}`,
    { i: { id: n.id, content: '{{> target rev=1}}' } });
  expect(noop.errors).toBeUndefined();
  expect(noop.extensions?.warnings).toBeUndefined();
  const refused = await execute(`mutation($i:UpdateNodeInput!){updateNode(input:$i)${selection}}`,
    { i: { id: n.id, content: '{{> target rev=1}} {{> missing}}' } });
  expect(refused.errors).toHaveLength(1);
  expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ content: '{{> target rev=1}}' });
  await server.stop();
});
it('response metadata cannot travel to another context/target and lookup faults are unavailable advice', async () => {
  const c = ctx();
  const result = { memoryId };
  warnings.attachIncludePinWarnings(c, result, 'no pins');
  expect(await warnings.includePinWarningsFor(c, result)).toEqual([]);
  expect(warnings.includePinWarningsFor(ctx(), result)).toBeNull();
  expect(warnings.includePinWarningsFor(c, { memoryId })).toBeNull();
  const broken = { ...c, db: { node: { findFirst: async () => { throw new Error('sensitive database failure'); } } } as any };
  expect(await warnings.safePlainPinWarnings(broken, result, '{{> target rev=1}}')).toBeNull();
});

it('MCP create/update/parent and governed doors carry the same warning and suppress no-op/omission', async () => {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const urn = (loc: string) => `hrn:node:${memory.urn}:${loc}`;
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  const client = createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
  expect(await client.callToolText('hadron_create_node', { urn: urn('mcp'), name: 'MCP', content: '{{> target rev=1}}' })).toContain('Warning [include.pin.unkept]');
  expect(await client.callToolText('hadron_update_node', { urn: urn('mcp'), content: '{{> target rev=1}}' })).not.toContain('include.pin.unkept');
  expect(await client.callToolText('hadron_update_node', { urn: urn('mcp'), description: 'metadata' })).not.toContain('include.pin.unkept');
  expect(await client.callToolText('hadron_update_node', { urn: urn('mcp'), content: 'changed {{> target rev=1}}' })).not.toContain('include.pin.unkept');
  expect(await client.callToolText('hadron_create_parent_node', { urn: urn('parent'), name: 'Parent', description: '{{> target rev=1}}' })).toContain('Warning [include.pin.unkept]');
  expect(await client.callToolText('hadron_create_review', { urn: urn('review'), name: 'Review', content: '{{> target rev=1}}' })).toContain('Warning [include.pin.unkept]');
});
it('bulk results carry per-item warnings only after committed content replacements, not dry runs', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 'bulk', name: 'Bulk', content: 'old' } });
  const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
  const query = `mutation($i:SearchReplaceInNodesInput!){searchReplaceInNodes(input:$i){nodesChanged results{nodeId}}}`;
  const input = { nodeIds: [source.id], oldText: 'old', newText: '{{> target rev=1}}', fields: ['content'] };
  const run = async (dryRun: boolean) => {
    const r = await server.executeOperation({ query, variables: { i: { ...input, dryRun } } }, { contextValue: ctx() });
    if (r.body.kind !== 'single') throw new Error('unexpected response');
    expect(r.body.singleResult.errors).toBeUndefined();
    return r.body.singleResult;
  };
  expect((await run(true)).extensions?.warnings).toBeUndefined();
  expect((await run(false)).extensions?.warnings).toEqual([expect.objectContaining({ path: 'searchReplaceInNodes', code: 'include.pin.unkept' })]);
  await server.stop();
});

it('unchanged pins are silent even in a changed body, while changed pin settings warn', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  expect(await warnings.plainPinWarnings(ctx(), { memoryId }, 'new body {{> target rev=1}}', 'old body {{> target rev=1}}')).toEqual([]);
  expect(await warnings.plainPinWarnings(ctx(), { memoryId }, '{{> target rev=1 approved}}', '{{> target rev=1}}')).toHaveLength(1);
});
it('projection before outer commit carries no advice until committed, and remains request-local', async () => {
  const c = ctx();
  const raw = { memoryId };
  const projected = { memoryId };
  warnings.carryIncludePinWarnings(c, raw, projected);
  expect(warnings.includePinWarningsFor(c, projected)).toBeNull();
  warnings.attachIncludePinWarnings(c, raw, 'no pins'); // simulated owner's afterCommit callback
  expect(await warnings.includePinWarningsFor(c, projected)).toEqual([]);
  expect(warnings.includePinWarningsFor(ctx(), projected)).toBeNull();
});

it('a recorded signature suppresses advice, while a covered non-carrier still warns', async () => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'signed-target', name: 'Signed target', content: 'text' } });
  const oldOrigin = process.env.SIGNING_CEREMONY_ORIGINS;
  const oldRp = process.env.PASSKEY_RP_ID;
  process.env.SIGNING_CEREMONY_ORIGINS = 'https://sign2063.example';
  process.env.PASSKEY_RP_ID = 'sign2063.example';
  try {
    const req = await resolvers.Mutation.requestNodeSignature(null, { nodeRef: n.id }, ctx());
    const key = softPasskey();
    await insertSoftPasskey(db, userId, key, { label: 'Synthetic test key', rpId: 'sign2063.example' });
    const payload = signaturePayloadBytes('hadron-signature-v1', req);
    await db.$transaction(tx => completeSigningRequestInTransaction(tx, req.id, {
      memoryId, signerId: userId, credentialId: key.credentialId,
      assertion: key.assert({ payload, origin: 'https://sign2063.example', rpId: 'sign2063.example' }),
      mayWrite: maySignInMemory(db),
    }));
    expect(await check('{{> signed-target rev=1 signed}}')).toEqual([]);
    await resolvers.Mutation.updateNode(null, { input: { id: n.id, tags: ['metadata'] } }, ctx());
    expect(await check('{{> signed-target rev=2 signed}}')).toHaveLength(1);
  } finally {
    if (oldOrigin === undefined) delete process.env.SIGNING_CEREMONY_ORIGINS; else process.env.SIGNING_CEREMONY_ORIGINS = oldOrigin;
    if (oldRp === undefined) delete process.env.PASSKEY_RP_ID; else process.env.PASSKEY_RP_ID = oldRp;
  }
});

it('post-commit advice does not reuse a pre-write accessible-memory cache after revocation', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  const c = ctx();
  expect(await getAccessibleMemoryIds(c)).toContain(memoryId);
  // Model an inherited pre-write App/worker reach memo as well as the real
  // org gate. The new advisory read must not trust either earlier answer.
  c.appDerivedMemoryIdCache = Promise.resolve([memoryId]);
  await db.orgMember.deleteMany({ where: { userId } });
  expect(await check('{{> target rev=1}}', c)).toEqual([]);
});

it('a late owner callback cannot file warnings into a later request reusing its context', async () => {
  const c = ctx();
  warnings.resetIncludePinWarnings(c);
  const lifetime = warnings.captureIncludePinWarningLifetime(c);
  warnings.resetIncludePinWarnings(c); // another request, even with the same Context object
  const result = { memoryId };
  warnings.attachIncludePinWarnings(c, result, 'no pins', undefined, c, lifetime);
  expect(warnings.includePinWarningsFor(c, result)).toBeNull();
  expect(await warnings.responseIncludePinWarnings(c, new Set())).toEqual([]);
});
