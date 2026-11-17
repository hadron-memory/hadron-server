/**
 * #3315 private parent-loc index experiment. Run: pnpm tsx scripts/db/children-parent-plan3315.ts
 * Creates and drops ONLY its random local database, never dev/prod or a caller-named database.
 * Minimal nodes table, not a full migration-chain test. Default planner settings: no forced index plan.
 * Results describe this synthetic layout/cache/hardware only, not production cost or an upper bound.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { maintenanceUrl } from '../../src/test/dbWorkers.js';
import { PARENT_LOC_SQL } from '../../src/lib/childLoc.js';

const maintenance = new URL(maintenanceUrl());
if (!['localhost', '127.0.0.1', '[::1]'].includes(maintenance.hostname)) {
  throw new Error('Private plan experiment requires loopback Postgres');
}
const database = `parent_plan_3315_${randomBytes(8).toString('hex')}`;
const admin = new Client({ connectionString: maintenance.toString() });
const url = new URL(maintenance);
url.pathname = `/${database}`;
const client = new Client({ connectionString: url.toString() });
let created = false;
let connected = false;
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await client.connect();
  connected = true;
  await client.query('CREATE TABLE nodes (memory_id text NOT NULL, loc text NOT NULL, payload text NOT NULL)');
  // 33,240 rows per memory: root=40, deep sparse=25, wide=2,000, unrelated=31,175.
  // Each scenario rebuilds heap order while preserving the exact same logical dataset.
  await client.query(`CREATE TEMP TABLE dataset AS
    SELECT m::text AS memory_id, CASE
      WHEN i <= 40 THEN 'root' || i
      WHEN i <= 65 THEN 'deep:sparse:parent:child' || i
      WHEN i <= 2065 THEN 'wide:child' || i
      ELSE 'noise:branch' || i || ':child' END AS loc,
      repeat('x', 256) AS payload
    FROM generate_series(1, 2) m CROSS JOIN generate_series(1, 33240) i`);
  const ddl = readFileSync(new URL('../../prisma/migrations/20261030100000_nodes_parent_loc_index/migration.sql', import.meta.url), 'utf8');
  const results: unknown[] = [];
  for (const layout of ['clustered', 'scattered'] as const) {
    await client.query('TRUNCATE nodes');
    await client.query(`INSERT INTO nodes SELECT * FROM dataset ORDER BY ${layout === 'clustered' ? 'memory_id, loc' : "md5(memory_id || ':' || loc)"}`);
    // Apply the actual migration statement after population; test index creation on nonempty data.
    await client.query('DROP INDEX IF EXISTS nodes_memory_parent_loc_idx');
    await client.query(ddl);
    await client.query('ANALYZE nodes');
    for (const [parent, expected] of [['', 40], ['deep:sparse:parent', 25], ['wide', 2000]] as const) {
      const query = `SELECT loc FROM nodes WHERE memory_id = $1 AND ${PARENT_LOC_SQL} = $2 AND loc <> '' ORDER BY loc`;
      const params = ['1', parent];
      const count = (await client.query(query, params)).rowCount;
      if (count !== expected) throw new Error(`Wrong result count for ${layout}/${parent}`);
      // Repeated plans expose warm-cache variability; neither disabling seqscan nor plan-shape assertions.
      const plans = [];
      for (let sample = 0; sample < 3; sample++) {
        plans.push((await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params)).rows[0]['QUERY PLAN']);
      }
      results.push({ layout, rows: 66480, memories: 2, payloadBytes: 256, parent, expected, query, params, plans });
    }
    await client.query("UPDATE nodes SET loc = 'moved:child41' WHERE memory_id = '1' AND loc = 'deep:sparse:parent:child41'");
    const moved = await client.query(`SELECT loc FROM nodes WHERE memory_id = $1 AND ${PARENT_LOC_SQL} = $2`, ['1', 'moved']);
    if (moved.rowCount !== 1) throw new Error('Index did not follow loc update');
  }
  console.log(JSON.stringify({
    version: (await client.query('SELECT version()')).rows[0].version,
    caveats: 'Synthetic minimal table; two physical layouts; warm-cache repeats; no forced planner settings; not production cost, a full migration-chain test, or an upper bound.',
    results,
  }, null, 2));
} finally {
  // Random own name, no prefix enumeration or cleanup of another run.
  if (connected) await client.end();
  try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
  finally { await admin.end(); }
}
