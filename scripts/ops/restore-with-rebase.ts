/**
 * #4111 contract section B — the ONLY supported logical restore of a Hadron database: a dump goes into a NEW database,
 * fenced from every client until it is final, with the `agent_team_events` key rebase (section A) applied before
 * anyone can read it.
 *
 *   pnpm ops:restore-with-rebase run --dump FILE --target NAME --owner-role ROLE --template TPL \
 *       --serve-role ROLE [--connect-role ROLE ...] --connection-limit N \
 *       (--db-settings-file FILE.json | --db-settings-from-env SOURCE_URL_VAR)
 *   pnpm ops:restore-with-rebase status NAME
 *   pnpm ops:restore-with-rebase teardown NAME --oid OID --owner-role ROLE
 *
 * Connects with RESTORE_ADMIN_URL: the `restore_admin` login role on the maintenance database. It never prints a URL.
 *
 * Operator prerequisites, stated here and checked by S0, never granted by this script:
 *  (P1) `restore_admin`: LOGIN, CREATEDB, not superuser, no CREATEROLE, and
 *       `GRANT <owner_role> TO restore_admin WITH INHERIT FALSE, SET TRUE` (PostgreSQL 16+).
 *  (P2) a quiescent, superuser-made `IS_TEMPLATE` database holding the extensions the dump needs.
 *  (P3) read access to the dump, disk for a second copy, `pg_restore` 16+.
 *
 * Stages: S0 read-only preflight; S1 CREATE DATABASE with ALLOW_CONNECTIONS false; S2 ACL fence (only restore_admin may
 * connect), then admission on for the working phase; S3 pg_restore and the database-level settings; S4 the rebase.
 * Then the HARD fence (ALLOW_CONNECTIONS false, nothing else connected) for the grants (runtime-role.sql, CONNECT to the
 * owner and serve roles), final verification, the audit row and the steady connection limit; and last, alone, the
 * release statement `ALTER DATABASE ... ALLOW_CONNECTIONS true`.
 *
 * Before the release statement any failure tears down: from a fresh connection, by the recorded oid, never blind, never
 * FORCE. After it there is no teardown: the database is final. A lost reply to the release is resolved by re-reading
 * the catalog (status RELEASED), never by dropping.
 *
 * Limits, stated: ALLOW_CONNECTIONS false is not documented to stop a superuser; the pg_stat_activity check is the only
 * control against one, and it is a detector. The connection limit is not a fence. A superuser dropping and recreating
 * the name between teardown's lookup and its DROP is a named residual.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { clientConfig, connectionProfile, libpqEnv } from './connectionProfile.js';
import { rebaseEventKeys, servingOrderDigest, type RebaseReport } from '../../src/lib/agentTasks/eventKeyRebase.js';

const RUNTIME_ROLE_SQL = fileURLToPath(new URL('../../prisma/runtime-role.sql', import.meta.url));
const AUDIT_SCHEMA = 'hadron_restore';
/** CONNECTION LIMIT during the working phase: the pipeline's session plus pg_restore's. Not a fence. */
const WORKING_CONNECTION_LIMIT = 4;

/** Points where a test injects a failure. The CLI never sets one. */
export type FaultPoint = 'S1-reply' | 'S3' | 'S4' | 'final-verify' | 'pre-release' | 'release-reply';

export interface RunOptions {
  /** restore_admin on the maintenance database. */
  adminUrl: string;
  dump: string;
  target: string;
  ownerRole: string;
  template: string;
  /** The role runtime-role.sql grants to (and that gets CONNECT at the end). */
  serveRole: string;
  /** Further login roles that get CONNECT at the end. The owner role always does. */
  connectRoles?: string[];
  /** The steady CONNECTION LIMIT, set under the hard fence. */
  connectionLimit: number;
  /** The database-level settings to apply: operator-supplied, or read from the source. Refused when absent. */
  dbSettings: Record<string, string> | null;
  runId?: string;
  pgRestore?: string;
  /** Stage events (JSON lines on stderr by default). Awaited, so a test can act at a stage boundary. */
  log?: (event: Record<string, unknown>) => void | Promise<unknown>;
  fault?: FaultPoint;
}

export interface RunResult {
  runId: string;
  oid: number;
  dumpSha256: string;
  rebase: RebaseReport | { state: 'no-event-table' | 'no-key-column' };
  status: 'RELEASED';
}

