/** #3596 / ruling0229: flat fast arm without a descendant-sized chooser. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { readLocSegments, decodeLocSegmentsCursor } from './memoryLocSegments.js';

let memoryId: string;
const plans: any[] = [];
function nodes(plan: any): any[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
// Only fixture values enter EXECUTE; render literals explicitly because utility
// EXECUTE cannot forward the outer extended-protocol bind parameters.
function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]::text[]`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
  throw new Error('Unsupported prepared-probe fixture value');
}
const observe = (client: Pick<PrismaClient, '$queryRaw' | '$executeRawUnsafe' | '$queryRawUnsafe'>, generic = false) => ({
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = Prisma.sql(strings, ...values);
    if (generic) {
      await client.$executeRawUnsafe(`PREPARE loc3596_probe AS ${sql.text}`);
      try {
        await client.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_generic_plan');
        const execute = `EXECUTE loc3596_probe(${sql.values.map(literal).join(',')})`;
        const result: any = await client.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${execute}`);
        plans.push(result[0]['QUERY PLAN'][0]);
        const counters: any = await client.$queryRawUnsafe("SELECT generic_plans, custom_plans FROM pg_prepared_statements WHERE name = 'loc3596_probe'");
        expect(counters).toEqual([{ generic_plans: 1n, custom_plans: 0n }]);
        return await client.$queryRawUnsafe(execute);
      } finally {
        // An aborted EXECUTE transaction rejects DEALLOCATE too; preserve its primary error.
        await client.$executeRawUnsafe('DEALLOCATE loc3596_probe').catch(() => {});
      }
    }
    const result: any = await client.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    plans.push(result[0]['QUERY PLAN'][0]);
    return client.$queryRaw(sql);
  },
} as unknown as PrismaClient);
// Test oracle: retain the original skip-only path, with all other SQL unchanged.
const skipOnly = {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = Prisma.sql(strings, ...values);
    expect(sql.text.split('NOT EXISTS (')).toHaveLength(2);
    return db.$queryRawUnsafe(sql.text.replace('NOT EXISTS (', 'false AND NOT EXISTS ('), ...sql.values);
  },
} as unknown as PrismaClient;
function expectFlat(plan: any) {
  const all = nodes(plan.Plan);
  const walk = all.filter(n => n['Node Type'] === 'Recursive Union' && n['Subplan Name'] === 'CTE walk');
  expect(walk.length).toBeGreaterThan(0);
  expect(walk.every(n => n['Actual Rows'] === 0)).toBe(true);
  expect(all.some(n => /^flat_node(?:_\d+)?$/.test(n.Alias ?? '') && n['Actual Loops'] > 0)).toBe(true);
}
const observed = observe(db);
const wideExclusions = ['shadow3596', 'wide-shadow3596'];
const read = (parent: string) => readLocSegments(observed, { memoryIds: [memoryId], excludeNodeIds: wideExclusions, parent, limit: 20, after: null });

beforeAll(async () => {
  await cleanDb(db);
  memoryId = (await createDbOrgAndGraph(db, { orgName: 'hybrid3596', graphName: 'hybrid3596' })).graph.id;
  await db.$executeRaw`INSERT INTO nodes (id, memory_id, loc, name, node_type, seq, created_at, updated_at)
    SELECT 'flat3596-' || i, ${memoryId}, 'wide:n' || lpad(i::text, 6, '0'), 'flat', 'info', CASE WHEN i = 99999 THEN -10 END, now(), now()
    FROM generate_series(1, 100000) AS i`;
  await db.$executeRaw`INSERT INTO nodes (id, memory_id, loc, name, node_type, created_at, updated_at)
    SELECT 'deep3596-' || branch || '-' || i, ${memoryId}, 'deep:' || branch || ':leaf' || i, 'deep', 'info', now(), now()
    FROM unnest(ARRAY['alpha','beta']) AS branch CROSS JOIN generate_series(1, 8000) AS i`;
  await db.node.createMany({ data: [
    { id:'live3596', memoryId, loc:'filtered:live', name:'live' },
    { id:'deleted3596', memoryId, loc:'filtered:deleted:hidden', name:'deleted', deletedAt:new Date() },
    { id:'system3596', memoryId, loc:'filtered:system:hidden', name:'system', nodeType:'system' },
    { id:'shadow3596', memoryId, loc:'filtered:shadow:hidden', name:'shadow' },
    { id:'wide-deleted3596', memoryId, loc:'wide:n000500-deleted', name:'deleted', seq:-20, deletedAt:new Date() },
    { id:'wide-system3596', memoryId, loc:'wide:n000500-system', name:'system', seq:-20, nodeType:'system' },
    { id:'wide-shadow3596', memoryId, loc:'wide:n000500-shadow', name:'shadow', seq:-20 },
  ] });
  await db.$transaction(async tx => {
    await tx.node.create({ data:{ id:'comment3596', memoryId, loc:'filtered:comment:hidden', name:'comment', nodeType:'comment', content:'comment' } });
    await tx.commentMeta.create({ data:{ nodeId:'comment3596', targetNodeId:'flat3596-1', threadState:'OPEN', authorKey:'u:3596' } });
    await tx.edge.create({ data:{ memoryId, sourceId:'comment3596', targetId:'flat3596-1', loc:'filtered:comment-anchor', name:'comment-anchor', governedKind:'COMMENT_ANCHOR', anchorRevNo:1, anchorApprovalHash:'a'.repeat(64) } });
    await tx.node.create({ data:{ id:'wide-comment3596', memoryId, loc:'wide:n000500-comment', name:'comment', nodeType:'comment', content:'comment', seq:-20 } });
    await tx.commentMeta.create({ data:{ nodeId:'wide-comment3596', targetNodeId:'flat3596-1', threadState:'OPEN', authorKey:'u:3596-wide' } });
    await tx.edge.create({ data:{ memoryId, sourceId:'wide-comment3596', targetId:'flat3596-1', loc:'wide:comment-anchor', name:'comment-anchor', governedKind:'COMMENT_ANCHOR', anchorRevNo:1, anchorApprovalHash:'a'.repeat(64) } });
  });
  const other = (await createDbOrgAndGraph(db, { orgName:'other3596', graphName:'other3596' })).graph;
  await db.node.create({ data:{ id:'foreign3596', memoryId:other.id, loc:'filtered:foreign', name:'foreign' } });
  await db.node.create({ data:{ id:'wide-foreign3596', memoryId:other.id, loc:'wide:n000500-foreign', name:'foreign', seq:-20 } });
  await db.$executeRaw`ANALYZE nodes`;
}, 120_000);
afterAll(async () => { await cleanDb(db); }, 120_000);

describe('#3596 sibling-bounded hybrid', () => {
  it('a failed generic observation preserves its SQL error and leaves no prepared statement', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      await tx.$executeRawUnsafe('SAVEPOINT caller_control');
      let original: unknown;
      try {
        await observe(tx, true).$queryRaw`SELECT 1 / ${0}::int AS value`;
      } catch (error) { original = error; }
      expect(original).toMatchObject({ meta: { code: '22012' } });
      // Recover the caller's transaction, then inspect the SAME connection.
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT caller_control');
      const retained = await tx.$queryRawUnsafe<Array<{ name: string }>>(
        "SELECT name FROM pg_prepared_statements WHERE name = 'loc3596_probe'");
      try {
        expect(retained).toEqual([]);
        expect(await observe(tx, true).$queryRaw`SELECT ${7}::int AS value`).toEqual([{ value: 7 }]);
      } finally {
        // Baseline reproduction owns this name; never leave it in the pool.
        if (retained.length) await tx.$executeRawUnsafe('DEALLOCATE loc3596_probe');
      }
    }, { timeout: 15_000 });
  }, 30_000);

  it.each(['custom', 'generic'])('100k flat siblings avoid recursive probes and unrelated rows (%s plan)', async mode => {
    const page = mode === 'custom' ? await read('wide') : await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      return readLocSegments(observe(tx, true), { memoryIds:[memoryId], excludeNodeIds:wideExclusions, parent:'wide', limit:20, after:null });
    });
    expect(page.items.map(row => row.segment)).toEqual(['n099999', ...Array.from({length:19}, (_, i) => `n${String(i+1).padStart(6,'0')}`)]);
    expect(page.items.every(row => row.hasNode && row.memoryId === memoryId)).toBe(true);
    expect(page.hasMore).toBe(true);
    const plan = plans.at(-1);
    const recursiveRows = nodes(plan.Plan).filter(n => n['Node Type'] === 'Recursive Union' && n['Subplan Name'] === 'CTE walk').reduce((sum,n) => sum+n['Actual Rows'],0);
    expect(recursiveRows).toBe(0);
    const flatScans = nodes(plan.Plan).filter(n => /^flat_node(?:_\d+)?$/.test(n.Alias ?? ''));
    expect(flatScans.length).toBeGreaterThan(0);
    for (const scan of flatScans) {
      expect(scan['Index Name']).toBe('nodes_memory_segment_key_idx');
      expect(scan['Rows Removed by Filter'] ?? 0).toBeLessThanOrEqual(5);
      expect(scan['Actual Rows']).toBeLessThanOrEqual(1000);
    }
    const blocks = nodes(plan.Plan).find(n => n['Subplan Name'] === 'CTE flat_blocks');
    expect(blocks?.['Actual Rows']).toBeGreaterThan(0);
    expect(blocks?.['Actual Rows']).toBeLessThan(5000);
  }, 120_000);

  it('two deep segments do not scan their 16k descendants or unrelated wide siblings', async () => {
    const page = await read('deep');
    expect(page.items).toEqual(['alpha','beta'].map(segment => ({segment, hasNode:false, memoryId})));
    expect(page.hasMore).toBe(false);
    const plan = plans.at(-1);
    const scans = nodes(plan.Plan).filter(n => n['Relation Name'] === 'nodes');
    const work = scans.reduce((sum,n) => sum + ((n['Actual Rows']??0)+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*(n['Actual Loops']??0),0);
    expect(work).toBeLessThanOrEqual(12);
    const flatScans = scans.filter(n => /^flat_node(?:_\d+)?$/.test(n.Alias ?? ''));
    expect(flatScans.length).toBeGreaterThan(0);
    expect(flatScans.every(n => n['Actual Loops'] === 0)).toBe(true);
  }, 120_000);

  it('a generic prepared plan keeps the deep prefix range bounded before 100k unrelated rows', async () => {
    const page = await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      return readLocSegments(observe(tx, true), { memoryIds: [memoryId], excludeNodeIds: [], parent: 'deep', limit:20, after:null });
    });
    expect(page.items.map(row => row.segment)).toEqual(['alpha','beta']);
    const plan = plans.at(-1);
    const scans = nodes(plan.Plan).filter(n => n['Relation Name'] === 'nodes');
    const work = scans.reduce((sum,n) => sum + ((n['Actual Rows']??0)+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*(n['Actual Loops']??0),0);
    expect(work).toBeLessThanOrEqual(12);
  }, 120_000);


  it.each([false, true])('the flat arm retains memory, deletion, system/comment and inherited-shadow eligibility (generic %s)', async generic => {
    const args = { memoryIds:[memoryId], excludeNodeIds:['shadow3596'], parent:'filtered', limit:20, after:null };
    const page = generic ? await db.$transaction(tx => readLocSegments(observe(tx, true), args)) : await readLocSegments(observed, args);
    expect(page.items).toEqual([{segment:'live', hasNode:true, memoryId}]);
    expect(page.hasMore).toBe(false);
    expectFlat(plans.at(-1));
    const scans = nodes(plans.at(-1).Plan).filter(n => n['Relation Name'] === 'nodes');
    const examined = scans.reduce((sum, n) => sum + (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'], 0);
    expect(examined).toBeLessThanOrEqual(20);
  }, 120_000);

  it.each([64, 65, 128, 129])('pages %i flat siblings across block boundaries exactly once', async count => {
    const parent = `pages${count}`;
    await db.node.createMany({ data: Array.from({ length: count }, (_, i) => ({
      id: `pages3596-${count}-${i}`, memoryId, loc: `${parent}:n${String(i).padStart(3, '0')}`,
      name: 'page', seq: i === count - 1 ? -3 : i < 3 ? 3 - i : null,
    })) });
    await db.node.createMany({ data: [
      { id: `pages3596-${count}-deleted`, memoryId, loc: `${parent}:n063-deleted`, name: 'deleted', deletedAt: new Date(), seq: -20 },
      { id: `pages3596-${count}-system`, memoryId, loc: `${parent}:n064-system`, name: 'system', nodeType: 'system', seq: -20 },
    ] });
    const args = { memoryIds: [memoryId], excludeNodeIds: [], parent, limit: 7, after: null };
    const expected = await readLocSegments(skipOnly, { ...args, limit: 200 });
    const seen: Awaited<ReturnType<typeof readLocSegments>>['items'] = [];
    let after: ReturnType<typeof decodeLocSegmentsCursor> = null;
    let ended = false;
    for (let i = 0; i <= Math.ceil(count / args.limit); i++) {
      const page = await db.$transaction(async tx => {
        // A non-advancing block cursor must fail this pin without an unbounded query.
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return readLocSegments(observe(tx), { ...args, after });
      }, { timeout: 10_000 });
      expectFlat(plans.at(-1));
      seen.push(...page.items);
      if (!page.hasMore) { expect(page.endCursor).toBeNull(); ended = true; break; }
      expect(page.endCursor).not.toBeNull();
      after = decodeLocSegmentsCursor(page.endCursor!);
      expect(after).not.toBeNull();
    }
    expect(ended).toBe(true);
    expect(seen).toEqual(expected.items);
    expect(seen).toHaveLength(count);
    expect(new Set(seen.map(row => row.segment)).size).toBe(count);
  }, 120_000);

  it('pages two flat memories spanning multiple blocks identically to skip-only', async () => {
    const other = (await createDbOrgAndGraph(db, { orgName: 'pages-two3596', graphName: 'pages-two3596' })).graph.id;
    const memoryIds = [other, memoryId];
    await db.node.createMany({ data: memoryIds.flatMap((mid, m) => Array.from({ length: 129 }, (_, i) => ({
      id: `pages-two3596-${m}-${i}`, memoryId: mid, loc: `multipages:n${String(i).padStart(3, '0')}`,
      name: 'page', seq: i === 128 ? -5 : i === 64 ? 2 : null,
    }))) });
    const args = { memoryIds, excludeNodeIds: [], parent: 'multipages', limit: 31, after: null };
    async function collect(client: PrismaClient, checkPlan: boolean) {
      const seen: Awaited<ReturnType<typeof readLocSegments>>['items'] = [];
      let after: ReturnType<typeof decodeLocSegmentsCursor> = null;
      for (let i = 0; i < 10; i++) {
        const page = checkPlan ? await db.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          return readLocSegments(observe(tx), { ...args, after });
        }, { timeout: 10_000 }) : await readLocSegments(client, { ...args, after });
        if (checkPlan) expectFlat(plans.at(-1));
        seen.push(...page.items);
        if (!page.hasMore) { expect(page.endCursor).toBeNull(); return seen; }
        after = decodeLocSegmentsCursor(page.endCursor!);
        expect(after).not.toBeNull();
      }
      throw new Error('Multi-memory pagination did not terminate');
    }
    const expected = await collect(skipOnly, false);
    const seen = await collect(observed, true);
    expect(seen).toEqual(expected);
    expect(seen).toHaveLength(258);
    expect(new Set(seen.map(row => `${row.memoryId}:${row.segment}`)).size).toBe(258);
    for (const mid of memoryIds) expect(seen.filter(row => row.memoryId === mid)).toHaveLength(129);
  }, 120_000);

  it('one late eligible descendant rejects the flat arm after direct children', async () => {
    await db.node.createMany({ data: [
      { id: 'mixed3596-a', memoryId, loc: 'mixed:a', name: 'a' },
      { id: 'mixed3596-z', memoryId, loc: 'mixed:z:leaf', name: 'z' },
    ] });
    const args = { memoryIds: [memoryId], excludeNodeIds: [], parent: 'mixed', limit: 20, after: null };
    const page = await readLocSegments(observed, args);
    expect(page).toEqual(await readLocSegments(skipOnly, args));
    expect(page.items.map(row => [row.segment, row.hasNode])).toEqual([['a', true], ['z', false]]);
    const all = nodes(plans.at(-1).Plan);
    expect(all.some(n => n['Node Type'] === 'Recursive Union' && n['Subplan Name'] === 'CTE walk' && n['Actual Rows'] === 2)).toBe(true);
    const flat = all.filter(n => /^flat_node(?:_\d+)?$/.test(n.Alias ?? ''));
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every(n => n['Actual Loops'] === 0)).toBe(true);
  });

  it('root parents and one flat plus one deep memory agree with skip-only', async () => {
    const flatId = (await createDbOrgAndGraph(db, { orgName: 'root-flat3596', graphName: 'root-flat3596' })).graph.id;
    const deepId = (await createDbOrgAndGraph(db, { orgName: 'root-deep3596', graphName: 'root-deep3596' })).graph.id;
    await db.node.createMany({ data: [
      { id: 'root3596-a', memoryId: flatId, loc: 'a', name: 'a', seq: 2 },
      { id: 'root3596-b', memoryId: flatId, loc: 'b', name: 'b' },
      { id: 'root3596-c', memoryId: deepId, loc: 'a:leaf', name: 'a' },
      { id: 'root3596-d', memoryId: deepId, loc: 'c:leaf', name: 'c' },
    ] });
    for (const memoryIds of [[flatId], [deepId], [deepId, flatId]]) {
      const args = { memoryIds, excludeNodeIds: [], parent: '', limit: 20, after: null };
      const page = await readLocSegments(observed, args);
      expect(page).toEqual(await readLocSegments(skipOnly, args));
      if (memoryIds.length === 1 && memoryIds[0] === flatId) expectFlat(plans.at(-1));
      if (memoryIds.length === 2) {
        const all = nodes(plans.at(-1).Plan);
        expect(all.some(n => n['Node Type'] === 'Recursive Union' && n['Subplan Name'] === 'CTE walk' && n['Actual Rows'] > 0)).toBe(true);
        expect(all.some(n => /^flat_node(?:_\d+)?$/.test(n.Alias ?? '') && n['Actual Loops'] > 0)).toBe(true);
        expect(page.items).toHaveLength(4);
      }
    }
  });

  it('the database refuses a second node at the same memory and loc', async () => {
    await expect(db.node.create({ data: { id: 'duplicate3596', memoryId, loc: 'filtered:live', name: 'duplicate' } }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(await db.node.count({ where: { memoryId, loc: 'filtered:live' } })).toBe(1);
  });

});
