import { ApolloServer } from '@apollo/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { chargeBatchReadEdges } from './resolvers.nodeBatchEdges.js';
import { resolveInheritedEdges } from '../../../lib/effectiveSystemMemory.js';

let memoryId: string, userId: string;
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'oom2758.example', graphName: 'synthetic' });
  memoryId = graph.id;
  userId = (await db.user.create({ data: { handle: 'oom-probe' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
});
afterEach(() => vi.restoreAllMocks());
const context = (): Context => ({ db, userId, roles: ['READER'] });
async function run(query: string, variables: Record<string, unknown>) {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  try {
    const response = await api.executeOperation({ query, variables }, { contextValue: context() });
    if (response.body.kind !== 'single') throw new Error('unexpected response');
    return response.body.singleResult;
  } finally { await api.stop(); }
}

it('NodeLiveRevisionsMinted does not materialize unselected edge endpoints before the byte cap', async () => {
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: generateId(), memoryId, loc: `dense:${i}`, name: 'synthetic', content: 'x'.repeat(64 * 1024) }));
  await db.node.createMany({ data: nodes });
  await db.edge.createMany({ data: nodes.flatMap(a => nodes.map(b => ({ id: generateId(), memoryId, sourceId: a.id, targetId: b.id, loc: `e:${a.loc}:${b.loc}` }))) });
  const original = db.node.findMany.bind(db.node);
  let materializedBytes = 0;
  vi.spyOn(db.node, 'findMany').mockImplementation((async (args: any) => {
    const rows = await original(args);
    materializedBytes += Buffer.byteLength(JSON.stringify(rows));
    return rows as any;
  }) as typeof db.node.findMany);
  const before = process.memoryUsage();
  const response = await run(`query NodeLiveRevisionsMinted($memory:ID!){
    nodeBatch(memory:$memory,locPrefix:"dense:"){truncated omitted unavailable nodes{
      id revision authorship{kind authoredAt taskRef taskRevision human{handle urn}}
      contentValidation{state latestReport{outcome nodeRevision reportedAt validationTaskRef validationTaskRevision}}
      approvalStatus{state approval{revision approvedAt approvedBy{handle urn} approvedByInfo hash}}
      mintStatus{minted mintedAt mintedBy{handle urn} mintedByInfo revision hash}
    }}
  }`, { memory: memoryId });
  expect(response.errors).toBeUndefined();
  const result = (response.data as any).nodeBatch;
  expect(result.truncated).toBe(true);
  expect(result.nodes.length).toBeGreaterThan(0);
  expect(result.nodes.length + result.omitted.length).toBe(24);
  console.log(JSON.stringify({ probe: 'nodeBatch2758', materializedBytes, responseBytes: Buffer.byteLength(JSON.stringify(response)), heapDelta: process.memoryUsage().heapUsed - before.heapUsed, rssDelta: process.memoryUsage().rss - before.rss }));
  // Parent scalar data is ~1.5MB twice; the old eager endpoint fan-out is ~150MB.
  expect(materializedBytes).toBeLessThan(8 * 1024 * 1024);
}, 60_000);

