/**
 * vitest setupFile — runs in every worker BEFORE any test file imports the
 * Prisma client, so the client's `new PrismaClient()` (which reads DATABASE_URL
 * at construction) connects to THIS worker's private database
 * (`hadron_test_r<scope>_p<pid>_<VITEST_POOL_ID>`). Files then run in parallel without
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
import {
  PARALLEL_DBS,
  workerDbUrl,
  workerDbName,
  runTemplateDbName,
  createDatabaseFromTemplate,
  testRunId,
  maintenanceUrl,
} from './dbWorkers.js';

if (PARALLEL_DBS) {
  const poolId = process.env.VITEST_POOL_ID ?? '1';
  process.env.DATABASE_URL = workerDbUrl(poolId);

  const name = workerDbName(poolId);
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
      // THIS RUN's snapshot of the template, not the shared base (#1136 review,
      // Codex P1): a concurrent suite from another checkout provisions the base
      // with its own constraints, and cloning that would run this branch's
      // tests against another branch's schema.
      const template = runTemplateDbName(testRunId());
      // Clone the fully-provisioned template (schema, pgvector, tsv, all CHECK
      // constraints). The busy-source handling — WAIT for a connected template
      // rather than `pg_terminate_backend` it, which is how this used to evict a
      // concurrent run's globalSetup — lives in the shared helper, because
      // globalSetup's snapshot needs exactly the same thing and having it at
      // only one of the two sites is what #1136's review found twice.
      await createDatabaseFromTemplate(admin, name, template);
    }
  } finally {
    await admin.end();
  }
}
