/**
 * Vitest global setup: provision the test databases and this run's graph root.
 *
 * It applies no DDL of its own (#434). Every test database comes from a template that
 * `buildTestSchema` (schemaTemplate.ts) builds from EMPTY by running pre-push.sql, `prisma db push`
 * and post-push.sql through psql, the same three steps as `pnpm db:dev-setup`; serial mode's base is
 * built the same way by `pnpm db:test-setup`. post-push.sql is the one source of the DDL Prisma can't
 * express. A second copy here used to re-apply part of it after the template, so a stale definition in
 * the copy silently overrode the truth on every run; templateCatalogParity434.test.ts guards against
 * one coming back.
 */

import { Client } from 'pg';
import {
  PARALLEL_DBS,
  baseTestDbUrl,
  baseDbName,
  maintenanceUrl,
  testRunId,
  runTemplateDbName,
  isLocalDbHost,
  createDatabaseFromTemplate,
  quoteDbIdent,
  templateLockKey,
  isOwnedRunDead,
  runToken,
  stampTestRunIdentity,
  parseWorkerDbName,
  type WorkerCloneName,
} from './dbWorkers.js';
import { prepareRunGraphRoot, removeRunGraphRoot } from './graphRoot.js';
import { assertBaseMatchesSchema, ensureSchemaTemplate } from './schemaTemplate.js';

export async function setup() {
  // Stamp this run's id BEFORE any worker is forked (#1091). globalSetup runs
  // in the vitest MAIN process and workers inherit its env, which is what
  // carries the id to `perWorkerDb.ts` — nothing else crosses that boundary.
  // Set unconditionally rather than defaulted, so a stale value exported into
  // the shell cannot quietly make two runs share a name-space again.
  stampTestRunIdentity();
  const runId = testRunId();

  // This run's graph-fixture root (#1951), in BOTH modes: serial runs write
  // nodes to disk too. Created (and dead runs' roots swept) before the
  // databases, and removed at teardown even when the database teardown fails.
  prepareRunGraphRoot(runId);
  let dbTeardown: (() => Promise<void>) | undefined;
  try {
    dbTeardown = await setupDatabases();
  } catch (e) {
    removeRunGraphRoot(runId);
    throw e;
  }
  return async function teardown() {
    try {
      await dbTeardown?.();
    } finally {
      removeRunGraphRoot(runId);
    }
  };
}

async function setupDatabases(): Promise<(() => Promise<void>) | undefined> {

  // SERIAL MODE touches the test database and NOTHING ELSE (#1136 review, Codex
  // P2). `HADRON_TEST_PARALLEL=0` is the escape hatch for a setup that has no
  // CREATE DATABASE infrastructure — including a role that can reach the test
  // database but not the `postgres` maintenance one — so opening a maintenance
  // connection up front would have broken exactly the configuration the hatch
  // exists for. The lock still serializes the DDL between two serial runs; it
  // just lives on the connection serial mode already has.
  if (!PARALLEL_DBS) {
    const client = new Client({ connectionString: baseTestDbUrl() });
    await client.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [templateLockKey()]);
      // #1922: serial mode runs against the base itself, so it must have been
      // built for this checkout's schema (`pnpm db:test-setup` stamps it).
      await assertBaseMatchesSchema(client);
    } finally {
      await client.end();
    }
    return;
  }

  // Scope tokens protect Linux PID-namespace sharing of local endpoints (#1137).
  // Remote Postgres remains outside the supported locality model.
  if (!isLocalDbHost()) {
    throw new Error('Parallel test databases require a local loopback/Unix-socket Postgres endpoint. Remote ownership is unsupported; use HADRON_TEST_PARALLEL=0.');
  }

  // Serialize provisioning against other lock-honouring runs (#1091). Since
  // this checkout applies its DDL to its OWN template rather than to the shared
  // base, the lock no longer protects a DDL window — it just keeps concurrent
  // clones of the base from thrashing on 55006.
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  await admin.query('SELECT pg_advisory_lock($1)', [templateLockKey()]);

  try {
    return await provision(admin);
  } finally {
    // Releases the advisory lock — session-scoped, so disconnecting is enough.
    await admin.end();
  }
}

async function provision(admin: Client) {
  const base = baseDbName();
  const runId = testRunId();

  // The shared base is only ever READ (#1136 review, Codex P1). Workers clone a
  // run-scoped copy of this checkout's schema template, a database whose name
  // nobody else knows, so there is no shared mutable state left to race for.
  // (Until #434 this run also applied its own DDL copy to that clone; the
  // template now carries all of it, from post-push.sql.)
  return await provisionParallel(admin, base, runId);
}

