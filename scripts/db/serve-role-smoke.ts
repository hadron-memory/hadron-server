/**
 * Serve-role smoke — #2413 S3 (plan §3.6).
 *
 * Proves the NON-OWNER serve role can do what the server does, on a database
 * the real `migrate deploy` path built. Not the vitest harness: that clones
 * databases as a superuser and TRUNCATEs, neither of which the serve role may do.
 *
 *   MIGRATE_DATABASE_URL=… SERVE_DATABASE_URL=… pnpm tsx scripts/db/serve-role-smoke.ts
 *
 * Two connections: the OWNER (`MIGRATE_DATABASE_URL`, else `DATABASE_URL`) sets
 * up and removes fixtures; the SERVE connection (`SERVE_DATABASE_URL`) makes
 * every assertion. The owner is the migrator that owns every `public` relation.
 *
 * Positive checks: node create/update/delete, memory create, session start (the
 * trigger-guarded write), a job-style read-modify-write, an advisory lock, a
 * worker-reference fence write, a read of EVERY public table (so a table the
 * serve role cannot SELECT fails here, by name), and a table the owner creates
 * AFTER the grants (the default-privileges proof). Negative checks: SQLSTATE
 * 42501 on TRUNCATE, ALTER TABLE, DROP TRIGGER, CREATE TABLE and a SELECT on
 * `_prisma_migrations`.
 *
 * Exit codes: 0 all hold, 1 an assertion failed (each printed `FAIL <name>`),
 * 2 usage/config, 3 could not connect. Nothing prints a URL or password.
 */
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { pathToFileURL } from 'node:url';
import { redact } from './verify-runtime-role.js';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, CONNECT: 3 } as const;

const INSUFFICIENT_PRIVILEGE = '42501';

interface Check {
  name: string;
  run: (serve: Client) => Promise<void>;
}

/**
 * The serve role must be refused with 42501; any other outcome (including success) is a failure. The probe runs
 * inside a transaction that is ALWAYS rolled back, so a statement that unexpectedly succeeds (a serve role that is
 * too privileged) is undone instead of committed into the lane's database.
 */
async function expectRefused(serve: Client, sql: string): Promise<void> {
  let outcome: string | undefined;
  await serve.query('BEGIN');
  try {
    await serve.query(sql);
    outcome = 'expected 42501, but the statement succeeded (rolled back)';
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== INSUFFICIENT_PRIVILEGE) outcome = `expected 42501, got ${code ?? 'a non-database error'}`;
  } finally {
    await serve.query('ROLLBACK');
  }
  if (outcome) throw new Error(outcome);
}

