/**
 * #451: the foreign-key columns on delete paths and tenant listings need an index led by the column.
 *
 * Without one, every node hard delete scans the append-only `usage_events` firehose to null `node_id`,
 * every agent or memory delete scans `sessions` to null `agent_id` / `memory_id`, and an org's agent
 * listing or org-delete cascade scans `agents`. (`sessions.user_id` is already led by
 * `sessions_user_id_started_at_idx` and is out of scope; the `organization_id` persona indexes are
 * partial and cannot serve a plain lookup.)
 *
 * Two checks per column: the catalog has a VALID, READY, non-partial index whose first column is it, and
 * the planner, with sequential and bitmap scans disabled, serves the FK action's own statement through
 * that index. EXPLAIN only: nothing is executed and no rows are seeded, so the plan check proves the
 * index can serve the predicate, not that the planner prefers it at production row counts.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';

const CASES = [
  {
    table: 'usage_events', column: 'node_id', index: 'usage_events_node_id_idx',
    // A node hard delete: ON DELETE SET NULL.
    statements: ["UPDATE usage_events SET node_id = NULL WHERE node_id = 'idx451-node'"],
  },
  {
    table: 'sessions', column: 'agent_id', index: 'sessions_agent_id_idx',
    // An agent delete: ON DELETE SET NULL.
    statements: ["UPDATE sessions SET agent_id = NULL WHERE agent_id = 'idx451-agent'"],
  },
  {
    table: 'sessions', column: 'memory_id', index: 'sessions_memory_id_idx',
    // A memory hard delete: ON DELETE SET NULL.
    statements: ["UPDATE sessions SET memory_id = NULL WHERE memory_id = 'idx451-memory'"],
  },
  {
    table: 'agents', column: 'organization_id', index: 'agents_organization_id_idx',
    // An org's agent listing, and the org delete: ON DELETE CASCADE.
    statements: [
      "SELECT id FROM agents WHERE organization_id = 'idx451-org'",
      "DELETE FROM agents WHERE organization_id = 'idx451-org'",
    ],
  },
] as const;

describe('#451 foreign-key columns on delete paths are indexed', () => {
  for (const c of CASES) {
    it(`${c.table}.${c.column} leads a valid, non-partial index (${c.index})`, async () => {
      const indexes = await db.$queryRaw<Array<{ name: string }>>`
        SELECT i.relname AS name FROM pg_index x
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
        WHERE n.nspname = 'public' AND t.relname = ${c.table} AND a.attname = ${c.column}
          AND x.indisvalid AND x.indisready AND x.indpred IS NULL`;
      expect(indexes.map(i => i.name)).toContain(c.index);
    });

    it(`${c.table}.${c.column}: the FK action is served by ${c.index}`, async () => {
      class Rollback extends Error {}
      try {
        await db.$transaction(async tx => {
          await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
          await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
          for (const statement of c.statements) {
            const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${statement}`);
            const plan = rows.map(r => r['QUERY PLAN']).join('\n');
            expect(plan, plan).toMatch(new RegExp(`Index (Only )?Scan using ${c.index} on ${c.table}`));
            expect(plan, plan).toContain(`Index Cond: (${c.column} = `);
          }
          throw new Rollback();
        }, { timeout: 30_000 });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }
    });
  }
});
