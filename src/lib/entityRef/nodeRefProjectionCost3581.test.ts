/**
 * #3581 (b) — MEASUREMENT ONLY. resolveNodeRef rebuilds `projectedAddresses` (a Map over every projected node) on each call
 * (src/lib/entityRef/nodeRef.ts). This records what that costs against the database work the same call does, for a subtree
 * of N nodes and T unresolved relative targets. It authorizes no index, cache or resolver change: any follow-up re-gates
 * (T1) on this evidence. Timings are recorded, never asserted (they depend on the host); the test asserts only that every
 * call answers the same with and without the projection, so the measurement is of equal work.
 *
 * Method: T calls of resolveNodeRef for a relative target that resolves nowhere, (a) with no projection, (b) with a projection of
 * N nodes elsewhere. Same query count; the difference is the projection's own cost. Medians of 5 rounds, ms (a one-round smoke when HADRON_MEASURE_3581 is not 1).
 * Also the end-to-end plan time for a subtree of N nodes whose contents link to N distinct unresolved targets.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { NodeNotFoundError } from './errors.js';
import { resolveNodeRef, type NodeRefProjection } from './nodeRef.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
/** CI runs a small smoke so the harness cannot rot; the full measurement is `HADRON_MEASURE_3581=1 pnpm vitest run <this file>`. */
const FULL = process.env.HADRON_MEASURE_3581 === '1';
const results: Record<string, unknown>[] = [];
afterAll(() => {
  if (process.env.HADRON_OBSERVER_OUT) { mkdirSync(process.env.HADRON_OBSERVER_OUT, { recursive: true }); writeFileSync(`${process.env.HADRON_OBSERVER_OUT}/3581-measure.json`, JSON.stringify(results, null, 2)); }
});
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
let memoryId: string;
beforeEach(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db, { orgName: 'cost3581', graphName: 'm', visibility: 'PUBLIC' })).graph.id;
});

function projectionOf(n: number, elsewhere: string): NodeRefProjection {
  return { nodes: new Map(Array.from({ length: n }, (_, i) => [`p${i}`, { memoryId: elsewhere, loc: `moved:${i}` }])), aliases: new Map() };
}
async function timeCalls(t: number, projection?: NodeRefProjection): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < t; i++) {
    await resolveNodeRef(db, `nowhere:${i}`, memoryId, { projection }).then(() => { throw new Error('resolved'); }, (e) => { if (!(e instanceof NodeNotFoundError)) throw e; });
  }
  return performance.now() - t0;
}

describe('#3581 (b) the per-call projection rebuild, measured', () => {
  it('records the per-call cost of a projection of N nodes against the no-projection baseline (T = 200 calls)', async () => {
    const T = FULL ? 200 : 5;
    const rows: Record<string, number>[] = [];
    await timeCalls(20); // warm the connection and the query plans
    for (const n of FULL ? [100, 1000, 5000, 20000] : [10]) {
      const base: number[] = []; const proj: number[] = [];
      for (let r = 0; r < (FULL ? 5 : 1); r++) { base.push(await timeCalls(T)); proj.push(await timeCalls(T, projectionOf(n, generateId()))); }
      rows.push({ projectedNodes: n, calls: T, noProjectionMs: Math.round(median(base)), withProjectionMs: Math.round(median(proj)), extraMsPerCall: Math.round((median(proj) - median(base)) / T * 1000) / 1000 });
    }
    results.push({ kind: 'per-call rebuild', rows });
    expect(rows).toHaveLength(FULL ? 4 : 1);
  }, 300_000);

  it('records the end-to-end plan time for a subtree of N nodes linking N distinct unresolved targets (cross-memory)', async () => {
    const dest = (await createDbOrgAndGraph(db, { orgName: 'costd3581', graphName: 'd', visibility: 'PUBLIC' })).graph;
    const user = await db.user.create({ data: { githubId: 35810, githubUsername: 'cost3581', roles: ['ADMIN'] } });
    const ctx = { db, userId: user.id, roles: ['ADMIN'] } as Context;
    const rows: Record<string, number>[] = [];
    for (const n of FULL ? [50, 200, 800] : [20]) {
      await db.node.deleteMany({ where: { memoryId } });
      const root = await db.node.create({ data: { id: generateId(), memoryId, loc: `big${n}`, name: 'root', content: '[[nowhere:root]]' } });
      // Locs are two-level (`big:<i>`) so a relative target `unresolved:<i>` is a short loc, as an author writes it.
      await db.node.createMany({ data: Array.from({ length: n - 1 }, (_, i) => ({ id: generateId(), memoryId, loc: `big${n}:c${i}`, name: `c${i}`, content: `[[unresolved:${i}]]` })) });
      const t0 = performance.now();
      const plan = await M.planNodeMove(null, { sourceRef: root.id, targetMemoryRef: dest.id }, ctx);
      const ms = Math.round(performance.now() - t0);
      expect(plan.totalCount).toBe(n);
      rows.push({ subtreeNodes: n, distinctTargets: n, planMs: ms, msPerTarget: Math.round(ms / n * 100) / 100 });
    }
    results.push({ kind: 'end-to-end plan', rows });
    expect(rows).toHaveLength(FULL ? 3 : 1);
  }, 300_000);
});
