/**
 * #2836 (cor:api:090:05 rev 5, ruling 0229): loc segments leave out chat-message nodes like
 * findNodes, and stay sibling-bounded because the walk reads an eligible-row partial index.
 *
 * - Drift: the index's WHERE clause (migration and post-push.sql, byte for byte) is the walk's
 *   predicate, built from UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES plus comment. Adding a type to
 *   the default without a new index migration fails here.
 * - Reachability: EXPLAIN of the exact application query, with the full index out of the planner's
 *   choice, shows every leg scanning the partial index. A predicate the planner cannot prove fails
 *   here. Which index it PREFERS is not pinned: that follows the index's density across the table
 *   (#3650). memoryLocSegments3596.test.ts observes the choice on a populated table.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';
import { UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES } from './retrieval/defaultNodeTypes.js';
import {
  SEGMENT_ELIGIBLE_INDEX,
  SEGMENT_INELIGIBLE_NODE_TYPES,
  locSegmentsWalkSql,
  segmentEligibleSql,
} from './memoryLocSegments.js';

const root = new URL('../../prisma/', import.meta.url);
const statementOf = (sql: string): string => {
  const m = sql.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${SEGMENT_ELIGIBLE_INDEX}\\b[^;]*;`));
  if (!m) throw new Error(`no ${SEGMENT_ELIGIBLE_INDEX} statement`);
  return m[0];
};

describe('#2836 eligible-row index: lockstep and list drift', () => {
  const migration = statementOf(readFileSync(new URL('migrations/20261106050000_nodes_segment_key_eligible_index/migration.sql', root), 'utf8'));
  const postPush = statementOf(readFileSync(new URL('post-push.sql', root), 'utf8'));

  it('the migration and post-push.sql carry the identical statement', () => {
    expect(postPush).toBe(migration);
  });

  it('the index WHERE clause is the walk predicate, built from the shared default list plus comment', () => {
    expect(SEGMENT_INELIGIBLE_NODE_TYPES).toEqual([...UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES, 'comment']);
    expect(migration).toContain(`ON nodes (memory_id, ((replace(loc, ':', chr(1))) COLLATE "C"))`);
    expect(migration.endsWith(`WHERE ${segmentEligibleSql()};`)).toBe(true);
    expect(segmentEligibleSql('n')).toBe(segmentEligibleSql().replace(/\b(deleted_at|node_type|loc) /g, 'n.$1 '));
  });
});

/** server_version_num of PostgreSQL 16.0, the first release with EXPLAIN (GENERIC_PLAN). */
const MIN_GENERIC_PLAN_VERSION_NUM = 160000;

/** The churn is 20k inserts and a DELETE: on a busy shard that exceeds the default 10s hook budget. */
const CHURN_HOOK_TIMEOUT_MS = 60_000;

describe('#2836 eligible-row index: both walk legs scan it', () => {
  let memoryId: string;

  // #3650: earlier files in a worker leave the partial index mostly empty pages (cleanDb DELETEs, VACUUM keeps
  // the pages, and REINDEX keeps dead entries while any transaction is open on the server). Three live rows
  // under those pages price it above the full index, whatever the query says. The churn makes that history the
  // fixture's own, so this file cannot pass only because it ran first in its worker.
  beforeAll(async () => {
    await cleanDb(db);
    const churn = ((await createDbOrgAndGraph(db, { orgName: 'seg-2836-churn', graphName: 'seg2836/churn' })).graph as { id: string }).id;
    await db.$executeRaw`
      INSERT INTO nodes (id, memory_id, loc, name, updated_at)
      SELECT 'churn-' || g, ${churn}, 'churn:' || lpad(g::text, 6, '0'), 'n', now() FROM generate_series(1, 20000) g`;
    await db.$executeRaw`DELETE FROM nodes WHERE memory_id = ${churn}`;
  }, CHURN_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await cleanDb(db);
    memoryId = ((await createDbOrgAndGraph(db, { orgName: 'seg-2836', graphName: 'seg2836/m' })).graph as { id: string }).id;
    const base = { memoryId, name: 'n' };
    await db.node.createMany({
      data: [
        { ...base, id: generateId(), loc: 'doc' },
        { ...base, id: generateId(), loc: 'team-chat', nodeType: 'chat' },
        { ...base, id: generateId(), loc: 'zz' },
        ...Array.from({ length: 3000 }, (_, i) => ({
          ...base, id: generateId(), loc: `team-chat:messages:${String(i).padStart(5, '0')}`, nodeType: 'chat-message', seq: i + 1,
        })),
      ],
    });
    await db.$executeRawUnsafe('ANALYZE nodes');
  });

  type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
  const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

  it.for([['root', ''], ['a message-only branch', 'team-chat'], ['the messages prefix', 'team-chat:messages']] as const)(
    '%s: every scan of nodes is an index scan of the eligible-row index, chooser, walk legs and flat blocks',
    async ([, parent], ctx) => {
      // EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16+, but README.md advertises PostgreSQL 15+ (#3639).
      // Below 16 this pin is SKIPPED, visibly, rather than failing or being replaced by an observer
      // whose plans were never compared with GENERIC_PLAN's. Hosted CI (16) and compose (17) run it.
      const versionClient = new Client({ connectionString: process.env.DATABASE_URL });
      await versionClient.connect();
      let serverVersionNum: number;
      try {
        serverVersionNum = Number((await versionClient.query('SHOW server_version_num')).rows[0].server_version_num);
      } finally {
        await versionClient.end();
      }
      if (serverVersionNum < MIN_GENERIC_PLAN_VERSION_NUM) {
        ctx.skip(`EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16+; this server is ${serverVersionNum}`);
      }
      const q = locSegmentsWalkSql({ memoryIds: [memoryId], excludeNodeIds: [], parent, limit: 20, after: null });
      // A cached prepared statement can switch to a GENERIC plan, planned without the bound values.
      // EXPLAIN (GENERIC_PLAN) (PG16+) plans the application's own $n text that way, so the pin holds
      // only if the predicate itself (the inlined literal) implies the index's; a bound list does not.
      // Prisma refuses $n text without values, so this goes over a raw connection on the per-worker DATABASE_URL.
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      let plan: PlanNode;
      try {
        // Reachability, independent of density: only the partial index can serve this ORDER BY here, so a
        // predicate that does not imply its WHERE clause leaves a seq scan or a sort, and the checks below fail.
        await pg.query('BEGIN');
        await pg.query('DROP INDEX IF EXISTS nodes_memory_segment_key_idx');
        await pg.query('SET LOCAL enable_seqscan = off');
        await pg.query('SET LOCAL enable_sort = off');
        await pg.query('SET LOCAL enable_bitmapscan = off');
        plan = (await pg.query(`EXPLAIN (FORMAT JSON, GENERIC_PLAN) ${q.text}`)).rows[0]['QUERY PLAN'][0].Plan;
      } finally {
        await pg.query('ROLLBACK').catch(() => {});
        await pg.end();
      }
      const scans = flatten(plan).filter((n) => n['Relation Name'] === 'nodes');
      // Hybrid: chooser + two skip legs + flat seed/continuation; every site must use the eligible index.
      expect(scans).toHaveLength(5);
      for (const s of scans) {
        expect(s['Node Type']).toBe('Index Scan');
        expect(s['Index Name']).toBe(SEGMENT_ELIGIBLE_INDEX);
      }
    },
  );
});