async function inTx<T>(serve: Client, fn: () => Promise<T>): Promise<T> {
  await serve.query('BEGIN');
  try {
    const out = await fn();
    await serve.query('COMMIT');
    return out;
  } catch (err) {
    await serve.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export interface Fixture {
  tag: string;
  userId: string;
  orgId: string;
  memoryId: string;
  nodeId: string;
  sessionId: string;
  probeTable: string;
  fenceId: string;
}

export function newFixture(): Fixture {
  const tag = randomBytes(5).toString('hex');
  return {
    tag,
    userId: `smk_user_${tag}`,
    orgId: `smk_org_${tag}`,
    memoryId: `smk_mem_${tag}`,
    nodeId: `smk_node_${tag}`,
    sessionId: `smk_sess_${tag}`,
    probeTable: `serve_smoke_probe_${tag}`,
    fenceId: `smk_fence_${tag}`,
  };
}

export function buildChecks(f: Fixture, owner: Client): Check[] {
  return [
    {
      name: 'memory create',
      run: async (s) => {
        await s.query(
          `INSERT INTO memories (id, organization_id, urn, name, class, updated_at)
           VALUES ($1, $2, $3, $4, 'knowledge', now())`,
          [f.memoryId, f.orgId, `smk-${f.tag}`, `smk-${f.tag}`],
        );
      },
    },
    {
      name: 'node create (fires the revision and content-hash triggers)',
      run: async (s) => {
        await s.query(
          `INSERT INTO nodes (id, memory_id, name, loc, updated_at) VALUES ($1, $2, 'smoke', $3, now())`,
          [f.nodeId, f.memoryId, `smoke-${f.tag}`],
        );
        const rev = await s.query(`SELECT count(*)::int AS n FROM node_revisions WHERE node_id = $1`, [f.nodeId]);
        if (typeof rev.rows[0].n !== 'number') throw new Error('node_revisions not readable');
      },
    },
    {
      name: 'node update',
      run: async (s) => {
        const r = await s.query(`UPDATE nodes SET name = 'smoke-edited', updated_at = now() WHERE id = $1`, [f.nodeId]);
        if (r.rowCount !== 1) throw new Error('update touched no row');
      },
    },
    {
      name: 'job-style read-modify-write under a row lock',
      run: (s) =>
        inTx(s, async () => {
          const got = await s.query(`SELECT name FROM nodes WHERE id = $1 FOR UPDATE`, [f.nodeId]);
          if (got.rowCount !== 1) throw new Error('row not found');
          await s.query(`UPDATE nodes SET name = $2, updated_at = now() WHERE id = $1`, [f.nodeId, `${got.rows[0].name}-rmw`]);
        }),
    },
    {
      name: 'advisory lock',
      run: (s) =>
        inTx(s, async () => {
          await s.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [f.memoryId, `smoke-${f.tag}`]);
        }),
    },
    {
      name: 'session start (trigger-guarded insert)',
      run: async (s) => {
        await s.query(`INSERT INTO sessions (id) VALUES ($1)`, [f.sessionId]);
        await s.query(`UPDATE sessions SET branch = 'smoke', updated_at = now() WHERE id = $1`, [f.sessionId]);
      },
    },
    {
      name: 'worker-reference fence write',
      run: async (s) => {
        await s.query(
          `INSERT INTO worker_reference_fences (subject_id) VALUES ($1)
             ON CONFLICT (subject_id) DO UPDATE SET version = worker_reference_fences.version + 1`,
          [f.fenceId],
        );
        await s.query(
          `INSERT INTO worker_reference_fences (subject_id) VALUES ($1)
             ON CONFLICT (subject_id) DO UPDATE SET version = worker_reference_fences.version + 1`,
          [f.fenceId],
        );
      },
    },
    {
      name: 'read of every public table (trigger-guarded ones included)',
      run: async (s) => {
        const tables = (
          await owner.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
              ORDER BY c.relname`,
          )
        ).rows as { relname: string }[];
        const denied: string[] = [];
        for (const t of tables) {
          try {
            await s.query(`SELECT 1 FROM "${t.relname.replace(/"/g, '""')}" LIMIT 1`);
          } catch (err) {
            if ((err as { code?: string }).code === INSUFFICIENT_PRIVILEGE) denied.push(t.relname);
            else throw err;
          }
        }
        if (denied.length) throw new Error(`no SELECT on ${denied.slice(0, 5).join(', ')}${denied.length > 5 ? ` (+${denied.length - 5} more)` : ''}`);
      },
    },
    {
      name: 'a table the owner creates after the grants is usable (default privileges)',
      run: async (s) => {
        await owner.query(`CREATE TABLE ${f.probeTable} (id serial PRIMARY KEY, v text)`);
        await s.query(`INSERT INTO ${f.probeTable} (v) VALUES ('a')`);
        await s.query(`UPDATE ${f.probeTable} SET v = 'b'`);
        await s.query(`SELECT id, v FROM ${f.probeTable}`);
        await s.query(`DELETE FROM ${f.probeTable}`);
      },
    },
    {
      name: 'node delete',
      run: async (s) => {
        const r = await s.query(`DELETE FROM nodes WHERE id = $1`, [f.nodeId]);
        if (r.rowCount !== 1) throw new Error('delete touched no row');
      },
    },
    { name: 'TRUNCATE is refused (42501)', run: (s) => expectRefused(s, 'TRUNCATE worker_reference_fences') },
    { name: 'ALTER TABLE is refused (42501)', run: (s) => expectRefused(s, 'ALTER TABLE nodes ADD COLUMN smoke_x integer') },
    { name: 'DROP TRIGGER is refused (42501)', run: (s) => expectRefused(s, 'DROP TRIGGER nodes_comment_insert ON nodes') },
    { name: 'CREATE TABLE is refused (42501)', run: (s) => expectRefused(s, `CREATE TABLE smoke_serve_made_${f.tag} (id int)`) },
    { name: 'SELECT on _prisma_migrations is refused (42501)', run: (s) => expectRefused(s, 'SELECT 1 FROM _prisma_migrations') },
  ];
}

