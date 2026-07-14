/**
 * Per-worker test-database plumbing so the vitest suite can run files in
 * PARALLEL without racing on one shared `hadron_test` DB (the constraint that
 * forced `fileParallelism: false`; see findings:parallel-vitest-shared-test-db).
 *
 * Model: `globalSetup` provisions the base `hadron_test` template (schema +
 * pgvector + tsv column/index + CHECK constraints), then clones it into one DB
 * per worker (`hadron_test_1..N`). `perWorkerDb.ts` (a setupFile) points each
 * worker's `DATABASE_URL` at its own clone before the Prisma client is
 * constructed. Every worker still runs `cleanDb` per test — but only against
 * its own DB, so files never collide.
 *
 * Escape hatch: `HADRON_TEST_PARALLEL=0` falls back to the old single-DB,
 * serial behavior (one `hadron_test`, `fileParallelism: false`).
 */
/** Parallel per-worker DBs are the default; set HADRON_TEST_PARALLEL=0 to opt out. */
export const PARALLEL_DBS = process.env.HADRON_TEST_PARALLEL !== '0';

/** The template DB URL (CI/dev override via TEST_DATABASE_URL). */
export function baseTestDbUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test';
}

/** Rewrite only the database name (last path segment) of a pg connection string. */
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export function baseDbName(url = baseTestDbUrl()): string {
  return new URL(url).pathname.replace(/^\//, '');
}

export function workerDbName(poolId: string | number, base = baseDbName()): string {
  return `${base}_${poolId}`;
}

/** The DB URL for one worker (by its 1-based VITEST_POOL_ID). */
export function workerDbUrl(poolId: string | number): string {
  return withDbName(baseTestDbUrl(), workerDbName(poolId));
}

/**
 * A maintenance-DB URL for CREATE/DROP DATABASE. `CREATE DATABASE ... TEMPLATE`
 * requires no open connections to the template, so it must run from a *different*
 * database — the always-present `postgres` maintenance DB.
 */
export function maintenanceUrl(): string {
  return withDbName(baseTestDbUrl(), 'postgres');
}
