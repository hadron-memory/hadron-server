/** #423: outgoing edge probes must have a source-leading index, independent of other tenants' edges. */
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';

const INDEX = 'edges_source_id_idx';

describe('#423 outgoing-edge source index', () => {
  it('has a valid source-leading index in the database catalog', async () => {
    const indexes = await db.$queryRaw<Array<{ name: string }>>`
      SELECT i.relname AS name FROM pg_index x
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
      WHERE n.nspname = 'public' AND t.relname = 'edges'
        AND a.attname = 'source_id' AND x.indisvalid AND x.indisready`;
    expect(indexes.map(i => i.name)).toContain(INDEX);
  });

  it('uses the index for by-source lookup and delete on a seeded table', async () => {
    class Rollback extends Error {}
    try {
      await db.$transaction(async tx => {
        // Synthetic index-only fixture: no user data or dependency graph is needed.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRawUnsafe(`INSERT INTO edges (id, memory_id, source_id, target_id, loc)
          SELECT 'idx423-' || g, 'idx423-memory', 'idx423-source-' || g, 'idx423-target', 'idx423:' || g
          FROM generate_series(1, 8000) g`);
        await tx.$executeRawUnsafe('ANALYZE edges');
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        for (const statement of [
          "SELECT id FROM edges WHERE source_id = 'idx423-source-4000'",
          "DELETE FROM edges WHERE source_id = 'idx423-source-4000'",
        ]) {
          const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${statement}`);
          const plan = rows.map(r => r['QUERY PLAN']).join('\n');
          expect(plan, plan).toContain(`Index Scan using ${INDEX}`);
        }
        throw new Rollback();
      }, { timeout: 30_000 });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