/**
 * Owner-side removal. Each step is independent so a failed one never hides the rest, and every failure is
 * RETURNED: a lane that cannot clean up after itself leaves fixtures in the database and must not pass.
 */
export async function cleanup(owner: Client, f: Fixture): Promise<string[]> {
  const steps: [string, unknown[]][] = [
    [`DROP TABLE IF EXISTS ${f.probeTable}`, []],
    [`DELETE FROM sessions WHERE id = $1`, [f.sessionId]],
    [`DELETE FROM worker_reference_fences WHERE subject_id = $1`, [f.fenceId]],
    [`DELETE FROM nodes WHERE memory_id = $1`, [f.memoryId]],
    [`DELETE FROM memories WHERE id = $1`, [f.memoryId]],
    [`DELETE FROM organizations WHERE id = $1`, [f.orgId]],
    [`DELETE FROM users WHERE id = $1`, [f.userId]],
  ];
  const errors: string[] = [];
  for (const [sql, params] of steps) {
    try {
      await owner.query(sql, params);
    } catch (err) {
      errors.push(`${sql.split(' WHERE')[0]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const ownerUrl = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  const serveUrl = env.SERVE_DATABASE_URL;
  if (!ownerUrl || !serveUrl) {
    log('config: set SERVE_DATABASE_URL and MIGRATE_DATABASE_URL (or DATABASE_URL)');
    return EXIT.USAGE;
  }
  const secrets: string[] = [];
  for (const u of [ownerUrl, serveUrl]) {
    try {
      secrets.push(decodeURIComponent(new URL(u).password));
    } catch {
      log('config: a database URL is not a valid URL');
      return EXIT.USAGE;
    }
  }

  const owner = new Client({ connectionString: ownerUrl });
  const serve = new Client({ connectionString: serveUrl });
  const f = newFixture();
  let failed = 0;
  let fixturesStarted = false;
  try {
    try {
      await owner.connect();
      await serve.connect();
    } catch (err) {
      log(redact(`connect failed: ${err instanceof Error ? err.message : String(err)}`, secrets));
      return EXIT.CONNECT;
    }
    const who = (await serve.query('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su')).rows[0];
    const ownerWho = (await owner.query('SELECT current_user AS u')).rows[0];
    if (who.su || who.u === ownerWho.u) {
      log(`config: the serve connection must be a non-superuser role other than the owner (it is ${who.u})`);
      return EXIT.USAGE;
    }

    fixturesStarted = true;
    await owner.query(`INSERT INTO users (id, updated_at) VALUES ($1, now())`, [f.userId]);
    await owner.query(`INSERT INTO organizations (id, name, urn, updated_at) VALUES ($1, $2, $3, now())`, [f.orgId, `smk-${f.tag}`, `smk-${f.tag}`]);

    for (const check of buildChecks(f, owner)) {
      try {
        await check.run(serve);
        log(`ok   ${check.name}`);
      } catch (err) {
        failed++;
        log(redact(`FAIL ${check.name}: ${err instanceof Error ? err.message : String(err)}`, secrets));
      }
    }
  } catch (err) {
    failed++;
    log(redact(`FAIL smoke setup: ${err instanceof Error ? err.message : String(err)}`, secrets));
  } finally {
    if (fixturesStarted) {
      for (const e of await cleanup(owner, f)) {
        failed++;
        log(redact(`FAIL cleanup: ${e}`, secrets));
      }
    }
    await serve.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
  log(failed ? `${failed} check(s) failed` : 'ok: the serve role passes every smoke check');
  return failed ? EXIT.FAILED : EXIT.OK;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.env, (l) => console.log(l));
}