it('selected edges still resolve their endpoints, including aliases and fragments', async () => {
  const a = await createDbNode(db, { memoryId, loc: 'a', content: 'A' });
  const b = await createDbNode(db, { memoryId, loc: 'b', content: 'B' });
  await db.edge.create({ data: { memoryId, loc: 'a-b', sourceId: a.id, targetId: b.id } });
  const response = await run(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{...E}}} fragment E on Node{ out:outgoingEdges{target{id content}} }`, { refs: [a.id] });
  expect(response.errors).toBeUndefined();
  expect((response.data as any).nodeBatch.nodes[0].out).toEqual([{ target: { id: b.id, content: 'B' } }]);
});

it('scalar byte spillover is selected without materializing every oversized body', async () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: generateId(), memoryId, loc: `large:${i}`, name: 'large', content: 'x'.repeat(256 * 1024) }));
  await db.node.createMany({ data: nodes });
  const original = db.node.findMany.bind(db.node);
  let bulkBytes = 0;
  vi.spyOn(db.node, 'findMany').mockImplementation((async (args: any) => {
    const rows = await original(args);
    bulkBytes += Buffer.byteLength(JSON.stringify(rows));
    return rows;
  }) as typeof db.node.findMany);
  const response = await run(`query($memory:ID!){nodeBatch(memory:$memory,locPrefix:"large:"){nodes{id} omitted truncated}}`, { memory: memoryId });
  expect(response.errors).toBeUndefined();
  expect((response.data as any).nodeBatch).toMatchObject({ truncated: true });
  expect((response.data as any).nodeBatch.nodes).toHaveLength(3);
  expect((response.data as any).nodeBatch.omitted).toHaveLength(37);
  expect(bulkBytes).toBeLessThan(2 * 1024 * 1024);
}, 60_000);

it('a selected oversized edge projection refuses loudly instead of materializing unlimited endpoints', async () => {
  const a = await createDbNode(db, { memoryId, loc: 'a' });
  const b = await createDbNode(db, { memoryId, loc: 'b' });
  await db.edge.createMany({ data: Array.from({ length: 2001 }, (_, i) => ({ id: generateId(), memoryId, loc: `edge:${i}`, sourceId: a.id, targetId: b.id })) });
  const reads = vi.spyOn(db.edge, 'findMany');
  const response = await run(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{id}}}}`, { refs: [a.id] });
  expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  expect(reads.mock.calls.some(([args]) => args?.take === 2001 && !args.include)).toBe(true);
});

it('both directions and all returned nodes share the edge budget', async () => {
  const a = await createDbNode(db, { memoryId, loc: 'a' });
  const b = await createDbNode(db, { memoryId, loc: 'b' });
  await db.edge.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({ id: generateId(), memoryId, loc: `edge:${i}`, sourceId: a.id, targetId: b.id })) });
  const response = await run(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{id} incomingEdges{id}}}}`, { refs: [a.id, b.id] });
  expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
});

it('inherited batch edges page metadata before endpoint bodies and participate in the same budget', async () => {
  const c = context();
  const org = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
  const create = (resolvers.Mutation as any).createAgent;
  const base = await create({}, { orgId: org.organizationId, name: 'Base' }, c);
  const child = await create({}, { orgId: org.organizationId, name: 'Child' }, c);
  await db.agent.update({ where: { id: child.id }, data: { extendsAgentId: base.id } });
  const baseMemory = (await db.agent.findUniqueOrThrow({ where: { id: base.id } })).systemMemoryId!;
  const childMemory = (await db.agent.findUniqueOrThrow({ where: { id: child.id } })).systemMemoryId!;
  const a = await createDbNode(db, { memoryId: baseMemory, loc: 'a' });
  const b = await createDbNode(db, { memoryId: baseMemory, loc: 'b' });
  await db.edge.createMany({ data: [0, 1].map(i => ({ id: generateId(), memoryId: baseMemory, loc: `edge:${i}`, sourceId: a.id, targetId: b.id })) });
  const edgeReads = vi.spyOn(db.edge, 'findMany');
  await expect(resolveInheritedEdges(db, { nodeId: a.id, via: childMemory, direction: 'out', canReadMemory: async () => true, maxResults: 1 })).rejects.toThrow('Inherited edge result limit exceeded');
  expect(edgeReads.mock.calls[0]![0]).toMatchObject({ take: 128 });
  expect(edgeReads.mock.calls[0]![0]).not.toHaveProperty('include');
  const result = await (resolvers.Query as any).nodeBatch({}, { memory: childMemory, locPrefix: 'a' }, c);
  const parent = result.nodes[0];
  expect(parent.inheritedFrom).toBeDefined();
  chargeBatchReadEdges(parent, 1999);
  await expect((resolvers.Node as any).outgoingEdges(parent, {}, c)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  expect(edgeReads.mock.calls.at(-1)![0]).toMatchObject({ take: 128 });
});

it('lazy batch endpoints keep the cross-memory read gate', async () => {
  const source = await createDbNode(db, { memoryId, loc: 'source' });
  const outsider = await db.user.create({ data: { handle: 'private-owner' } });
  const home = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
  const hidden = await db.memory.create({ data: { organizationId: home.organizationId, urn: 'oom2758.example:hidden', name: 'Hidden', class: 'personal', userId: outsider.id } });
  const target = await createDbNode(db, { memoryId: hidden.id, loc: 'secret', content: 'NEVER_DISCLOSE' });
  await db.edge.create({ data: { memoryId, loc: 'cross', sourceId: source.id, targetId: target.id } });
  const response = await run(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{target{id content}}}}}`, { refs: [source.id] });
  expect(response.errors).toBeUndefined();
  expect((response.data as any).nodeBatch.nodes[0].outgoingEdges).toEqual([{ target: null }]);
  expect(JSON.stringify(response)).not.toContain('NEVER_DISCLOSE');
});

