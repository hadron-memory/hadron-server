/**
 * #2413 S3: the serve-role smoke script against a REAL second role on the
 * worker's own (full-schema) test database. The role is cluster-level, so its
 * name carries a per-run suffix and teardown drops it. The CI lane
 * (migration-smoke-test.yml) runs the same script against the `migrate deploy`
 * database and proves it fails when the grants file is mutated.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintenanceUrl } from '../../src/test/dbWorkers.js';
import { buildChecks, EXIT, main, newFixture } from './serve-role-smoke.js';
import { cleanupOwnedSmokeFixture } from './smokeTeardown.js';

const GRANTS_SQL = fileURLToPath(new URL('../../prisma/runtime-role.sql', import.meta.url));
const suffix = randomBytes(4).toString('hex');
const OWNER = `smk_owner_${suffix}`;
const SERVE = `smk_serve_${suffix}`;
const DB = `smk_db_${suffix}`;
const PASSWORD = randomBytes(12).toString('hex');

// The grants file refuses a serve role that is the role running it, is a superuser, or is a member of the owner
// (or the reverse), and it must be run as the owner, not `postgres`. So the owner here is a real non-superuser
// role that owns a database built from scratch (db push + post-push.sql), the way the CI lane builds its own.
function urlFor(user: string, db: string): string {
  const u = new URL(maintenanceUrl());
  if (user !== u.username) {
    u.username = user;
    u.password = PASSWORD;
  }
  u.pathname = `/${db}`;
  return u.toString();
}
const OWNER_URL = urlFor(OWNER, DB);

async function connect<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const admin = <T,>(fn: (c: Client) => Promise<T>, db = 'postgres') => connect(urlFor(new URL(maintenanceUrl()).username, db), fn);
const asOwner = <T,>(fn: (c: Client) => Promise<T>) => connect(OWNER_URL, fn);

const serveUrl = () => urlFor(SERVE, DB);

const grant = () =>
  execFileSync('psql', [OWNER_URL, '-v', 'ON_ERROR_STOP=1', '-v', `serve_role=${SERVE}`, '-q', '-f', GRANTS_SQL], { stdio: 'pipe' });

async function smoke() {
  const lines: string[] = [];
  const code = await main({ MIGRATE_DATABASE_URL: OWNER_URL, SERVE_DATABASE_URL: serveUrl() }, (l) => lines.push(l));
  return { code, out: lines.join('\n') };
}

beforeAll(async () => {
  await admin(async (c) => {
    for (const r of [OWNER, SERVE]) await c.query(`CREATE ROLE ${r} LOGIN NOSUPERUSER PASSWORD '${PASSWORD}'`);
    await c.query(`CREATE DATABASE ${DB} OWNER ${OWNER}`);
  });
  await admin((c) => c.query('CREATE EXTENSION IF NOT EXISTS vector'), DB);
  const env = { ...process.env, DATABASE_URL: OWNER_URL };
  execFileSync('node_modules/.bin/prisma', ['db', 'push', '--skip-generate', '--accept-data-loss'], { env, stdio: 'pipe' });
  execFileSync('psql', [OWNER_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'prisma/post-push.sql'], { stdio: 'pipe' });
  // db push has no ledger; the migrate-deploy database does.
  await asOwner((c) => c.query(`CREATE TABLE IF NOT EXISTS _prisma_migrations (id varchar(36) PRIMARY KEY)`));
  grant();
}, 180_000);

// #2683: 30s is a margin over the observed 9.4s healthy hosted DROP, not a
// measured upper bound or a diagnosis of the hosted timeout cause. Keep step
// timing; a recurrence at 30s needs cause investigation, not another increase.
// Only this invocation's generated DB and two roles are named or removed.
afterAll(async () => {
  // #4377: the cluster's checkpoint counters and dirty-buffer origin either side of the owned DROP, to say what the
  // drop's immediate checkpoint writes. Each reading is capped and swallowed, so it can't fail or stall the hook.
  const before = await checkpointReading();
  const c = new Client({ connectionString: urlFor(new URL(maintenanceUrl()).username, 'postgres') });
  // #3877: if the owned DROP is still pending after 10s, log what the backends wait on, from a second connection.
  try {
    await cleanupOwnedSmokeFixture(c, { database: DB, roles: [OWNER, SERVE] }, console.error, {
      slowAfterMs: 10_000,
      snapshot: () => dropSnapshot(c.processID),
    });
  } finally {
    console.error(JSON.stringify({ event: 'serve-role-smoke.cleanup.checkpoint', database: DB, before, after: await checkpointReading() }));
  }
}, 30_000);

/** Reads on one probe connection, each independent: a failing read (an absent view or extension) is recorded, not thrown. */
async function probeReads(reads: Record<string, [string, unknown[]?]>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const probe = new Client({
    connectionString: urlFor(new URL(maintenanceUrl()).username, 'postgres'),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  await probe.connect();
  try {
    const out: Record<string, unknown> = {};
    for (const [name, [sql, params = []]] of Object.entries(reads)) {
      try {
        out[name] = (await probe.query(sql, params)).rows;
      } catch (error) {
        out[name] = { error: error instanceof Error ? error.message : 'unknown' };
      }
    }
    return out;
  } finally {
    await probe.end();
  }
}

/** PG16 keeps the checkpoint counters in pg_stat_bgwriter (CI); PG17 moved them to pg_stat_checkpointer. */
const CHECKPOINT_COUNTERS = `SELECT * FROM pg_stat_bgwriter`;

/**
 * #4377: one reading of what an immediate checkpoint would have to write. Dirty buffers are grouped by database and
 * split by relfilenode below 16384 (system catalogs as a fresh clone copies them) or above (user relations, which
 * tests write and TRUNCATE renumbers), so clone copies and test writes show apart. pg_buffercache and track_io_timing
 * are set up only on CI's throwaway test cluster (test.yml); elsewhere those reads record their error. Capped at 2s.
 */
async function checkpointReading(): Promise<unknown> {
  const started = performance.now();
  const reading = probeReads({
    counters: [CHECKPOINT_COUNTERS],
    checkpointerCounters: [`SELECT * FROM pg_stat_checkpointer`],
    checkpointerIo: [`SELECT writes, write_time, fsyncs, fsync_time FROM pg_stat_io
                       WHERE backend_type = 'checkpointer' AND object = 'relation' AND context = 'normal'`],
    checkpointer: [`SELECT wait_event FROM pg_stat_activity WHERE backend_type = 'checkpointer'`],
    buffers: [`SELECT count(*) FILTER (WHERE isdirty) AS dirty, count(relfilenode) AS used, count(*) AS total FROM pg_buffercache`],
    dirtyByDatabase: [`SELECT coalesce(d.datname, b.reldatabase::text) AS db,
                              count(*) FILTER (WHERE b.relfilenode < 16384) AS catalog,
                              count(*) FILTER (WHERE b.relfilenode >= 16384) AS user_rel
                         FROM pg_buffercache b LEFT JOIN pg_database d ON d.oid = b.reldatabase
                        WHERE b.isdirty GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`],
    databases: [`SELECT count(*) AS total, count(*) FILTER (WHERE datname LIKE 'hadron_test_r%') AS clones FROM pg_database`],
    // Files on disk per test database. A TRUNCATEd relation's old file stays until the next checkpoint unlinks it,
    // so the count that disappears across the drop is the checkpoint's unlink backlog. Needs a superuser (CI's role).
    files: [`SELECT d.datname AS db, (SELECT count(*) FROM pg_ls_dir('base/' || d.oid) AS f) AS files
               FROM pg_database d WHERE d.datname LIKE 'hadron_test_r%' OR d.datname = $1 ORDER BY 2 DESC LIMIT 20`, [DB]],
    settings: [`SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers', 'track_io_timing', 'fsync', 'checkpoint_timeout', 'max_wal_size')`],
  }, 2_000);
  const cap = new Promise<{ error: string }>((resolve) => setTimeout(() => resolve({ error: 'reading capped at 2000ms' }), 2_000).unref());
  const result = await Promise.race([reading.catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'unknown' })), cap]);
  return { readMs: Math.round(performance.now() - started), ...result };
}

