import { ApolloServer } from '@apollo/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

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
  vi.spyOn(db.node, 'findMany').mockImplementation(async (args: any) => {
    const rows = await original(args);
    materializedBytes += Buffer.byteLength(JSON.stringify(rows));
    return rows as any;
  });
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

it('a selected oversized edge projection refuses loudly instead of materializing unlimited endpoints', async () => {
  const a = await createDbNode(db, { memoryId, loc: 'a' });
  const b = await createDbNode(db, { memoryId, loc: 'b' });
  await db.edge.createMany({ data: Array.from({ length: 2001 }, (_, i) => ({ id: generateId(), memoryId, loc: `edge:${i}`, sourceId: a.id, targetId: b.id })) });
  const response = await run(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{id}}}}`, { refs: [a.id] });
  expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
});
