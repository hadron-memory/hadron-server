import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Client } from 'pg';

/**
 * Per-worker test-database plumbing so the vitest suite can run files in
 * PARALLEL without racing on one shared `hadron_test` DB (the constraint that
 * forced `fileParallelism: false`; see findings:parallel-vitest-shared-test-db).
 *
 * Model: `globalSetup` clones the schema template built from empty for this
 * checkout (`hadron_test_s<fingerprint>`, #1922, see schemaTemplate.ts) into a
 * run template, applies its CHECK constraints, and workers clone that into one
 * DB each (`hadron_test_r<scope>_p<pid>_<poolId>`). `perWorkerDb.ts` (a setupFile)
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

/**
 * Cap on vitest's fork count, from HADRON_TEST_MAX_WORKERS. Each fork holds its
 * own Postgres clone, and vitest's default (~cores - 1) ran a shared 32-core host
 * out of memory under parallel full suites (Hugo, 2026-10-21). Undefined keeps
 * vitest's default, so CI and laptops are unchanged. An invalid value also keeps
 * the default, with a warning: a typo should not refuse a test run.
 */
export function testMaxWorkers(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.warn(`HADRON_TEST_MAX_WORKERS must be a positive integer, got: ${raw}; using vitest's default.`);
    return undefined;
  }
  return n;
}

/** The template DB URL (CI/dev override via TEST_DATABASE_URL). */
export function baseTestDbUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test';
}

/** Rewrite only the database name (last path segment) of a pg connection string. */
export function withDbName(url: string, dbName: string): string {
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

/** #1137: the kernel boot and PID namespace, not loopback reachability, bound PID liveness.
 * Native non-Linux uses an explicit local-machine scope; remote DB support is not added.
 * No inherited shell scope is trusted by globalSetup. u-scopes are serial-only unknowns,
 * always preserved by orphan cleanup; their own exact root can still be torn down. */
export function computeRunScope(
  platform: string = process.platform,
  readBoot: () => string = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  readNamespace: () => { dev: bigint; ino: bigint } = () => statSync('/proc/self/ns/pid', { bigint: true }),
  machine: () => string = hostname,
): string {
  let identity: string;
  if (platform === 'linux') {
    try {
      const boot = readBoot();
      const ns = readNamespace();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boot) || ns.dev < 0n || ns.ino <= 0n) throw new Error('unverifiable identity');
      identity = `${boot.toLowerCase()}:${ns.dev}:${ns.ino}`;
    } catch {
      throw new Error('Cannot verify Linux test-run boot/PID namespace. Parallel mode refuses unsafe cleanup; use HADRON_TEST_PARALLEL=0.');
    }
  } else {
    const host = machine();
    if (!/^[a-z][a-z0-9]*$/.test(platform) || !host) throw new Error('Cannot verify native test-run platform scope.');
    identity = `${platform}:${host}`;
  }
  return `${platform === 'linux' ? 'l' : 'n'}${createHash('sha256').update(identity).digest('hex').slice(0,20)}`;
}

export function stampTestRunIdentity(): void {
  process.env.HADRON_TEST_RUN_ID = String(process.pid);
  let scope: string;
  try { scope = computeRunScope(); }
  catch (error) {
    if (PARALLEL_DBS) throw error;
    scope = `u${randomBytes(10).toString('hex')}`;
  }
  process.env.HADRON_TEST_RUN_SCOPE = scope;
}

export function testRunScope(): string {
  const scope = process.env.HADRON_TEST_RUN_SCOPE;
  if (!scope || !/^[lnu][0-9a-f]{20}$/.test(scope)) throw new Error('HADRON_TEST_RUN_SCOPE must be stamped by globalSetup.');
  return scope;
}

export function runToken(runId: string, scope = testRunScope()): string {
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[lnu][0-9a-f]{20}$/.test(scope)) throw new Error('Invalid test run ownership token.');
  return `${scope}_p${runId}`;
}

export function testRunToken(): string { return runToken(testRunId()); }

/** Only a same-scope PID is addressable in this process table. Unknown, legacy,
 * prior-boot and foreign namespaces are preserved, never tested with kill(). */
export function isOwnedRunDead(scope: string | null, pid: string | null, ownScope = testRunScope()): boolean {
  return scope !== null && scope === ownScope && scope[0] !== 'u' && pid !== null && !isRunAlive(pid);
}