/** A refusal or failure, with the stage it happened in and what teardown did. */
export class RestoreError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly teardown: TeardownOutcome | null = null,
    readonly oid: number | null = null,
  ) {
    super(`[${stage}] ${message}${teardown ? ` (teardown: ${teardown}${oid != null ? `, oid ${oid}` : ''})` : ''}`);
  }
}

export type DatabaseStatus = 'ABSENT' | 'FENCED' | 'WORKING' | 'RELEASED';
export type TeardownOutcome = 'absent' | 'dropped' | 'released-kept' | 'name-mismatch' | 'drop-failed' | 'uncertain';

const q = (c: Client, id: string) => c.escapeIdentifier(id);

/** A session from the same validated profile the pg_restore child gets (connectionProfile.ts). */
async function connect(url: string, database?: string): Promise<Client> {
  const c = new Client(clientConfig(connectionProfile(url, database)));
  // An idle session that dies (a terminated backend, a dropped link) surfaces on its next query; without a listener the
  // 'error' event would crash the process before the pipeline can reconcile or tear down.
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

/** sha256 of the dump file, streamed. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Extension names a `pg_restore -l` TOC declares (EXTENSION and COMMENT ... EXTENSION entries). */
export function tocExtensions(toc: string): Set<string> {
  const names = new Set<string>();
  for (const line of toc.split('\n')) {
    if (line.startsWith(';')) continue;
    const ext = /^\d+;\s+\d+\s+\d+\s+EXTENSION\s+-\s+(\S+)/.exec(line);
    if (ext) names.add(ext[1]);
    const comment = /^\d+;\s+\d+\s+\d+\s+COMMENT\s+-\s+EXTENSION\s+(\S+)/.exec(line);
    if (comment) names.add(comment[1]);
  }
  return names;
}

/** The TOC with every EXTENSION and COMMENT ... EXTENSION entry for the given extensions commented out. */
export function filterToc(toc: string, omit: Set<string>): string {
  return toc
    .split('\n')
    .map((line) => {
      const m = /^\d+;\s+\d+\s+\d+\s+(?:EXTENSION\s+-|COMMENT\s+-\s+EXTENSION)\s+(\S+)/.exec(line);
      return m && omit.has(m[1]) ? `;${line}` : line;
    })
    .join('\n');
}

/** Database-level settings of a source database (pg_db_role_setting, setrole 0), as name -> value. */
export async function readSourceDbSettings(sourceUrl: string): Promise<Record<string, string>> {
  const c = await connect(sourceUrl);
  try {
    const r = await c.query<{ cfg: string }>(
      `SELECT unnest(s.setconfig) AS cfg FROM pg_db_role_setting s
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = current_database() AND s.setrole = 0`,
    );
    return Object.fromEntries(
      r.rows.map(({ cfg }) => {
        const at = cfg.indexOf('=');
        return [cfg.slice(0, at), cfg.slice(at + 1)];
      }),
    );
  } finally {
    await c.end();
  }
}

/** Sessions connected to the database other than `ownPids`. */
async function foreignSessions(maint: Client, oid: number, ownPids: number[]): Promise<{ pid: number; usename: string | null }[]> {
  const r = await maint.query<{ pid: number; usename: string | null }>(
    `SELECT pid, usename FROM pg_stat_activity WHERE datid = $1 AND NOT (pid = ANY($2::int[])) ORDER BY pid`,
    [oid, ownPids],
  );
  return r.rows;
}

/** CONNECT grantees of the database from its ACL (PUBLIC as 'PUBLIC'), sorted. */
async function connectGrantees(maint: Client, oid: number): Promise<string[]> {
  const r = await maint.query<{ g: string }>(
    `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
       FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      WHERE d.oid = $1 AND a.privilege_type = 'CONNECT'
      ORDER BY 1`,
    [oid],
  );
  return [...new Set(r.rows.map((x) => x.g))];
}

/**
 * Read-only status of a database by name: ABSENT, FENCED (admission off), WORKING (admission on, only restore_admin
 * may connect) or RELEASED (admission on and a role other than the caller holds CONNECT). Also the oid.
 */
export async function status(adminUrl: string, name: string): Promise<{ status: DatabaseStatus; oid: number | null }> {
  const maint = await connect(adminUrl);
  try {
    const r = await maint.query<{ oid: number; datallowconn: boolean }>(
      'SELECT oid::int AS oid, datallowconn FROM pg_database WHERE datname = $1',
      [name],
    );
    if (r.rowCount === 0) return { status: 'ABSENT', oid: null };
    return { status: await classify(maint, r.rows[0].oid, r.rows[0].datallowconn), oid: r.rows[0].oid };
  } finally {
    await maint.end();
  }
}

async function classify(maint: Client, oid: number, allowconn: boolean): Promise<DatabaseStatus> {
  if (!allowconn) return 'FENCED';
  const [{ me }] = (await maint.query<{ me: string }>('SELECT session_user::text AS me')).rows;
  const others = (await connectGrantees(maint, oid)).filter((g) => g !== me);
  return others.length > 0 ? 'RELEASED' : 'WORKING';
}

/**
 * Teardown of a target that never reached the release, by its recorded oid, from a fresh connection. Never blind:
 *  - oid absent: nothing to do;
 *  - the oid now carries a different name: refuse (an operator must look);
 *  - admission on AND a role other than restore_admin holds CONNECT: RELEASED, no DROP;
 *  - otherwise a plain DROP DATABASE (no FORCE), as the owner role.
 */
export async function teardown(adminUrl: string, name: string, oid: number, ownerRole: string): Promise<TeardownOutcome> {
  const maint = await connect(adminUrl);
  try {
    const r = await maint.query<{ datname: string; datallowconn: boolean }>(
      'SELECT datname, datallowconn FROM pg_database WHERE oid = $1',
      [oid],
    );
    if (r.rowCount === 0) return 'absent';
    if (r.rows[0].datname !== name) return 'name-mismatch';
    if ((await classify(maint, oid, r.rows[0].datallowconn)) === 'RELEASED') return 'released-kept';
    try {
      await maint.query(`SET ROLE ${q(maint, ownerRole)}`);
      await maint.query(`DROP DATABASE ${q(maint, name)}`);
      return 'dropped';
    } catch {
      return 'drop-failed';
    }
  } finally {
    await maint.end();
  }
}

/** Test support for the S1-reply fault: end a session from another connection, so its next query really fails. */
async function terminateBackend(adminUrl: string, pid: number): Promise<void> {
  const c = await connect(adminUrl);
  try {
    await c.query('SELECT pg_terminate_backend($1, 5000)', [pid]);
  } finally {
    await c.end();
  }
}

/**
 * After a failed or unanswered CREATE DATABASE, from a fresh connection: is the target there, and is it provably this
 * run's? Provably = every attribute the CREATE set (owner, admission off, the working connection limit, the default
 * ACL) and its row's creating xid at or above `before`, the xmax read just before the CREATE (S0 saw the name absent).
 * A database that fails any of these is reported, never dropped. Named residual: a same-named database made in that
 * window by another CREATEDB role with the same four attributes would be taken for this run's.
 */
export async function reconcileCreate(
  adminUrl: string,
  name: string,
  ownerRole: string,
  before: string,
): Promise<'absent' | { oid: number; mine: boolean }> {
  const c = await connect(adminUrl);
  try {
    const r = await c.query<{ oid: number; mine: boolean }>(
      `SELECT d.oid::int AS oid,
              (d.datdba = $2::regrole AND NOT d.datallowconn AND d.datconnlimit = $3 AND d.datacl IS NULL
               AND pg_snapshot_xmax(pg_current_snapshot())::text::numeric - age(d.xmin) >= $4::numeric) AS mine
         FROM pg_database d WHERE d.datname = $1`,
      [name, ownerRole, WORKING_CONNECTION_LIMIT, before],
    );
    if (r.rowCount === 0) return 'absent';
    return { oid: r.rows[0].oid, mine: r.rows[0].mine === true };
  } finally {
    await c.end();
  }
}

/** runtime-role.sql's psql wrapper, for execution over an already-open connection (the hard fence admits no new one). */
export function runtimeRoleSqlFor(serveRole: string, quoteLiteral: (s: string) => string, path = RUNTIME_ROLE_SQL): string {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l));
  const sql = lines.join('\n').replaceAll(":'serve_role'", quoteLiteral(serveRole));
  if (sql.includes(":'") || /^\s*\\/m.test(sql)) throw new Error('runtime-role.sql has a psql construct this runner does not translate');
  return sql;
}