it.each(['prefix', 'refs'] as const)('returns the first oversized node and echoes all later omissions (%s)', async (form) => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: generateId(), memoryId, loc: `oversize:${i}`, name: 'large', content: 'x'.repeat(1_200_000) }));
  await db.node.createMany({ data: rows });
  const query = form === 'prefix'
    ? 'query($memory:ID!){nodeBatch(memory:$memory,locPrefix:"oversize:"){nodes{id content} truncated omitted unavailable}}'
    : 'query($refs:[ID!]){nodeBatch(refs:$refs){nodes{id content} truncated omitted unavailable}}';
  const response = await run(query, form === 'prefix' ? { memory: memoryId } : { refs: rows.map(n => n.id) });
  expect(response.errors).toBeUndefined();
  expect((response.data as any).nodeBatch).toEqual({ nodes: [{ id: rows[0].id, content: rows[0].content }], truncated: true, omitted: rows.slice(1).map(n => n.id), unavailable: [] });
});

it('bounds total edge rows before concurrent sibling fields and aliases materialize them', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: generateId(), memoryId, loc: `concurrent:${i}`, name: 'n' }));
  await db.node.createMany({ data: rows });
  await db.edge.createMany({ data: rows.flatMap((a, i) => rows.map((b, j) => ({ id: generateId(), memoryId, sourceId: a.id, targetId: b.id, loc: `concurrent-edge:${i}:${j}` }))) });
  const original = db.edge.findMany.bind(db.edge);
  const reads: Promise<unknown>[] = [];
  let materializedRows = 0;
  vi.spyOn(db.edge, 'findMany').mockImplementation(((args: any) => {
    const pending = original(args).then(result => { materializedRows += result.length; return result; });
    reads.push(pending);
    return pending;
  }) as typeof db.edge.findMany);
  const response = await run('query($refs:[ID!]){nodeBatch(refs:$refs){nodes{a:outgoingEdges{id} b:outgoingEdges{id} incomingEdges{id}}}}', { refs: rows.map(n => n.id) });
  await Promise.allSettled(reads);
  expect(response.errors?.some(e => e.extensions?.code === 'BAD_USER_INPUT')).toBe(true);
  expect(materializedRows).toBeLessThanOrEqual(2001);
}, 60_000);