export async function provisionParallel(admin: Client, base: string, runId: string) {
  const ownToken = runToken(runId);
  await dropOrphanWorkerDbs(admin, base, runId);

  // Snapshot the shared template into a RUN-SCOPED one, while still holding the
  // lock, and have the workers clone from that (#1136 review, Codex P1).
  //
  // Without this the run-scoping is only half done: the destination names are
  // per-run but their CONTENT is not, so a second checkout's setup could
  // rewrite a shared source before our first lazy worker clone. The failure mode that makes it worth an extra clone is not the noisy
  // one — it is a run passing against another branch's constraints.
  //
  // One extra `CREATE DATABASE` per run against ~13 worker clones. The template
  // holds schema, not rows.
  //
  // #1922: the source is no longer the shared base but the template built from
  // EMPTY for this checkout's schema fingerprint, so another branch's setup can
  // neither drop our columns nor leave its triggers in our run.
  const schemaTemplate = await ensureSchemaTemplate(admin, base);
  const runTemplate = runTemplateDbName(runId, base);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(runTemplate)} WITH (FORCE)`);
  // Waits on a busy source rather than aborting setup — a developer's open psql
  // against it blocks CREATE ... TEMPLATE, and the previous code handled that
  // at the worker-clone site only (#1136 review, Codex P2).
  await createDatabaseFromTemplate(admin, runTemplate, schemaTemplate);

  // Worker DBs are cloned from the run template LAZILY, per worker
  // (perWorkerDb.ts), because VITEST_POOL_ID isn't statically bounded.
  return async function teardown() {
    const a = new Client({ connectionString: maintenanceUrl() });
    await a.connect();
    try {
      // Best-effort: this captured full token only. Future same-scope runs
      // may collect it once its PID is provably dead.
      await dropWorkerDbs(a, base, (c) => c.runToken === ownToken, { swallow: true });
    } finally {
      await a.end();
    }
  };
}

/**
 * Drop clones that no live run owns, before this run creates its own (#1091).
 *
 * This replaced a blanket "drop every `<base>_<digits>`", which was the second
 * half of the collision it was meant to prevent: names were not run-scoped, so
 * the blanket drop reached into a CONCURRENT run's databases, and `WITH (FORCE)`
 * meant it terminated that run's connections rather than failing. A suite that
 * outlived its terminal — a `vitest` piped to `head` SIGPIPEs the pipe and
 * leaves the run alive — was enough to make somebody else's suite collapse with
 * `Database … does not exist` or a `40P01` inside `cleanDb`.
 *
 * The pre-run pass exists at all so a schema change to the template can't be
 * masked by a stale clone that `perWorkerDb` would adopt instead of creating.
 * Run-scoped names make that impossible for a FOREIGN clone — this run's names
 * cannot collide with another run's — so the remaining job is garbage
 * collection, and it is best-effort: an orphan we fail to drop is wasted disk,
 * not a wrong result.
 *
 * Ownership is decided by the full scope token and {@link isOwnedRunDead} and by NOTHING else — in
 * particular never by "has no open connections", since a run that has just
 * issued `CREATE DATABASE` and not yet connected has no connections either, and
 * dropping it there is precisely the bug being fixed. That rule now has no
 * exceptions: a clone this sweep cannot prove is dead is left alone.
 */
export async function dropOrphanWorkerDbs(admin: Client, base: string, runId: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database');
  const datnames = rows.map((r) => r.datname);

  // OUR OWN name, left by a crashed run whose pid the OS has since handed to us.
  // This one fails LOUD (#1136 review, Codex P2): a swallowed failure here means
  // `perWorkerDb` finds the database already present, skips CREATE, and runs the
  // suite against the CRASHED run's schema — the stale-clone masking that the
  // pre-run pass exists to prevent, and the one case where being best-effort
  // produces a wrong result rather than wasted disk.
  await dropWorkerDbs(admin, base, (c) => c.runToken === runToken(runId), { swallow: false }, datnames);

  // Same-scope provably dead runs only. Previous-boot, foreign, unknown,
  // pid-only and unscoped legacy names are never automatically dropped.
  // These leftovers can accumulate without bound (disk/inodes). Manual removal
  // requires all namespaces sharing this endpoint to be quiescent, not merely
  // a PID absent here. db:test-prune-legacy is not a namespace-ownership tool.
  await dropWorkerDbs(
    admin,
    base,
    (clone) => clone.runToken !== runToken(runId) && isOwnedRunDead(clone.scope, clone.runId),
    { swallow: true },
    datnames,
  );
}

/**
 * Drop the worker clones `select` accepts. Clone names are recognized by
 * `parseWorkerDbName` — exact prefix + shape, in JS rather than a SQL regex, so
 * a base name carrying regex metacharacters can never over-match and drop an
 * unrelated database.
 *
 * `select` is mandatory rather than defaulted, because every caller of the
 * blanket version this replaces was the #1091 bug.
 */
async function dropWorkerDbs(
  admin: Client,
  base: string,
  select: (clone: WorkerCloneName) => boolean,
  opts: { swallow: boolean },
  datnames?: string[],
): Promise<void> {
  const names =
    datnames ??
    (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map(
      (r) => r.datname,
    );
  const clones = names
    .map((n) => parseWorkerDbName(n, base))
    .filter((c): c is WorkerCloneName => c !== null && select(c));

  for (const { datname } of clones) {
    const drop = admin.query(`DROP DATABASE IF EXISTS ${quoteDbIdent(datname)} WITH (FORCE)`);
    if (opts.swallow) await drop.catch(() => {});
    else await drop;
  }
}