// Each read is independent: one failing (say pg_stat_checkpointer on an older server) never hides the others.
async function dropSnapshot(dropperPid: number | null | undefined) {
  const probe = new Client({
    connectionString: urlFor(new URL(maintenanceUrl()).username, 'postgres'),
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  await probe.connect();
  try {
    const read = async (sql: string, params: unknown[] = []) => {
      try {
        return (await probe.query(sql, params)).rows;
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'unknown' };
      }
    };
    return {
      dropperPid: dropperPid ?? null,
      activity: await read(
        `SELECT pid, datname, state, backend_type, wait_event_type, wait_event,
                round(extract(epoch FROM now() - query_start)::numeric, 1) AS query_age_s, left(query, 80) AS query
           FROM pg_stat_activity
          WHERE pid = $1 OR datname = $2 OR backend_type IN ('checkpointer', 'background writer')
             OR query ~* '^\\s*(create|drop) database'
          ORDER BY pid LIMIT 50`,
        [dropperPid ?? 0, DB],
      ),
      ungrantedLocks: await read(`SELECT pid, locktype, mode, database, relation::regclass::text AS relation FROM pg_locks WHERE NOT granted LIMIT 50`),
      // pg_stat_checkpointer is PG17; CI's PG16 keeps the same counters in pg_stat_bgwriter (#4377).
      checkpointer: await read(`SELECT * FROM pg_stat_checkpointer`).then((r) => ('error' in r ? read(CHECKPOINT_COUNTERS) : r)),
    };
  } finally {
    await probe.end();
  }
}

describe('serve-role-smoke (#2413 S3)', { timeout: 120_000 }, () => {
  it('passes on a correctly granted serve role and leaves no fixture behind', async () => {
    const { code, out } = await smoke();
    expect(out).toContain('ok: the serve role passes every smoke check');
    expect(code).toBe(EXIT.OK);
    const left = await asOwner((c) => c.query(`SELECT (SELECT count(*) FROM memories WHERE id LIKE 'smk\\_%') + (SELECT count(*) FROM sessions WHERE id LIKE 'smk\\_%')
      + (SELECT count(*) FROM apps WHERE id LIKE 'smk\\_%') + (SELECT count(*) FROM secret_app_keys WHERE app_id LIKE 'smk\\_%') AS n`));
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('fails, naming the table, when one table grant is missing', async () => {
    await asOwner((c) => c.query(`REVOKE SELECT ON TABLE nodes FROM ${SERVE}`));
    try {
      const { code, out } = await smoke();
      expect(code).toBe(EXIT.FAILED);
      expect(out).toMatch(/FAIL .*nodes|FAIL read of every public table: no SELECT on nodes/);
    } finally {
      grant();
    }
  });

  it('fails when the serve role cannot take the store\'s share lock on secret_app_keys (#4553)', async () => {
    await asOwner((c) => c.query(`REVOKE UPDATE ON TABLE secret_app_keys FROM ${SERVE}`));
    try {
      const { code, out } = await smoke();
      expect(code).toBe(EXIT.FAILED);
      expect(out).toContain('FAIL App secret store');
    } finally {
      grant();
    }
  });

  it('fails when default privileges are gone (a later table is unusable)', async () => {
        await asOwner((c) =>
      c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public REVOKE ALL ON TABLES FROM ${SERVE}`),
    );
    try {
      const { code, out } = await smoke();
      expect(code).toBe(EXIT.FAILED);
      expect(out).toContain('FAIL a table the owner creates after the grants is usable');
    } finally {
      grant();
    }
  });

  it('fails when the serve role is handed the migrations ledger or TRUNCATE', async () => {
    await asOwner((c) => c.query(`GRANT SELECT ON TABLE _prisma_migrations TO ${SERVE}`));
    try {
      expect((await smoke()).out).toContain('FAIL SELECT on _prisma_migrations is refused');
    } finally {
      grant();
    }
    await asOwner((c) => c.query(`GRANT TRUNCATE ON TABLE worker_reference_fences TO ${SERVE}`));
    try {
      expect((await smoke()).out).toContain('FAIL TRUNCATE is refused');
    } finally {
      grant();
    }
  });

  it('a negative probe that unexpectedly SUCCEEDS is rolled back, not committed (P2, Andi)', async () => {
    await asOwner(async (c) => {
      await c.query(`INSERT INTO worker_reference_fences (subject_id) VALUES ('keep_fence')`);
      await c.query(`GRANT TRUNCATE ON TABLE worker_reference_fences TO ${SERVE}`);
      await c.query(`GRANT CREATE ON SCHEMA public TO ${SERVE}`);
    });
    try {
      const { code, out } = await smoke();
      expect(code).toBe(EXIT.FAILED);
      expect(out).toContain('FAIL TRUNCATE is refused');
      expect(out).toContain('FAIL CREATE TABLE is refused');
      const after = await asOwner((c) =>
        c.query(`SELECT (SELECT count(*) FROM worker_reference_fences WHERE subject_id = 'keep_fence')::int AS kept,
                        (SELECT count(*) FROM pg_class WHERE relname LIKE 'smoke_serve_made_%')::int AS made`),
      );
      expect(after.rows[0]).toEqual({ kept: 1, made: 0 });
    } finally {
      // A table the serve role (wrongly) created is owned by it; the superuser clears that before regranting.
      await admin(async (c) => {
        const made = await c.query(`SELECT relname FROM pg_class WHERE relname LIKE 'smoke_serve_made_%'`);
        for (const r of made.rows) await c.query(`DROP TABLE public."${r.relname}"`);
      }, DB);
      await asOwner(async (c) => {
        await c.query(`DELETE FROM worker_reference_fences WHERE subject_id = 'keep_fence'`);
        await c.query(`REVOKE CREATE ON SCHEMA public FROM ${SERVE}`);
      });
      grant();
    }
  });

  it('a cleanup error fails the lane instead of yielding success (P2, Andi)', async () => {
    await asOwner((c) =>
      c.query(`
        CREATE FUNCTION smk_block_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup blocked'; END $$;
        CREATE TRIGGER smk_block_cleanup BEFORE DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION smk_block_cleanup();`),
    );
    try {
      const { code, out } = await smoke();
      expect(out).toContain('FAIL cleanup');
      expect(code).toBe(EXIT.FAILED);
    } finally {
      await asOwner((c) =>
        c.query(`DROP TRIGGER smk_block_cleanup ON organizations; DROP FUNCTION smk_block_cleanup();
                 DELETE FROM organizations WHERE name LIKE 'smk-%'`),
      );
    }
  });

  it('refuses to run with the serve URL equal to the owner', async () => {
    const lines: string[] = [];
    const code = await main({ MIGRATE_DATABASE_URL: OWNER_URL, SERVE_DATABASE_URL: OWNER_URL }, (l) => lines.push(l));
    expect(code).toBe(EXIT.USAGE);
  });

  it('exits 2 when a URL is missing, and never prints the password', async () => {
    expect(await main({}, () => undefined)).toBe(EXIT.USAGE);
    const lines: string[] = [];
    const bad = new URL(serveUrl());
    bad.port = '1';
    const code = await main({ MIGRATE_DATABASE_URL: OWNER_URL, SERVE_DATABASE_URL: bad.toString() }, (l) => lines.push(l));
    expect(code).toBe(EXIT.CONNECT);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});

describe('the App secret store check locks a real, owner-seeded key row (#4553 N8)', () => {
  it('runs the store\'s FOR SHARE read on the fixture\'s own App, and refuses when it locks no row', async () => {
    const f = newFixture();
    expect(f.appId).toMatch(/^smk_app_/);
    const check = buildChecks(f, {} as Client).find((c) => c.name.startsWith('App secret store'))!;
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    const fake = (rowsFor: (sql: string) => number) => ({
      query: async (sql: string, params?: unknown[]) => {
        seen.push({ sql, params });
        const n = rowsFor(sql);
        return { rowCount: n, rows: Array.from({ length: n }, () => ({ key_version: 1 })) };
      },
    }) as unknown as Client;
    await check.run(fake((sql) => (/FOR SHARE/.test(sql) ? 1 : 0)));
    expect(seen.find((q) => /FOR SHARE/.test(q.sql))?.params).toEqual([f.appId]);
    await expect(check.run(fake(() => 0))).rejects.toThrow(/locked no App key row/);
  });
});

