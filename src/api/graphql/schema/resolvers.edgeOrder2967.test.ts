/**
 * #2967 — GraphQL edge order. `node`, `nodeBatch` and the run preview must agree, whatever the
 * physical insert order: display lists by loc then id (cor:api:040:01 parity), the run preview
 * resolves by priority, loc, id (cor:dmo:060:03), and over the batch edge budget both physical
 * orders fail loudly with no partial list (cor:api:040:02).
 */

import { ApolloServer } from '@apollo/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import * as batchRead from '../../../lib/batchRead.js';

let memoryId: string;
let userId: string;
let orgSlug: string;
let orgId: string;
let ids: { s: string; targets: Record<string, string>; sources: Record<string, string> };

const LETTERS = ['a', 'b', 'c', 'd', 'e'] as const;
const PRIORITY: Record<string, number> = { a: 3, b: 1, c: 2, d: 1, e: 0 };
const PRIORITY_ORDER = ['e', 'b', 'd', 'c', 'a'];

beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'edge2967.example', graphName: 'edgemem' });
  memoryId = graph.id;
  orgSlug = org.urn ?? 'edge2967.example';
  orgId = org.id;
  userId = (await db.user.create({ data: { handle: 'edge-probe' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const mk = (loc: string, extra: Record<string, unknown> = {}) =>
    db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `CONTENT-${loc}`, ...extra } });
  const s = await mk('ord:s', { content: 'Run body.' });
  const targets: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const l of LETTERS) { targets[l] = (await mk(`ord:t:${l}`)).id; sources[l] = (await mk(`ord:i:${l}`)).id; }
  ids = { s: s.id, targets, sources };
});
afterEach(() => vi.restoreAllMocks());

const ctx = (): Context => ({ db, userId, roles: ['READER'] });
async function run(query: string, variables: Record<string, unknown>) {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  try {
    const response = await api.executeOperation({ query, variables }, { contextValue: ctx() });
    if (response.body.kind !== 'single') throw new Error('unexpected response');
    return response.body.singleResult;
  } finally { await api.stop(); }
}

async function seedEdges(order: 'sorted' | 'reversed') {
  await db.edge.deleteMany({ where: { memoryId } });
  const rows = LETTERS.flatMap((l) => [
    { id: generateId(), memoryId, sourceId: ids.s, targetId: ids.targets[l], loc: `ord:s:out:${l}`, name: 'ref', priority: PRIORITY[l] },
    { id: generateId(), memoryId, sourceId: ids.sources[l], targetId: ids.s, loc: `ord:s:in:${l}`, name: 'ref', priority: PRIORITY[l] },
  ]);
  const byLoc = [...rows].sort((x, y) => (x.loc < y.loc ? -1 : 1));
  await db.edge.createMany({ data: order === 'sorted' ? byLoc : byLoc.reverse() });
}

const EDGES = `outgoingEdges { loc target { loc } } incomingEdges { loc source { loc } }`;
const letters = (edges: Array<{ loc: string }>) => edges.map((e) => e.loc.slice(-1));

it.each(['sorted', 'reversed'] as const)('node and nodeBatch list edges by loc then id and agree (inserted %s)', async (order) => {
  await seedEdges(order);
  const single = await run(`query($ref:ID!){ node(ref:$ref){ ${EDGES} } }`, { ref: ids.s });
  const batch = await run(`query($refs:[ID!]){ nodeBatch(refs:$refs){ nodes{ ${EDGES} } } }`, { refs: [ids.s] });
  expect(single.errors).toBeUndefined();
  expect(batch.errors).toBeUndefined();
  const a = (single.data as any).node;
  const b = (batch.data as any).nodeBatch.nodes[0];
  expect(letters(a.outgoingEdges)).toEqual([...LETTERS]);
  expect(letters(a.incomingEdges)).toEqual([...LETTERS]);
  expect(letters(b.outgoingEdges)).toEqual([...LETTERS]);
  expect(letters(b.incomingEdges)).toEqual([...LETTERS]);
});