/** The whole pipeline. Returns only when the target is RELEASED; any earlier failure throws a RestoreError. */
export async function restoreWithRebase(opts: RunOptions): Promise<RunResult> {
  const sink = opts.log ?? ((e: Record<string, unknown>) => void process.stderr.write(`${JSON.stringify(e)}\n`));
  const log = async (e: Record<string, unknown>) => {
    await sink(e);
  };
  const runId = opts.runId ?? `restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const fault = (point: FaultPoint) => {
    if (opts.fault === point) throw new Error(`injected fault at ${point}`);
  };
  const connectRoles = [...new Set([opts.ownerRole, opts.serveRole, ...(opts.connectRoles ?? [])])];
  const pgRestore = opts.pgRestore ?? 'pg_restore';

  // ── S0: read-only preflight ───────────────────────────────────────────────
  const stage0 = 'S0';
  if (opts.dbSettings == null) {
    throw new RestoreError(stage0, 'no database-level settings: pass --db-settings-file or --db-settings-from-env');
  }
  if (!Number.isSafeInteger(opts.connectionLimit) || opts.connectionLimit < 1) {
    throw new RestoreError(stage0, 'connection limit must be a positive integer');
  }
  try {
    connectionProfile(opts.adminUrl);
  } catch (err) {
    throw new RestoreError(stage0, err instanceof Error ? err.message : String(err));
  }
  const dumpSha256 = await sha256File(opts.dump);
  await log({ runId, stage: stage0, event: 'dump', sha256: dumpSha256 });

  const version = await run(pgRestore, ['--version'], process.env);
  const major = Number(/(\d+)(?:\.\d+)?/.exec(version.stdout)?.[1] ?? 0);
  if (version.code !== 0 || major < 16) throw new RestoreError(stage0, `pg_restore 16+ required (found ${major || 'none'})`);

  const maint = await connect(opts.adminUrl);
  let oid: number | null = null;
  let target: Client | null = null;
  let released = false;
  const tear = async (stage: string, err: unknown): Promise<never> => {
    const message = err instanceof Error ? err.message : String(err);
    if (target) await target.end().catch(() => undefined);
    target = null;
    let outcome: TeardownOutcome | null = null;
    if (oid != null) {
      outcome = await teardown(opts.adminUrl, opts.target, oid, opts.ownerRole).catch(() => 'drop-failed' as const);
    }
    await log({ runId, stage, event: 'failed', message, teardown: outcome });
    throw new RestoreError(stage, message, outcome, oid);
  };

  try {
    const pre = await maint.query<{
      me: string; super: boolean; createdb: boolean; createrole: boolean; ver: number;
    }>(
      `SELECT r.rolname AS me, r.rolsuper AS super, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
              current_setting('server_version_num')::int AS ver
         FROM pg_roles r WHERE r.rolname = session_user`,
    );
    const me = pre.rows[0];
    if (me.ver < 160000) throw new RestoreError(stage0, 'PostgreSQL 16+ required (membership SET/INHERIT options)');
    if (me.super) throw new RestoreError(stage0, `${me.me} is a superuser; the restore role must not be (P1)`);
    if (!me.createdb) throw new RestoreError(stage0, `${me.me} lacks CREATEDB (P1)`);
    if (me.createrole) throw new RestoreError(stage0, `${me.me} has CREATEROLE; the restore role must not (P1)`);

    const roles = await maint.query<{ rolname: string; rolsuper: boolean }>(
      'SELECT rolname, rolsuper FROM pg_roles WHERE rolname = ANY($1::text[])',
      [connectRoles],
    );
    for (const r of connectRoles) {
      const row = roles.rows.find((x) => x.rolname === r);
      if (!row) throw new RestoreError(stage0, `role ${r} does not exist`);
      if (row.rolsuper) throw new RestoreError(stage0, `role ${r} is a superuser`);
    }
    if (opts.serveRole === opts.ownerRole) throw new RestoreError(stage0, 'the serve role must not be the owner role');
    const member = await maint.query<{ inherit: boolean; set: boolean; usage: boolean }>(
      `SELECT m.inherit_option AS inherit, m.set_option AS set,
              pg_has_role(session_user, $1, 'USAGE') AS usage
         FROM pg_auth_members m
        WHERE m.roleid = $1::regrole AND m.member = session_user::regrole`,
      [opts.ownerRole],
    );
    const m = member.rows[0];
    if (!m || !m.set || m.inherit || m.usage) {
      throw new RestoreError(stage0, `${me.me} needs GRANT ${opts.ownerRole} TO ${me.me} WITH INHERIT FALSE, SET TRUE and no inherited path (P1)`);
    }

    const tpl = await maint.query<{ istemplate: boolean; allowconn: boolean; ownersuper: boolean; sessions: number }>(
      `SELECT d.datistemplate AS istemplate, d.datallowconn AS allowconn, o.rolsuper AS ownersuper,
              (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid = d.oid) AS sessions
         FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba WHERE d.datname = $1`,
      [opts.template],
    );
    const t = tpl.rows[0];
    if (!t || !t.istemplate || !t.ownersuper) {
      throw new RestoreError(stage0, `template ${opts.template} must exist, be IS_TEMPLATE and be superuser-made (P2)`);
    }
    if (t.sessions !== 0) throw new RestoreError(stage0, `template ${opts.template} is not quiescent (P2)`);
    if (!t.allowconn) throw new RestoreError(stage0, `template ${opts.template} admits no connection; its extensions cannot be read (P2)`);

    const exists = await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.target]);
    if ((exists.rowCount ?? 0) > 0) throw new RestoreError(stage0, `database ${opts.target} already exists; the pipeline only restores into a NEW database`);

    const tc = await connect(opts.adminUrl, opts.template);
    let templateExtensions: Set<string>;
    try {
      templateExtensions = new Set((await tc.query<{ extname: string }>('SELECT extname FROM pg_extension')).rows.map((r) => r.extname));
    } finally {
      await tc.end();
    }
    const toc = await run(pgRestore, ['-l', opts.dump], process.env);
    if (toc.code !== 0) throw new RestoreError(stage0, `pg_restore -l failed: ${toc.stderr.trim().split('\n')[0]}`);
    const dumpExtensions = tocExtensions(toc.stdout);
    const missing = [...dumpExtensions].filter((e) => !templateExtensions.has(e));
    if (missing.length) throw new RestoreError(stage0, `the dump needs extension(s) the template lacks: ${missing.join(', ')}`);
    await log({ runId, stage: stage0, event: 'ok', extensions: [...dumpExtensions].sort() });

    // ── S1: create, admission off ─────────────────────────────────────────────
    // Every xid taken from here on is >= before: the window the reconcile below accepts for this run's CREATE.
    const before = (await maint.query<{ x: string }>('SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS x')).rows[0].x;
    try {
      await maint.query(
        `CREATE DATABASE ${q(maint, opts.target)} OWNER ${q(maint, opts.ownerRole)} TEMPLATE ${q(maint, opts.template)}
           ALLOW_CONNECTIONS false CONNECTION LIMIT ${WORKING_CONNECTION_LIMIT}`,
      );
      if (opts.fault === 'S1-reply') await terminateBackend(opts.adminUrl, maint.processID as number);
      oid = (await maint.query<{ oid: number }>('SELECT oid::int AS oid FROM pg_database WHERE datname = $1', [opts.target])).rows[0].oid;
    } catch (err) {
      // An error does not prove nothing was created: the CREATE can commit and its reply be lost, or the oid lookup can
      // fail after it. Re-read the catalog from a fresh connection; tear down only what is provably this run's.
      const message = err instanceof Error ? err.message : String(err);
      const found = await reconcileCreate(opts.adminUrl, opts.target, opts.ownerRole, before).catch(() => 'unknown' as const);
      if (found === 'absent') {
        await log({ runId, stage: 'S1', event: 'failed', message, teardown: 'absent' });
        throw new RestoreError('S1', `${message}; ${opts.target} does not exist`, 'absent');
      }
      if (found === 'unknown' || found.mine === false) {
        const at = found === 'unknown' ? 'the catalog could not be re-read' : `${opts.target} exists (oid ${found.oid}) but is not provably this run's`;
        await log({ runId, stage: 'S1', event: 'failed', message, teardown: 'uncertain' });
        throw new RestoreError(
          'S1',
          `${message}; CREATE DATABASE outcome uncertain: ${at}; inspect it, then teardown NAME --oid OID`,
          'uncertain',
          found === 'unknown' ? null : found.oid,
        );
      }
      oid = found.oid;
      return await tear('S1', err);
    }
    await log({ runId, stage: 'S1', event: 'created', oid });

    // ── S2: ACL fence, then admission for the working phase ───────────────────
    try {
      await maint.query(`SET ROLE ${q(maint, opts.ownerRole)}`);
      await maint.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${q(maint, opts.target)} FROM PUBLIC`);
      for (const r of connectRoles) await maint.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${q(maint, opts.target)} FROM ${q(maint, r)}`);
      await maint.query(`GRANT CONNECT ON DATABASE ${q(maint, opts.target)} TO ${q(maint, me.me)}`);
      await maint.query('RESET ROLE');
      const grantees = await connectGrantees(maint, oid);
      if (grantees.length !== 1 || grantees[0] !== me.me) throw new Error(`ACL fence: CONNECT held by ${grantees.join(', ') || 'nobody'}`);
      const leaks = await maint.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles
          WHERE rolcanlogin AND NOT rolsuper AND rolname <> session_user
            AND has_database_privilege(oid, $1::oid, 'CONNECT')`,
        [oid],
      );
      if (leaks.rowCount) throw new Error(`ACL fence: ${leaks.rows.map((r) => r.rolname).join(', ')} can still connect`);
      const early = await foreignSessions(maint, oid, []);
      if (early.length) throw new Error(`a session is connected before admission: pid ${early.map((s) => s.pid).join(', ')}`);
      await maint.query(`SET ROLE ${q(maint, opts.ownerRole)}`);
      await maint.query(`ALTER DATABASE ${q(maint, opts.target)} ALLOW_CONNECTIONS true`);
      await maint.query('RESET ROLE');
      await log({ runId, stage: 'S2', event: 'fenced', connect: grantees });
    } catch (err) {
      await maint.query('RESET ROLE').catch(() => undefined);
      return await tear('S2', err);
    }

    // ── S3: restore, settings ─────────────────────────────────────────────────
    target = await connect(opts.adminUrl, opts.target);
    const targetPid = (target as Client).processID as number;
    try {
      const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'restore-with-rebase-'));
      try {
        const list = join(work, 'toc.list');
        writeFileSync(list, filterToc(toc.stdout, templateExtensions));
        const restore = await run(
          pgRestore,
          [`--role=${opts.ownerRole}`, '--no-owner', '--no-privileges', '--exit-on-error', '-L', list, '-d', opts.target, opts.dump],
          libpqEnv(connectionProfile(opts.adminUrl, opts.target)),
        );
        if (restore.code !== 0) throw new Error(`pg_restore exited ${restore.code}: ${restore.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      fault('S3');
      await maint.query(`SET ROLE ${q(maint, opts.ownerRole)}`);
      for (const [name, value] of Object.entries(opts.dbSettings)) {
        await maint.query(`ALTER DATABASE ${q(maint, opts.target)} SET ${q(maint, name)} = ${maint.escapeLiteral(value)}`);
      }
      await maint.query('RESET ROLE');
      await log({ runId, stage: 'S3', event: 'restored', settings: Object.keys(opts.dbSettings).sort() });
    } catch (err) {
      await maint.query('RESET ROLE').catch(() => undefined);
      return await tear('S3', err);
    }

    // ── S4: the rebase ───────────────────────────────────────────────────────
    let rebase: RunResult['rebase'];
    let orderHash: string;
    try {
      await target.query(`SET ROLE ${q(target, opts.ownerRole)}`);
      const shape = await target.query<{ tbl: boolean; col: boolean }>(
        `SELECT to_regclass('public.agent_team_events') IS NOT NULL AS tbl,
                EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.agent_team_events')
                          AND attname = 'tx_id' AND NOT attisdropped) AS col`,
      );
      if (!shape.rows[0].tbl) rebase = { state: 'no-event-table' };
      else if (!shape.rows[0].col) rebase = { state: 'no-key-column' };
      else {
        fault('S4');
        rebase = await rebaseEventKeys(target);
      }
      orderHash = await eventOrderHash(target, rebase.state);
      await log({ runId, stage: 'S4', event: 'rebased', ...rebase });
    } catch (err) {
      return await tear('S4', err);
    }

    // ── Hard fence, then everything final ─────────────────────────────────────
    try {
      await maint.query(`SET ROLE ${q(maint, opts.ownerRole)}`);
      await maint.query(`ALTER DATABASE ${q(maint, opts.target)} ALLOW_CONNECTIONS false`);
      await maint.query('RESET ROLE');
      const others = await foreignSessions(maint, oid, [targetPid]);
      if (others.length) throw new Error(`hard fence: foreign session(s) connected: ${others.map((s) => `${s.pid}/${s.usename}`).join(', ')}`);

      // Grants over the open session: the fence admits no new connection, so runtime-role.sql cannot run through psql.
      await target.query(runtimeRoleSqlFor(opts.serveRole, (s) => target!.escapeLiteral(s)));

      fault('final-verify');
      await finalVerify(target, opts, rebase, orderHash);

      await target.query(`CREATE SCHEMA IF NOT EXISTS ${AUDIT_SCHEMA}`);
      await target.query(
        `CREATE TABLE IF NOT EXISTS ${AUDIT_SCHEMA}.restore_provenance (
           run_id text PRIMARY KEY, dump_sha256 text NOT NULL, runs integer NOT NULL, max_key text NOT NULL,
           database_oid oid NOT NULL, stage text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now())`,
      );
      await target.query(`REVOKE ALL ON SCHEMA ${AUDIT_SCHEMA} FROM PUBLIC`);
      await target.query(
        `INSERT INTO ${AUDIT_SCHEMA}.restore_provenance (run_id, dump_sha256, runs, max_key, database_oid, stage)
         VALUES ($1, $2, $3, $4, $5, 'final')`,
        [runId, dumpSha256, 'runs' in rebase ? rebase.runs : 0, 'maxKey' in rebase ? rebase.maxKey : '0', oid],
      );

      await maint.query(`SET ROLE ${q(maint, opts.ownerRole)}`);
      await maint.query(`ALTER DATABASE ${q(maint, opts.target)} CONNECTION LIMIT ${opts.connectionLimit}`);
      for (const r of connectRoles) await maint.query(`GRANT CONNECT ON DATABASE ${q(maint, opts.target)} TO ${q(maint, r)}`);
      await maint.query(`REVOKE CONNECT ON DATABASE ${q(maint, opts.target)} FROM ${q(maint, me.me)}`);
      await maint.query('RESET ROLE');
      const finalGrantees = await connectGrantees(maint, oid);
      const want = [...connectRoles].sort();
      if (JSON.stringify(finalGrantees) !== JSON.stringify(want)) {
        throw new Error(`final ACL: CONNECT held by ${finalGrantees.join(', ')}, expected ${want.join(', ')}`);
      }
      const allow = await maint.query<{ allow: boolean }>('SELECT datallowconn AS allow FROM pg_database WHERE oid = $1', [oid]);
      if (allow.rows[0].allow) throw new Error('hard fence lifted before the release');

      // Close the pipeline's own target session; nothing may remain.
      await target.end();
      target = null;
      fault('pre-release');
      const left = await waitNoSessions(maint, oid);
      if (left.length) throw new Error(`session(s) still connected before release: ${left.map((s) => `${s.pid}/${s.usename}`).join(', ')}`);
      await maint.query(`SET ROLE ${q(maint, opts.ownerRole)}`);
    } catch (err) {
      await maint.query('RESET ROLE').catch(() => undefined);
      return await tear('final', err);
    }

    // ── Release: one statement, last ─────────────────────────────────────────
    try {
      await log({ runId, stage: 'release', event: 'releasing', oid });
      await maint.query(`ALTER DATABASE ${q(maint, opts.target)} ALLOW_CONNECTIONS true`);
      fault('release-reply');
      released = true;
    } catch (err) {
      // The reply may be lost after the statement committed: re-read, never drop a released database.
      const now = await status(opts.adminUrl, opts.target).catch(() => null);
      if (now?.status === 'RELEASED' && now.oid === oid) {
        released = true;
        await log({ runId, stage: 'release', event: 'reply-lost-but-released', oid });
      } else {
        return await tear('release', err);
      }
    }
    await log({ runId, stage: 'release', event: 'released', oid });
    return { runId, oid: oid!, dumpSha256, rebase, status: 'RELEASED' };
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    if (released) throw err;
    return await tear('S0', err);
  } finally {
    if (target) await (target as Client).end().catch(() => undefined);
    await maint.end().catch(() => undefined);
  }
}

