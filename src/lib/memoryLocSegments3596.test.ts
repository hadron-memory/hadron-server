/** #3596 / ruling0229: flat fast arm without a descendant-sized chooser. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { readLocSegments } from './memoryLocSegments.js';

let memoryId: string;
const plans: any[] = [];
function nodes(plan: any): any[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
const observe = (client: Pick<PrismaClient, '$queryRaw'>) => ({
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = Prisma.sql(strings, ...values);
    const result: any = await client.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    plans.push(result[0]['QUERY PLAN'][0]);
    return client.$queryRaw(sql);
  },
} as unknown as PrismaClient);
const observed = observe(db);
const read = (parent: string) => readLocSegments(observed, { memoryIds: [memoryId], excludeNodeIds: [], parent, limit: 20, after: null });

beforeAll(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db, { orgName: 'hybrid3596', graphName: 'hybrid3596' })).graph.id;
  await db.$executeRaw`INSERT INTO nodes (id, memory_id, loc, name, node_type, created_at, updated_at)
    SELECT 'flat3596-' || i, ${memoryId}, 'wide:n' || lpad(i::text, 6, '0'), 'flat', 'info', now(), now()
    FROM generate_series(1, 100000) AS i`;
  await db.$executeRaw`INSERT INTO nodes (id, memory_id, loc, name, node_type, created_at, updated_at)
    SELECT 'deep3596-' || branch || '-' || i, ${memoryId}, 'deep:' || branch || ':leaf' || i, 'deep', 'info', now(), now()
    FROM unnest(ARRAY['alpha','beta']) AS branch CROSS JOIN generate_series(1, 8000) AS i`;
  await db.node.createMany({ data: [
    { id:'live3596', memoryId, loc:'filtered:live', name:'live' },
    { id:'deleted3596', memoryId, loc:'filtered:deleted', name:'deleted', deletedAt:new Date() },
    { id:'system3596', memoryId, loc:'filtered:system', name:'system', nodeType:'system' },
    { id:'shadow3596', memoryId, loc:'filtered:shadow', name:'shadow' },
  ] });
  await db.$transaction(async tx => {
    await tx.node.create({ data:{ id:'comment3596', memoryId, loc:'filtered:comment', name:'comment', nodeType:'comment', content:'comment' } });
    await tx.commentMeta.create({ data:{ nodeId:'comment3596', targetNodeId:'flat3596-1', threadState:'OPEN', authorKey:'u:3596' } });
    await tx.edge.create({ data:{ memoryId, sourceId:'comment3596', targetId:'flat3596-1', loc:'filtered:comment-anchor', name:'comment-anchor', governedKind:'COMMENT_ANCHOR', anchorRevNo:1, anchorApprovalHash:'a'.repeat(64) } });
  });
  const other = (await createDbOrgAndGraph(db, { orgName:'other3596', graphName:'other3596' })).graph;
  await db.node.create({ data:{ id:'foreign3596', memoryId:other.id, loc:'filtered:foreign', name:'foreign' } });
  await db.$executeRaw`ANALYZE nodes`;
}, 120_000);
afterAll(async () => { await cleanDb(db); }, 120_000);

describe('#3596 sibling-bounded hybrid', () => {
  it.each(['custom', 'generic'])('100k flat siblings avoid recursive probes and unrelated rows (%s plan)', async mode => {
    const page = mode === 'custom' ? await read('wide') : await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      return readLocSegments(observe(tx), { memoryIds:[memoryId], excludeNodeIds:[], parent:'wide', limit:20, after:null });
    });
    expect(page.items.map(row => row.segment)).toEqual(Array.from({length:20}, (_, i) => `n${String(i+1).padStart(6,'0')}`));
    expect(page.items.every(row => row.hasNode && row.memoryId === memoryId)).toBe(true);
    expect(page.hasMore).toBe(true);
    const plan = plans.at(-1);
    const recursiveRows = nodes(plan.Plan).filter(n => n['Node Type'] === 'Recursive Union').reduce((sum,n) => sum+n['Actual Rows'],0);
    console.log('3596 flat 100k execution ms', plan['Execution Time'], 'recursive rows', recursiveRows);
    expect(recursiveRows).toBeLessThanOrEqual(1);
    const flatScan = nodes(plan.Plan).find(n => n.Alias === 'flat_node');
    expect(flatScan?.['Index Name']).toBe('nodes_memory_segment_key_idx');
    expect(flatScan?.['Rows Removed by Filter'] ?? 0).toBe(0);
  }, 120_000);

  it('two deep segments do not scan their 16k descendants or unrelated wide siblings', async () => {
    const page = await read('deep');
    expect(page.items).toEqual(['alpha','beta'].map(segment => ({segment, hasNode:false, memoryId})));
    expect(page.hasMore).toBe(false);
    const plan = plans.at(-1);
    const scans = nodes(plan.Plan).filter(n => n['Relation Name'] === 'nodes');
    const work = scans.reduce((sum,n) => sum + ((n['Actual Rows']??0)+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*(n['Actual Loops']??0),0);
    console.log('3596 deep execution ms', plan['Execution Time'], 'examined node rows', work);
    expect(work).toBeLessThanOrEqual(12);
    const flatScans = scans.filter(n => n.Alias === 'flat_node');
    expect(flatScans.every(n => n['Actual Loops'] === 0)).toBe(true);
  }, 120_000);

  it('a generic prepared plan keeps the deep prefix range bounded before 100k unrelated rows', async () => {
    const page = await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      return readLocSegments(observe(tx), { memoryIds: [memoryId], excludeNodeIds: [], parent: 'deep', limit:20, after:null });
    });
    expect(page.items.map(row => row.segment)).toEqual(['alpha','beta']);
    const plan = plans.at(-1);
    const scans = nodes(plan.Plan).filter(n => n['Relation Name'] === 'nodes');
    const work = scans.reduce((sum,n) => sum + ((n['Actual Rows']??0)+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*(n['Actual Loops']??0),0);
    expect(work).toBeLessThanOrEqual(12);
  }, 120_000);


  it('the flat arm retains memory, deletion, system/comment and inherited-shadow eligibility', async () => {
    const page = await readLocSegments(observed, { memoryIds:[memoryId], excludeNodeIds:['shadow3596'], parent:'filtered', limit:20, after:null });
    expect(page.items).toEqual([{segment:'live', hasNode:true, memoryId}]);
    expect(page.hasMore).toBe(false);
  }, 120_000);

});
