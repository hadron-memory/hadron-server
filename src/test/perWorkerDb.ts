/**
 * vitest setupFile — runs in every worker BEFORE any test file imports the
 * Prisma client, so the client's `new PrismaClient()` (which reads DATABASE_URL
 * at construction) connects to THIS worker's private database
 * (`hadron_test_r<runId>_<VITEST_POOL_ID>`). Files then run in parallel without
 * racing — and since #1091 the name is scoped by RUN as well as by worker, so
 * two SUITES on one machine do not race either.
 *
 * The DB is created LAZILY here rather than pre-provisioned in globalSetup:
 * VITEST_POOL_ID is a concurrency-slot id (bounded by the fork count, reused
 * across files), not a static 1..N, so we can't know the set up front. Only a
 * handful of distinct slots ever exist, each cloned once and reused across the
 * files that land on it — `cleanDb` resets data per test, so reuse is safe.
 *
 * Imports stay minimal (only `pg` + the URL helpers) — importing the Prisma
 * client here would construct the singleton against the base URL before we
 * rewrite it, defeating the isolation.
 */
import { Client } from 'pg';
import { PARALLEL_DBS, workerDbUrl, workerDbName, baseDbName, maintenanceUrl } from './dbWorkers.js';

if (PARALLEL_DBS) {
  const poolId = process.env.VITEST_POOL_ID ?? '1';
  process.env.DATABASE_URL = workerDbUrl(poolId);

  const name = workerDbName(poolId);
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
      const template = baseDbName();
      // Clone the fully-provisioned template (schema, pgvector, tsv, all CHECK
      // constraints). Identifier is code-derived.
      //
      // `CREATE DATABASE ... TEMPLATE` refuses (55006) while anything else is
      // connected to the source, so this used to `pg_terminate_backend` the
      // template first, on the reasoning that the only sessions there could be
      // a dev's GUI or psql. That reasoning was wrong in the same way the rest
      // of #1091 was: a CONCURRENT RUN's globalSetup is connected to the
      // template while it provisions, so terminating "stray" connections
      // evicted somebody else's suite. WAIT instead — the blocker is another
      // run's setup, it is short, and it finishes on its own.
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
          break;
        } catch (e) {
          const code = (e as { code?: string }).code;
          // 42P04 = duplicate_database: another slot won a benign create race.
          if (code === '42P04') break;
          // 55006 = object_in_use: the template has a connection. Back off and
          // retry rather than killing whoever holds it. Fail LOUD after ~5s —
          // a genuinely stuck holder (that dev's psql) should be named, not
          // waited on forever.
          if (code !== '55006' || attempt >= 25) throw e;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  } finally {
    await admin.end();
  }
}
