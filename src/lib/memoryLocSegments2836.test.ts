/**
 * #2836 (cor:api:090:05 rev 5, ruling 0229): loc segments leave out chat-message nodes like
 * findNodes, and stay sibling-bounded because the walk reads an eligible-row partial index.
 *
 * - Drift: the index's WHERE clause (migration and post-push.sql, byte for byte) is the walk's
 *   predicate, built from UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES plus comment. Adding a type to
 *   the default without a new index migration fails here.
 * - Reachability: EXPLAIN of the exact application query shows both walk legs scanning the
 *   partial index (a predicate the planner cannot prove would silently fall back to the full one).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('#2836 eligible-row index: both walk legs scan it', () => {
  let memoryId: string;

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

  it.each([['root', ''], ['a message-only branch', 'team-chat'], ['the messages prefix', 'team-chat:messages']])(
    '%s: every scan of nodes is an index scan of the eligible-row index, one per leg',
    async (_label, parent) => {
      const q = locSegmentsWalkSql({ memoryIds: [memoryId], excludeNodeIds: [], parent, limit: 20, after: null });
      // A cached prepared statement can switch to a GENERIC plan, planned without the bound values.
      // EXPLAIN (GENERIC_PLAN) (PG16+) plans the application's own $n text that way, so the pin holds
      // only if the predicate itself (the inlined literal) implies the index's; a bound list does not.
      // Prisma refuses $n text without values, so this goes over a raw connection on the per-worker DATABASE_URL.
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      let plan: PlanNode;
      try {
        plan = (await pg.query(`EXPLAIN (FORMAT JSON, GENERIC_PLAN) ${q.text}`)).rows[0]['QUERY PLAN'][0].Plan;
      } finally {
        await pg.end();
      }
      const nodes = flatten(plan);
      const scans = nodes.filter((n) => n['Relation Name'] === 'nodes');
      expect(scans).toHaveLength(2);
      for (const s of scans) {
        expect(s['Node Type']).toBe('Index Scan');
        expect(s['Index Name']).toBe(SEGMENT_ELIGIBLE_INDEX);
      }
      // The final ORDER BY sorts the few walk rows; a sort or bitmap OVER nodes would replace an Index Scan above.
      expect(nodes.some((n) => /Bitmap/.test(n['Node Type']))).toBe(false);
    },
  );
});