it('explicit inherited refs preserve child-only admission without loading unselected endpoint bodies', async () => {
  const home = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
  const make = async (name: string, extendsAgentId?: string) => {
    const memory = await db.memory.create({ data: { organizationId: home.organizationId, class: 'system', name, urn: `oom2758.example:${name}` } });
    const agent = await db.agent.create({ data: { organizationId: home.organizationId, name, urn: `oom2758.example:${name}`, visibility: 'ORGANIZATION', systemMemoryId: memory.id, extendsAgentId } });
    return { memory, agent };
  };
  const base = await make('base'); const child = await make('child', base.agent.id);
  const reader = await db.user.create({ data: { handle: 'child-only', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: home.organizationId!, userId: reader.id, role: 'READER' } });
  const app = await db.app.create({ data: { organizationId: home.organizationId, name: 'Child app', urn: 'oom2758.example:child-app' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: child.agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'member' } });
  const a = await createDbNode(db, { memoryId: base.memory.id, loc: 'a', content: 'A' });
  const b = await createDbNode(db, { memoryId: base.memory.id, loc: 'b', content: 'UNSELECTED'.repeat(16_384) });
  await db.edge.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ id: generateId(), memoryId: base.memory.id, sourceId: a.id, targetId: b.id, loc: `inherited-edge:${i}` })) });
  userId = reader.id;
  expect(await (resolvers.Query as any).memory({}, { ref: base.memory.id }, context())).toBeNull();
  const original = db.node.findUnique.bind(db.node);
  let endpointBodyBytes = 0;
  vi.spyOn(db.node, 'findUnique').mockImplementation((async (args: any) => {
    const row = await original(args);
    if (row?.id === b.id) endpointBodyBytes += Buffer.byteLength(row.content ?? '');
    return row;
  }) as typeof db.node.findUnique);
  const edgeReads = vi.spyOn(db.edge, 'findMany');
  const refs = [`hrn:node:${child.memory.urn}:a`];
  const response = await run('query($refs:[ID!]){nodeBatch(refs:$refs){nodes{id inheritedFrom{agentId} outgoingEdges{id} again:outgoingEdges{id}} unavailable}}', { refs });
  expect(response.errors).toBeUndefined();
  expect((response.data as any).nodeBatch.unavailable).toEqual([]);
  expect((response.data as any).nodeBatch.nodes[0]).toMatchObject({ id: a.id, inheritedFrom: { agentId: base.agent.id } });
  expect((response.data as any).nodeBatch.nodes[0].outgoingEdges).toHaveLength(20);
  expect(endpointBodyBytes).toBe(0);
  expect(edgeReads).toHaveBeenCalledTimes(1);
  expect((response.data as any).nodeBatch.nodes[0].again).toEqual((response.data as any).nodeBatch.nodes[0].outgoingEdges);
  const override = await createDbNode(db, { memoryId: child.memory.id, loc: 'b', content: 'CHILD OVERRIDE' });
  const selected = await run('query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{target{id content}}}}}', { refs });
  expect(selected.errors).toBeUndefined();
  expect((selected.data as any).nodeBatch.nodes[0].outgoingEdges).toEqual(Array.from({ length: 20 }, () => ({ target: { id: override.id, content: 'CHILD OVERRIDE' } })));
  // Out-of-chain readable endpoints keep their own admission, rather than
  // being looked up by loc in the child's effective system memory.
  const external = await db.memory.create({ data: { organizationId: home.organizationId, class: 'knowledge', name: 'External', urn: 'oom2758.example:external' } });
  const externalNode = await createDbNode(db, { memoryId: external.id, loc: 'outside', content: 'EXTERNAL' });
  const hidden = await db.memory.create({ data: { organizationId: home.organizationId, class: 'personal', userId: (await db.user.create({ data: { handle: 'external-owner' } })).id, name: 'Hidden', urn: 'oom2758.example:external-hidden' } });
  const hiddenNode = await createDbNode(db, { memoryId: hidden.id, loc: 'hidden', content: 'NEVER_DISCLOSE' });
  await db.edge.createMany({ data: [externalNode, hiddenNode].map((target, i) => ({ id: generateId(), memoryId: base.memory.id, sourceId: a.id, targetId: target.id, loc: `outside:${i}` })) });
  const outside = await run('query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{target{id content}}}}}', { refs });
  expect(outside.errors).toBeUndefined();
  const targets = (outside.data as any).nodeBatch.nodes[0].outgoingEdges.map((edge: any) => edge.target);
  expect(targets).toContainEqual({ id: externalNode.id, content: 'EXTERNAL' });
  expect(targets).toHaveLength(21);
  expect(JSON.stringify(outside)).not.toContain('NEVER_DISCLOSE');
}, 60_000);