/**
 * The serving order's streamed digest (`servingOrderDigest`), read in its own read-only repeatable-read transaction:
 * bounded memory and no single-value limit at any history size (blind finding F3 on #4116). Only meaningful when the
 * key column exists.
 */
async function eventOrderHash(c: Client, state: string): Promise<string> {
  if (state === 'no-event-table' || state === 'no-key-column') return '';
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const d = await servingOrderDigest(c);
    await c.query('COMMIT');
    return `${d.rows}:${d.sha256}`;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Order, keys, ownership and grants, verified on the open session under the hard fence. */
async function finalVerify(c: Client, opts: RunOptions, rebase: RunResult['rebase'], orderHash: string): Promise<void> {
  if (rebase.state !== 'no-event-table' && rebase.state !== 'no-key-column') {
    if ((await eventOrderHash(c, rebase.state)) !== orderHash) throw new Error('final verify: event serving order changed after S4');
    const high = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_team_events WHERE tx_id >= pg_snapshot_xmax(pg_current_snapshot())`,
    );
    if (high.rows[0].n !== 0) throw new Error(`final verify: ${high.rows[0].n} event key(s) at or above xmax`);
  }
  const owners = await c.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relowner <> $1::regrole
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     UNION ALL
     SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proowner <> $1::regrole
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      LIMIT 5`,
    [opts.ownerRole],
  );
  if (owners.rowCount) throw new Error(`final verify: not owned by ${opts.ownerRole}: ${owners.rows.map((r) => r.name).join(', ')}`);
  const acl = await c.query<{ g: string }>(
    `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relacl IS NOT NULL
        AND a.grantee NOT IN ($1::regrole, $2::regrole)`,
    [opts.ownerRole, opts.serveRole],
  );
  if (acl.rowCount) throw new Error(`final verify: table grants to ${acl.rows.map((r) => r.g).join(', ')} (dump ACLs must not survive)`);
}

async function waitNoSessions(maint: Client, oid: number): Promise<{ pid: number; usename: string | null }[]> {
  for (let i = 0; i < 50; i++) {
    const left = await foreignSessions(maint, oid, []);
    if (left.length === 0) return left;
    await new Promise((r) => setTimeout(r, 100));
  }
  return foreignSessions(maint, oid, []);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage:
  restore-with-rebase run --dump FILE --target NAME --owner-role ROLE --template TPL --serve-role ROLE
                          [--connect-role ROLE ...] --connection-limit N
                          (--db-settings-file FILE.json | --db-settings-from-env VAR)
  restore-with-rebase status NAME
  restore-with-rebase teardown NAME --oid OID --owner-role ROLE
Connects with RESTORE_ADMIN_URL (restore_admin on the maintenance database).`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  const adminUrl = env.RESTORE_ADMIN_URL;
  if (!cmd || !['run', 'status', 'teardown'].includes(cmd)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!adminUrl) {
    process.stderr.write('RESTORE_ADMIN_URL is not set\n');
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      dump: { type: 'string' },
      target: { type: 'string' },
      'owner-role': { type: 'string' },
      template: { type: 'string' },
      'serve-role': { type: 'string' },
      'connect-role': { type: 'string', multiple: true },
      'connection-limit': { type: 'string' },
      'db-settings-file': { type: 'string' },
      'db-settings-from-env': { type: 'string' },
      oid: { type: 'string' },
    },
  });
  try {
    if (cmd === 'status') {
      if (positionals.length !== 1) throw new Error(USAGE);
      const s = await status(adminUrl, positionals[0]);
      process.stdout.write(`${JSON.stringify(s)}\n`);
      return 0;
    }
    if (cmd === 'teardown') {
      if (positionals.length !== 1 || !values.oid || !values['owner-role']) throw new Error(USAGE);
      const out = await teardown(adminUrl, positionals[0], Number(values.oid), values['owner-role']);
      process.stdout.write(`${JSON.stringify({ teardown: out })}\n`);
      return out === 'dropped' || out === 'absent' ? 0 : 1;
    }
    for (const k of ['dump', 'target', 'owner-role', 'template', 'serve-role', 'connection-limit'] as const) {
      if (!values[k]) throw new Error(`--${k} is required\n${USAGE}`);
    }
    let dbSettings: Record<string, string> | null = null;
    if (values['db-settings-file']) dbSettings = JSON.parse(readFileSync(values['db-settings-file'], 'utf8'));
    else if (values['db-settings-from-env']) {
      const src = env[values['db-settings-from-env']];
      if (!src) throw new Error(`${values['db-settings-from-env']} is not set`);
      dbSettings = await readSourceDbSettings(src);
    }
    const result = await restoreWithRebase({
      adminUrl,
      dump: values.dump!,
      target: values.target!,
      ownerRole: values['owner-role']!,
      template: values.template!,
      serveRole: values['serve-role']!,
      connectRoles: values['connect-role'],
      connectionLimit: Number(values['connection-limit']),
      dbSettings,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