export function workerDbName(
  poolId: string | number,
  base = baseDbName(),
  runId = testRunId(),
): string {
  // A pool id must be NUMERIC, and this is a guard rather than a type (@copilot,
  // PR #1136). `tpl` is a legal string and would build this run's TEMPLATE name
  // — handing the worker the database every other worker also clones from,
  // which is the isolation loss this whole change exists to prevent, in its
  // quietest form. VITEST_POOL_ID is a number today, so this is defence against
  // a future caller rather than a live bug; it is also the second way these two
  // name-spaces could collide, after truncation, and both are silent.
  if (!/^[0-9]+$/.test(String(poolId))) {
    throw new Error(
      `Worker pool id must be numeric, got: ${String(poolId)}. A non-numeric id can collide ` +
        `with the run template's "_tpl" suffix and silently point a worker at the shared template.`,
    );
  }
  return assertFitsIdentifier(`${base}_r${runToken(runId)}_${poolId}`, base);
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

/**
 * This run's private copy of the template, which its workers clone from.
 *
 * Run-scoped clone NAMES alone leave the template itself shared, and two suites
 * from different checkouts provision it with different constraints — so a run
 * could clone the other branch's schema and pass against constraints it never
 * wrote (PR #1136 review, Codex P1). `globalSetup` takes this snapshot while
 * holding the template lock, which is what makes the run's schema its own.
 *
 * Named in the worker-clone shape with `tpl` where a pool id goes, so the same
 * parse and the same orphan cleanup collect it — a run template left by a
 * crashed run is garbage in exactly the same way.
 */
export function runTemplateDbName(runId: string, base = baseDbName()): string {
  return assertFitsIdentifier(`${base}_r${runToken(runId)}_tpl`, base);
}

/** A plain (unpooled) URL for this run's private template. */
export function runTemplateUrl(runId: string, base = baseDbName()): string {
  const u = new URL(withDbName(baseTestDbUrl(), runTemplateDbName(runId, base)));
  u.searchParams.delete('connection_limit');
  return u.toString();
}

/**
 * Admit existing local TCP endpoints and Unix sockets only. Loopback and shared
 * sockets do NOT prove PID-namespace locality (#1137). Scope tokens provide that
 * boundary for Linux runs sharing a local endpoint; non-Linux retains the local
 * machine assumption. Remote DBs remain unsupported.
 */
export function isLocalDbHost(url = baseTestDbUrl()): boolean {
  const host = new URL(url).hostname;
  return (
    host === '' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.localhost')
  );
}

/** Postgres NAMEDATALEN - 1. Longer identifiers are TRUNCATED, not rejected. */
const PG_MAX_IDENTIFIER_BYTES = 63;

/**
 * Quote a database name for use as an SQL identifier (@copilot, PR #1136).
 *
 * `CREATE DATABASE` and `DROP DATABASE` cannot take a bind parameter — the name
 * has to be interpolated — so it is quoted here instead. The comments at those
 * sites used to say "identifier is code-derived" and wave the question away;
 * that is only half true. The RUN and POOL halves are code-derived, but the BASE
 * comes from `TEST_DATABASE_URL`, and a name containing a double quote would
 * break the statement rather than being rejected.
 *
 * Doubling embedded quotes is the Postgres rule for a quoted identifier.
 */
export function quoteDbIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `CREATE DATABASE <name> TEMPLATE <template>`, tolerating a busy source.
 *
 * Shared by BOTH cloning sites — `globalSetup`'s run-template snapshot and
 * `perWorkerDb`'s worker clones — because the busy-source problem belongs to
 * the operation, not to either caller. It was previously handled at one site
 * and not the other, which is how #1136's review found the snapshot aborting
 * setup on a developer's open `psql` (Codex P2); fixing only the site that was
 * named would have left the same gap one call away.
 *
 * Two conditions, deliberately different answers:
 *
 * - **42P04** (duplicate_database) — somebody already made it. Benign; report
 *   it rather than treating it as creation, since a caller that cares whether
 *   the database is FRESH cannot tell otherwise.
 * - **55006** (object_in_use) — the source has a connection. WAIT. It used to
 *   `pg_terminate_backend` the template instead, on the reasoning that the only
 *   sessions there could be a dev's GUI; a concurrent run's `globalSetup` is
 *   connected to the template the whole time it provisions, so that reasoning
 *   evicted somebody else's suite (#1091).
 *
 * A holder that never leaves gets a NAMED error rather than an endless wait —
 * the pids and users are the whole diagnosis, and "it hung" is not.
 *
 * Budgeted by DEADLINE, not by attempt count, and the reported wait is MEASURED.
 * The first draft counted attempts and computed the elapsed time as
 * `attempts * delayMs` — which testing against a real server showed to be
 * fiction: Postgres does not fail `CREATE DATABASE` on a busy source
 * immediately, it blocks ~8s first. So "25 attempts, 200ms apart" was a ~205s
 * budget wearing a 5s label, and the error would have told the reader a number
 * nothing measured. A wall-clock deadline is the thing the caller actually
 * cares about, and it stays true if that server-side wait ever changes.
 */
export async function createDatabaseFromTemplate(
  admin: Client,
  name: string,
  template: string,
  { timeoutMs = 30_000, delayMs = 200 } = {},
): Promise<'created' | 'exists'> {
  const startedAt = Date.now();
  for (;;) {
    try {
      // Length-checked by assertFitsIdentifier, quoted by quoteDbIdent — the
      // base half comes from TEST_DATABASE_URL, so "code-derived" was only ever
      // true of the run and pool halves.
      await admin.query(
        `CREATE DATABASE ${quoteDbIdent(name)} TEMPLATE ${quoteDbIdent(template)}`,
      );
      return 'created';
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '42P04') return 'exists';
      if (code !== '55006') throw e;

      const waited = Date.now() - startedAt;
      if (waited >= timeoutMs) {
        const { rows } = await admin.query<{ pid: number; usename: string; app: string }>(
          `SELECT pid, usename, coalesce(application_name, '') AS app
             FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [template],
        );
        const who = rows.map((r) => `pid ${r.pid} (${r.usename}${r.app && ` — ${r.app}`})`);
        throw new Error(
          `Cannot clone the test template "${template}": it has been in use for ` +
            `${Math.round(waited / 1000)}s. ` +
            (who.length
              ? `Holding it: ${who.join(', ')}. Close that session — a psql or GUI connected to the ` +
                `test database blocks CREATE DATABASE ... TEMPLATE — then re-run.`
              : `Nothing is holding it now, so this was a transient race — re-run.`),
          { cause: e },
        );
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Refuse a generated database name that Postgres would silently truncate
 * (PR #1136 review, Codex P2).
 *
 * Verified rather than assumed: `CREATE DATABASE "<64+ bytes>"` emits
 * `NOTICE: identifier … will be truncated` and creates the 63-byte prefix. That
 * is quiet on its own, but it is not quiet in what it does here — with a long
 * enough base, `<base>_r<runId>_1` and `<base>_r<runId>_tpl` truncate to the
 * SAME identifier. The worker's `CREATE DATABASE` then fails `42P04`, which
 * `perWorkerDb` treats as a benign create race and swallows, and the worker
 * ends up pointed at the run TEMPLATE that every other worker also shares —
 * silently undoing the isolation this whole change exists to establish.
 *
 * The run-scoped suffix is longer than the `_<poolId>` it replaced, so a base
 * that fit before can stop fitting: this is loud on purpose, and names the
 * remedy. Bytes, not characters — the limit is NAMEDATALEN.
 */
function assertFitsIdentifier(name: string, base: string): string {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > PG_MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Test database name "${name}" is ${bytes} bytes, over Postgres's ${PG_MAX_IDENTIFIER_BYTES}-byte limit. ` +
        `Postgres would TRUNCATE it, collapsing a worker clone and the run template onto one database and ` +
        `silently sharing it between workers. Shorten the database name in TEST_DATABASE_URL — ` +
        `"${base}" leaves too little room for the per-run suffix.`,
    );
  }
  return name;
}

/**
 * A parsed clone. `runId` is null for a pre-#1091 `<base>_<digits>` name;
 * `poolId` is `tpl` for a run template rather than a worker DB.
 */
export type WorkerCloneName = { datname: string; runId: string | null; poolId: string; scope: string | null; runToken: string | null };

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

  const owned = /^r([lnu][0-9a-f]{20})_p([1-9][0-9]*)_([0-9]+|tpl)$/.exec(rest);
  if (owned) return { datname, scope: owned[1], runId: owned[2], poolId: owned[3], runToken: `${owned[1]}_p${owned[2]}` };
  const scoped = /^r([0-9]+)_([0-9]+|tpl)$/.exec(rest);
  if (scoped) return { datname, runId: scoped[1], poolId: scoped[2], scope: null, runToken: null };

  if (/^[0-9]+$/.test(rest)) return { datname, runId: null, poolId: rest, scope: null, runToken: null };
  return null;
}

/**
 * Is the run that owns this clone still running?
 *
 * `kill(pid, 0)` sends no signal and only asks whether the pid is addressable.
 * EPERM means the process EXISTS and belongs to somebody else, so it counts as
 * alive — the direction that matters is never reporting a live run as dead.
 *
 * PID reuse and errors other than ESRCH preserve the clone. Only same-scope
 * callers may use this result as deletion evidence (isOwnedRunDead).
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
    return (e as { code?: string }).code !== 'ESRCH';
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
