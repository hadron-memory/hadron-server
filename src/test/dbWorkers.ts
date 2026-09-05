/**
 * Per-worker test-database plumbing so the vitest suite can run files in
 * PARALLEL without racing on one shared `hadron_test` DB (the constraint that
 * forced `fileParallelism: false`; see findings:parallel-vitest-shared-test-db).
 *
 * Model: `globalSetup` provisions the base `hadron_test` template (schema +
 * pgvector + tsv column/index + CHECK constraints), then clones it into one DB
 * per worker (`hadron_test_r<runId>_<poolId>`). `perWorkerDb.ts` (a setupFile)
 * points each worker's `DATABASE_URL` at its own clone before the Prisma client
 * is constructed. Every worker still runs `cleanDb` per test — but only against
 * its own DB, so files never collide.
 *
 * The name is scoped by RUN as well as by worker (#1091). It used to be
 * `<base>_<VITEST_POOL_ID>`, and a pool id is a concurrency slot that restarts
 * at 1 every run — so two suites on one machine claimed the same databases and
 * deleted from each other's tables mid-test, while `globalSetup`'s pre-run
 * cleanup dropped them `WITH (FORCE)` and evicted whichever run was already
 * there. Isolation held over workers within a run and over nothing else, which
 * is why it read as sound. See {@link testRunId}.
 *
 * Escape hatch: `HADRON_TEST_PARALLEL=0` falls back to the old single-DB,
 * serial behavior (one `hadron_test`, `fileParallelism: false`).
 */
/** Parallel per-worker DBs are the default; set HADRON_TEST_PARALLEL=0 to opt out. */
export const PARALLEL_DBS = process.env.HADRON_TEST_PARALLEL !== '0';

/**
 * Per-worker Prisma connection-pool bound (#1091).
 *
 * Prisma defaults `connection_limit` to `cpus * 2 + 1` — 29 on a 14-core box —
 * **per client**, and there is one client per vitest fork. At ~13 forks that is
 * ~377 connections demanded against a stock Postgres `max_connections` of 100.
 *
 * Pools grow lazily, so the steady state fits and nothing looks wrong: a full
 * run peaks at 84/100. The ceiling is only reached when a worker SPIKES, and
 * the spikes are exactly where the flakes landed — `ensureAgentOrgGrant`'s 50
 * concurrent upserts is the largest simultaneous demand in the suite, runs in
 * **36ms alone**, and has timed out at **5000ms** under parallel load.
 *
 * That ratio is the whole diagnosis. A test 140x inside its own timeout is not
 * slow, it is BLOCKED — so raising the timeout (the hypothesis #1091 asks about)
 * would only make the same block take longer to report. Bounding demand keeps
 * the parallelism and moves the queueing to a place that is fair and local: a
 * worker waits briefly on its OWN pool instead of racing every other worker for
 * a global resource that runs out.
 *
 * 5 x ~13 forks = ~65, leaving headroom for the short-lived maintenance clients
 * and anything else on the box. Raise via HADRON_TEST_CONNECTION_LIMIT if a
 * future test genuinely needs more concurrency in one file.
 */
export const WORKER_CONNECTION_LIMIT = (() => {
  const raw = process.env.HADRON_TEST_CONNECTION_LIMIT;
  if (raw === undefined || raw.trim() === '') return 5;
  const n = Number(raw);
  // Fail loud rather than silently falling back — a typo here reintroduces the
  // exact starvation this exists to prevent, and it would present as a flake.
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`HADRON_TEST_CONNECTION_LIMIT must be a positive integer, got: ${raw}`);
  }
  return n;
})();

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

/**
 * This run's id — the vitest MAIN process's pid, stamped into `process.env` by
 * `globalSetup` before any worker is forked, and inherited from there.
 *
 * It exists because `VITEST_POOL_ID` is a concurrency-SLOT id that restarts at 1
 * for every run, so a name built from it alone is not unique to a run: two
 * suites on one machine claim the SAME `hadron_test_1..N` and then delete from
 * each other's tables. That is the #1091 `cleanDb` deadlock — per-worker
 * isolation was holding the whole time, over workers WITHIN a run, which is a
 * narrower thing than it reads as.
 *
 * A pid rather than a random token because it is the only run id that can be
 * INTERROGATED afterwards: a clone left behind by a crashed run is identifiable
 * as garbage precisely because its pid is gone (see {@link isRunAlive}). A
 * random token would need a liveness heuristic — "no open connections" — whose
 * failure mode is dropping a live run's database in the window between
 * `CREATE DATABASE` and its first connection.
 *
 * Throws when unset rather than falling back: a fallback would silently rebuild
 * the shared name-space this exists to remove, and it would present as the
 * original flake.
 */
export function testRunId(): string {
  const raw = process.env.HADRON_TEST_RUN_ID;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    throw new Error(
      `HADRON_TEST_RUN_ID must be set to the vitest main process pid (globalSetup stamps it), got: ${raw}`,
    );
  }
  return raw;
}

export function workerDbName(
  poolId: string | number,
  base = baseDbName(),
  runId = testRunId(),
): string {
  return `${base}_r${runId}_${poolId}`;
}

