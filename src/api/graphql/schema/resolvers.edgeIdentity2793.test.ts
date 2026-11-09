/** #2793(a): identity-only endpoint reads stay narrow without changing projection or gates. */
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
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'identity2793.example', graphName: 'fixture' });
  memoryId = graph.id;
  userId = (await db.user.create({ data: { handle: 'identity2793' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
});
afterEach(() => vi.restoreAllMocks());
const context = (): Context => ({ db, userId, roles: ['READER'] });
async function execute(query: string, variables: Record<string, unknown>) {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  try {
    const r = await api.executeOperation({ query, variables }, { contextValue: context() });
    if (r.body.kind !== 'single') throw new Error('unexpected response');
    expect(r.body.singleResult.errors).toBeUndefined();
    return r.body.singleResult.data as any;
  } finally { await api.stop(); }
}
async function run(selection: string, refs: string[], suffix = '') {
  return (await execute(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{id outgoingEdges{source{${selection}} target{${selection}}}}}} ${suffix}`, { refs })).nodeBatch.nodes;
}
async function pair() {
  const a = await createDbNode(db, { memoryId, loc: 'a', name: 'A', content: 'alpha' });
  const b = await createDbNode(db, { memoryId, loc: 'b', name: 'B', content: 'bravo' });
  await db.edge.create({ data: { memoryId, loc: 'a-b', sourceId: a.id, targetId: b.id } });
  return { a, b };
}

it('does not materialize large distinct/repeated endpoint bodies for id-only reads', async () => {
  const parent = await createDbNode(db, { memoryId, loc: 'parent' });
  const targets = Array.from({ length: 12 }, (_, i) => ({ id: generateId(), memoryId, loc: `target:${i}`, name: `T${i}`, content: 'x'.repeat(128 * 1024) }));
  await db.node.createMany({ data: targets });
  await db.edge.createMany({ data: targets.flatMap(t => [0, 1].map(j => ({ id: generateId(), memoryId, loc: `edge:${t.loc}:${j}`, sourceId: parent.id, targetId: t.id }))) });
  const original = db.node.findUnique.bind(db.node);
  let bytes = 0;
  const reads: Promise<unknown>[] = [];
  vi.spyOn(db.node, 'findUnique').mockImplementation(((args: any) => {
    const pending = original(args).then(row => { bytes += Buffer.byteLength(JSON.stringify(row)); return row; });
    reads.push(pending);
    return pending;
  }) as typeof db.node.findUnique);
  const nodes = await run('id', [parent.id]);
  const responseBytes = bytes;
  await Promise.all(reads);
  expect(nodes[0].outgoingEdges).toHaveLength(24);
  expect(nodes[0].outgoingEdges.map((e: any) => e.target.id).sort()).toEqual(targets.flatMap(t => [t.id, t.id]).sort());
  // Measured returned row bytes, not an RSS/heap ceiling. Check both at response and after all started reads.
  expect(responseBytes).toBeLessThan(64 * 1024);
  expect(bytes).toBeLessThan(64 * 1024);
}, 30_000);

it.each(['id', 'id loc name', 'id content'])('preserves exact source/target output: %s', async selection => {
  const { a, b } = await pair();
  const project = (n: typeof a) => Object.fromEntries(selection.split(' ').map(k => [k, (n as any)[k]]));
  const nodes = await run(selection, [a.id]);
  expect(nodes).toEqual([{ id: a.id, outgoingEdges: [{ source: project(a), target: project(b) }] }]);
});

it('keeps identity and body aliases distinct even when endpoint IDs repeat', async () => {
  const { a, b } = await pair();
  const nodes = await run('identity:id ...Identity body:content', [a.id], 'fragment Identity on Node { loc name }');
  expect(nodes[0].outgoingEdges[0].target).toEqual({ identity: b.id, loc: 'b', name: 'B', body: 'bravo' });
});

it('handles aliases/named/inline fragments and merged endpoint selections without loading bodies', async () => {
  const { a, b } = await pair();
  const original = db.node.findUnique.bind(db.node);
  const rows: unknown[] = [];
  vi.spyOn(db.node, 'findUnique').mockImplementation((async (args: any) => { const row = await original(args); rows.push(row); return row; }) as typeof db.node.findUnique);
  const nodes = await run('key:id ...Identity ... on Node { name }', [a.id], 'fragment Identity on Node { loc }');
  expect(nodes[0].outgoingEdges[0].target).toEqual({ key: b.id, loc: 'b', name: 'B' });
  expect(rows.filter((r: any) => r?.id === b.id).every((r: any) => !Object.hasOwn(r, 'content'))).toBe(true);
});

it.each(['id loc name', 'id content'])('keeps unreadable/deleted endpoints null: %s', async selection => {
  const { a, b } = await pair();
  const outsider = await db.user.create({ data: { handle: 'other2793' } });
  const home = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
  const hidden = await db.memory.create({ data: { organizationId: home.organizationId, urn: 'identity2793.example:hidden', name: 'Hidden', class: 'personal', userId: outsider.id } });
  const secret = await createDbNode(db, { memoryId: hidden.id, loc: 'secret', content: 'NEVER_DISCLOSE' });
  await db.edge.create({ data: { memoryId, loc: 'cross', sourceId: a.id, targetId: secret.id } });
  await db.node.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
  const nodes = await run(selection, [a.id]);
  expect(nodes[0].outgoingEdges).toHaveLength(2);
  expect(nodes[0].outgoingEdges.map((e: any) => e.target)).toEqual([null, null]);
  expect(JSON.stringify(nodes)).not.toContain('NEVER_DISCLOSE');
});

it('separates simultaneous identity/body aliases and unions merged fields', async () => {
  const { a, b } = await pair();
  const result = await execute(`query($refs:[ID!]){nodeBatch(refs:$refs){nodes{outgoingEdges{
    small:target{id} large:target{id content} merged:target{id} merged:target{content}
  }}}}`, { refs: [a.id] });
  expect(result.nodeBatch.nodes[0].outgoingEdges[0]).toEqual({ small: { id: b.id }, large: { id: b.id, content: 'bravo' }, merged: { id: b.id, content: 'bravo' } });
});

it.each(['id loc name', 'id content'])('keeps child-effective inherited endpoints: %s', async selection => {
  const home = await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { organizationId: true } });
  const create = (resolvers.Mutation as any).createAgent;
  const c = context();
  const base = await create({}, { orgId: home.organizationId, name: 'Base2793' }, c);
  const child = await create({}, { orgId: home.organizationId, name: 'Child2793' }, c);
  await db.agent.update({ where: { id: child.id }, data: { extendsAgentId: base.id } });
  const baseMemory = (await db.agent.findUniqueOrThrow({ where: { id: base.id } })).systemMemoryId!;
  const childMemory = (await db.agent.findUniqueOrThrow({ where: { id: child.id } })).systemMemoryId!;
  const a = await createDbNode(db, { memoryId: baseMemory, loc: 'a', name: 'A', content: 'alpha' });
  const b = await createDbNode(db, { memoryId: baseMemory, loc: 'b', name: 'Base B', content: 'base' });
  const override = await createDbNode(db, { memoryId: childMemory, loc: 'b', name: 'Child B', content: 'override' });
  await db.edge.create({ data: { memoryId: baseMemory, loc: 'a-b', sourceId: a.id, targetId: b.id } });
  const result = await execute(`query($memory:ID!){nodeBatch(memory:$memory,locPrefix:"a"){nodes{outgoingEdges{target{${selection}}}}}}`, { memory: childMemory });
  const expected = Object.fromEntries(selection.split(' ').map(k => [k, (override as any)[k]]));
  expect(result.nodeBatch.nodes[0].outgoingEdges).toEqual([{ target: expected }]);
});