it.each(['sorted', 'reversed'] as const)('over the edge budget both physical orders fail loudly with no partial list (inserted %s)', async (order) => {
  await seedEdges(order);
  vi.spyOn(batchRead, 'BATCH_READ_MAX_EDGES', 'get').mockReturnValue(7 as never);
  const response = await run(`query($refs:[ID!]){ nodeBatch(refs:$refs){ nodes{ ${EDGES} } } }`, { refs: [ids.s] });
  expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  expect(JSON.stringify(response.errors)).toContain('edges');
  // cor:api:040:02 (the Proposed edge-row bound, server#2770): a refused read carries no cut edge
  // list. `nodeBatch` is non-null, so the whole field nulls into `data`; no node, no edges.
  expect(response.data ?? null).toBeNull();
  expect(JSON.stringify(response)).not.toContain('ord:s:out:');
  expect(JSON.stringify(response)).not.toContain('ord:s:in:');
});

it.each(['sorted', 'reversed'] as const)('renderRunNode resolves referenced nodes by priority, loc, id (inserted %s)', async (order) => {
  await seedEdges(order);
  const response = await run(`query($ref:String!){ renderRunNode(nodeRef:$ref) }`, { ref: `hrn:node:${orgSlug}:edgemem:ord:s` });
  expect(response.errors).toBeUndefined();
  const text = (response.data as any).renderRunNode as string;
  expect([...text.matchAll(/CONTENT-ord:t:(\w)/g)].map((m) => m[1])).toEqual(PRIORITY_ORDER);
});

it.each(['sorted', 'reversed'] as const)('runTask (render-only) bundles referenced nodes by priority, loc, id (inserted %s)', async (order) => {
  await seedEdges(order);
  // Priority disagrees with loc (loc order is a..e, priority order is e,b,d,c,a); b and d tie on priority.
  const response = await run(`mutation($ref:String!){ runTask(nodeRef:$ref) }`, { ref: `hrn:node:${orgSlug}:edgemem:ord:s` });
  expect(response.errors).toBeUndefined();
  const text = (response.data as any).runTask as string;
  expect([...text.matchAll(/CONTENT-ord:t:(\w)/g)].map((m) => m[1])).toEqual(PRIORITY_ORDER);
});

it.each(['low-first', 'high-first'] as const)('equal-loc incoming edges from two memories order by id (inserted %s)', async (insert) => {
  // Edge is unique on (loc, memoryId) with memoryId the SOURCE memory's, so an equal loc is only
  // reachable across source memories, i.e. for incoming edges. Same loc, same priority: only id decides.
  const other = await db.memory.create({
    data: { id: generateId(), organizationId: orgId, urn: 'edge2967.example:othermem', name: 'othermem', class: 'knowledge' },
  });
  const foreign = await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'ord:foreign', name: 'foreign', content: 'x' } });
  const [lo, hi] = [generateId(), generateId()].sort();
  const mine = { id: hi, memoryId, sourceId: ids.sources.a, targetId: ids.s, loc: 'ord:tie', name: 'ref', priority: 0 };
  const theirs = { id: lo, memoryId: other.id, sourceId: foreign.id, targetId: ids.s, loc: 'ord:tie', name: 'ref', priority: 0 };
  await db.edge.deleteMany({ where: { memoryId: { in: [memoryId, other.id] } } });
  // Physical insert order opposes the expected order in the 'high-first' case, matches it otherwise.
  for (const e of insert === 'high-first' ? [mine, theirs] : [theirs, mine]) await db.edge.create({ data: e });
  const single = await run(`query($ref:ID!){ node(ref:$ref){ incomingEdges { id loc } } }`, { ref: ids.s });
  expect(single.errors).toBeUndefined();
  expect((single.data as any).node.incomingEdges.map((e: { id: string }) => e.id)).toEqual([lo, hi]);
  const batch = await run(`query($refs:[ID!]){ nodeBatch(refs:$refs){ nodes{ incomingEdges { id loc } } } }`, { refs: [ids.s] });
  expect(batch.errors).toBeUndefined();
  expect((batch.data as any).nodeBatch.nodes[0].incomingEdges.map((e: { id: string }) => e.id)).toEqual([lo, hi]);
});