/**
 * Advisory-lock key serializing TEMPLATE provisioning across concurrent runs
 * (#1091).
 *
 * `globalSetup` re-applies the template's CHECK constraints with DROP + ADD on
 * every run. Two runs doing that to the SAME `hadron_test` at once update the
 * same catalog rows and one of them dies with `XX000 tuple concurrently
 * updated` out of `heapam.c` — observed once in three paired runs. Run-scoped
 * clone names do not help: the template is shared by construction, since it is
 * the thing being cloned.
 *
 * Derived from the base name so a run using `TEST_DATABASE_URL` to get a
 * private template takes a different lock and never waits on the shared one.
 */
export function templateLockKey(base = baseDbName()): number {
  // FNV-1a, masked to 31 bits: positive, fits a pg bigint, and stable across
  // processes (unlike anything derived from a hash seed).
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h & 0x7fffffff;
}

/** A parsed worker clone. `runId` is null for a pre-#1091 `<base>_<digits>` name. */
export type WorkerCloneName = { datname: string; runId: string | null; poolId: string };

/**
 * Recognize a worker clone by exact prefix + shape, in JS rather than a SQL
 * regex, so a base name carrying regex metacharacters can never over-match and
 * drop an unrelated database.
 *
 * Both shapes are recognized on purpose. The LEGACY `<base>_<digits>` form is
 * what a checkout from before this change still creates, and a machine running
 * both will have both — so cleanup has to be able to see the old ones, and
 * cannot tell which run owns them.
 */
export function parseWorkerDbName(datname: string, base = baseDbName()): WorkerCloneName | null {
  const prefix = `${base}_`;
  if (!datname.startsWith(prefix)) return null;
  const rest = datname.slice(prefix.length);

  const scoped = /^r([0-9]+)_([0-9]+)$/.exec(rest);
  if (scoped) return { datname, runId: scoped[1], poolId: scoped[2] };

  if (/^[0-9]+$/.test(rest)) return { datname, runId: null, poolId: rest };
  return null;
}

/**
 * Is the run that owns this clone still running?
 *
 * `kill(pid, 0)` sends no signal and only asks whether the pid is addressable.
 * EPERM means the process EXISTS and belongs to somebody else, so it counts as
 * alive — the direction that matters is never reporting a live run as dead.
 *
 * Pid reuse can report a dead run as alive, which leaves one orphan clone
 * un-dropped. That is the harmless direction, and the next run with a free pid
 * collects it.
 *
 * Assumes the Postgres server is local to the runs using it, which is what
 * `postgresql://…@localhost` in `baseTestDbUrl` already assumes. A SHARED test
 * server would need a different liveness signal — pids from another host mean
 * nothing here.
 */
export function isRunAlive(runId: string): boolean {
  const pid = Number(runId);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/**
 * The DB URL for one worker (by its 1-based VITEST_POOL_ID), carrying the
 * per-worker pool bound (#1091 — see WORKER_CONNECTION_LIMIT).
 *
 * Applied HERE and not in `withDbName`, so it reaches only the pooled Prisma
 * clients. `maintenanceUrl()` is a single short-lived `pg.Client` that does not
 * pool, and giving it a limit it does not read would just be noise in a
 * connection string somebody later debugs.
 *
 * An explicit `connection_limit` already on TEST_DATABASE_URL wins — an
 * operator who set one meant it, and silently overriding it is how a knob stops
 * being a knob.
 *
 * But PRESENT is not the test; a non-empty VALUE is (PR #1125 review, Copilot).
 * A trailing `?connection_limit=` — which is what `?connection_limit=$VAR`
 * becomes with `$VAR` unset, i.e. how it actually reaches CI from a script —
 * satisfies `has()` while meaning nothing. Deferring to it would hand the pool
 * back to Prisma's unbounded default and present as the very flake this exists
 * to remove. Same shape as hadron-cli's `an-empty-flag-is-not-an-absent-flag`:
 * "did the caller set it?" and "did the caller set it to nothing?" are
 * different questions and a presence check answers only the first.
 */
export function workerDbUrl(poolId: string | number): string {
  const u = new URL(withDbName(baseTestDbUrl(), workerDbName(poolId)));
  const explicit = u.searchParams.get('connection_limit');
  if (explicit === null || explicit.trim() === '') {
    u.searchParams.set('connection_limit', String(WORKER_CONNECTION_LIMIT));
  }
  return u.toString();
}

/**
 * A maintenance-DB URL for CREATE/DROP DATABASE. `CREATE DATABASE ... TEMPLATE`
 * requires no open connections to the template, so it must run from a *different*
 * database — the always-present `postgres` maintenance DB.
 */
export function maintenanceUrl(): string {
  const u = new URL(withDbName(baseTestDbUrl(), 'postgres'));
  // Strip rather than merely not-adding (PR #1125 review, Copilot). This is a
  // bare `pg.Client` that does not pool and does not read `connection_limit` —
  // but it INHERITS whatever TEST_DATABASE_URL carries, so an operator who set
  // the knob would leave a meaningless param here for somebody to later debug.
  u.searchParams.delete('connection_limit');
  return u.toString();
}
