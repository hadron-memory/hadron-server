/**
 * vitest setupFile — runs in every worker BEFORE any test file imports the
 * Prisma client, so the client's `new PrismaClient()` (which reads DATABASE_URL
 * at construction) connects to THIS worker's private database
 * (`hadron_test_<VITEST_POOL_ID>`). Files then run in parallel without racing.
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
      // Best-effort: terminate any stray connection to the template (a dev's GUI
      // or psql) so CREATE DATABASE ... TEMPLATE isn't blocked by "source
      // database is being accessed by other users". The workers themselves use
      // their clones, not the template, and CREATE's own backend runs on the
      // maintenance DB — so this only kills unrelated external sessions.
      await admin
        .query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [template],
        )
        .catch(() => {});
      try {
        // Clone the fully-provisioned template (schema, pgvector, tsv, all CHECK
        // constraints). Identifier is code-derived.
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
      } catch (e) {
        // 42P04 = duplicate_database: another slot won a benign create race.
        if ((e as { code?: string }).code !== '42P04') throw e;
      }
    }
  } finally {
    await admin.end();
  }
}
