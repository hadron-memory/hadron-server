/**
 * #3770: the REAL boot path for a migration whose preflight refuses on data.
 *
 * scripts/docker-start.sh runs unmodified, and so do real `prisma migrate deploy` / `migrate resolve` and the real
 * resolve-refused-migrations.ts against a scratch Postgres database with a colliding row set. Only the steps that
 * have nothing to do with migrations are stubbed (generate, revoke, upsert, verify) and the server itself (a marker
 * line instead of `tsx src/index.ts`). Before #3770 a refusing preflight exited 1 and every restart hit P3009 (the
 * 2026-11-08 outage, #3236); a mocked `migrate deploy` could not show that.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintenanceUrl } from '../../src/test/dbWorkers.js';
import { endsImplicitTransaction } from './migrationTransaction.js';
import { REFUSAL_SQLSTATE, refusedMigrationNames } from './resolve-refused-migrations.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRYPOINT = join(ROOT, 'scripts/docker-start.sh');
const PRISMA = join(ROOT, 'node_modules/.bin/prisma');
const suffix = randomBytes(4).toString('hex');
const DB = `refuse_boot_${suffix}`;
const dir = mkdtempSync(join(tmpdir(), 'refused-boot-'));
const prismaDir = join(dir, 'prisma');
const serverLog = join(dir, 'server-started');

const dbUrl = (db: string) => { const u = new URL(maintenanceUrl()); u.pathname = `/${db}`; return u.toString(); };
const URL_UNDER_TEST = dbUrl(DB);

async function sql<T = unknown>(db: string, text: string): Promise<T[]> {
  const c = new Client({ connectionString: dbUrl(db) });
  await c.connect();
  try { return (await c.query(text)).rows as T[]; } finally { await c.end(); }
}

function writeMigration(name: string, body: string) {
  mkdirSync(join(prismaDir, 'migrations', name), { recursive: true });
  writeFileSync(join(prismaDir, 'migrations', name, 'migration.sql'), body);
}
const REFUSING = `DO $$ BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM msgs GROUP BY chat, seq HAVING count(*) > 1) c) > 0 THEN
    RAISE EXCEPTION 'preflight: colliding (chat, seq) groups remain' USING ERRCODE = '${REFUSAL_SQLSTATE}';
  END IF;
END $$;
CREATE UNIQUE INDEX msgs_seq_unique ON msgs (chat, seq);`;
const REFUSED = '20260101000100_refusing_preflight';

beforeAll(async () => {
  mkdirSync(join(prismaDir, 'migrations'), { recursive: true });
  writeFileSync(join(prismaDir, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  writeFileSync(join(prismaDir, 'migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  writeFileSync(join(dir, 'prisma.config.ts'), `import { defineConfig, env } from "prisma/config";
export default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, engine: "classic", datasource: { url: env("DATABASE_URL") } });
`);
  writeMigration('20260101000000_msgs', 'CREATE TABLE msgs (chat text, seq int);');
  // The shim for `pnpm`: real prisma and the real helper for the migration steps, no-ops for the rest.
  const shim = join(dir, 'bin');
  mkdirSync(shim);
  writeFileSync(join(shim, 'pnpm'), `#!/bin/sh
case "$*" in
  "prisma generate"|tsx\\ scripts/db/revoke-runtime-migrations.ts|tsx\\ scripts/db/upsert-actions.ts|tsx\\ scripts/db/verify-runtime-role.ts) exit 0 ;;
  "tsx src/index.ts") echo "started $HADRON_MIGRATIONS_REFUSED" >> "${serverLog}"; exit 0 ;;
  "prisma migrate"*) shift && cd "${dir}" && exec "${PRISMA}" "$@" --config "${dir}/prisma.config.ts" ;;
  "tsx scripts/db/resolve-refused-migrations.ts") printf 'Already up to date\\nDone in 215ms using pnpm v11.5.2\\n'; cd "${ROOT}" && exec "${ROOT}node_modules/.bin/tsx" scripts/db/resolve-refused-migrations.ts ;;
esac
echo "unexpected pnpm call: $*" >&2; exit 99
`);
  chmodSync(join(shim, 'pnpm'), 0o700);
  const c = new Client({ connectionString: dbUrl('postgres') });
  await c.connect();
  await c.query(`CREATE DATABASE ${DB}`);
  await c.end();
}, 60_000);

afterAll(async () => {
  const c = new Client({ connectionString: dbUrl('postgres') });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await c.end();
  rmSync(dir, { recursive: true, force: true });
});

function deploy() {
  return spawnSync(PRISMA, ['migrate', 'deploy', '--config', join(dir, 'prisma.config.ts')], {
    encoding: 'utf8', cwd: dir, env: { ...process.env, DATABASE_URL: URL_UNDER_TEST } });
}

function boot() {
  rmSync(serverLog, { force: true });
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DATABASE_URL: URL_UNDER_TEST, TMPDIR: dir };
  delete env.MIGRATE_DATABASE_URL;
  const run = spawnSync('sh', [ENTRYPOINT], { encoding: 'utf8', env, cwd: ROOT, timeout: 120_000 });
  return { ...run, served: existsSync(serverLog) && readFileSync(serverLog, 'utf8').includes('started') };
}
const tables = async () => (await sql<{ t: string }>(DB, `SELECT tablename AS t FROM pg_tables WHERE schemaname='public'`)).map(r => r.t);
const indexExists = async () => (await sql(DB, `SELECT 1 FROM pg_indexes WHERE indexname='msgs_seq_unique'`)).length > 0;

describe('#3770 refusing preflight through the real migrate-deploy + boot path', () => {
  it('a colliding set: boot survives the refusal, names it once, applies nothing past it', async () => {
    // The table exists and holds a colliding pair BEFORE the refusing migration ships, as in production.
    const first = deploy();
    expect(first.status, first.stderr).toBe(0);
    await sql(DB, `INSERT INTO msgs VALUES ('a', 1), ('a', 1)`);
    writeMigration(REFUSED, REFUSING);
    writeMigration('20260101000200_later', 'CREATE TABLE later_table (id int);');
    const run = boot();
    expect(run.stderr).not.toContain('P3009');
    expect(run.status, run.stderr).toBe(0);
    expect(run.served).toBe(true);
    const alarms = run.stderr.split('\n').filter(l => l.startsWith('db.migration.refused_preflight'));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain(`migration=${REFUSED}`);
    expect(readFileSync(serverLog, 'utf8').trim()).toBe(`started ${REFUSED}`); // the serving process is told
    expect(await indexExists()).toBe(false);
    expect(await tables()).not.toContain('later_table');
    expect(run.stderr).not.toContain(URL_UNDER_TEST);
  }, 180_000);

  it('a second boot after the refusal is still served, never P3009, and alarms once more', async () => {
    const run = boot();
    expect(run.stderr).not.toContain('P3009');
    expect(run.status, run.stderr).toBe(0);
    expect(run.served).toBe(true);
    expect(run.stderr.split('\n').filter(l => l.startsWith('db.migration.refused_preflight'))).toHaveLength(1);
    expect(await indexExists()).toBe(false);
  }, 180_000);

  it('boot also recovers from the failed-migration state the old entrypoint left behind (P3009 on entry)', () => {
    const failed = deploy();
    expect(`${failed.stdout}${failed.stderr}`).toContain('P3018'); // leaves an unfinished ledger row
    { const blocked = deploy(); expect(`${blocked.stdout}${blocked.stderr}`).toContain('P3009'); } // exactly what blocked every restart in the outage
    const run = boot();
    // The entry state is reported once, legibly, and boot carries on instead of exiting into a restart loop.
    expect(run.stderr.match(/migrate_failed exit=1 prisma=P3009/g)).toHaveLength(1);
    expect(run.status, run.stderr).toBe(0);
    expect(run.served).toBe(true);
    expect(run.stderr).toContain(`migration=${REFUSED}`);
  }, 180_000);

  it('a failure left by an earlier boot is retried once: repaired data applies it with no alarm', async () => {
    const failed = deploy(); // the data is still colliding, so this leaves an unfinished ledger row again
    expect(`${failed.stdout}${failed.stderr}`).toContain('P3018');
    await sql(DB, `DELETE FROM msgs WHERE ctid = (SELECT max(ctid) FROM msgs WHERE chat = 'a' AND seq = 1)`);
    const run = boot();
    expect(run.stderr.match(/migrate_failed exit=1 prisma=P3009/g)).toHaveLength(1);
    expect(run.status, run.stderr).toBe(0);
    expect(run.served).toBe(true);
    expect(run.stderr).not.toContain('db.migration.refused_preflight');
    expect(await indexExists()).toBe(true);
    expect(await tables()).toContain('later_table');
  }, 180_000);

  it('a failure that is NOT a refusal still stops boot', async () => {
    const bad = `${DB}_bad`;
    const c = new Client({ connectionString: dbUrl('postgres') });
    await c.connect();
    await c.query(`CREATE DATABASE ${bad}`);
    await c.end();
    try {
      writeMigration('20260101000300_broken', 'THIS IS NOT SQL;');
      rmSync(serverLog, { force: true });
      const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DATABASE_URL: dbUrl(bad), TMPDIR: dir };
      delete env.MIGRATE_DATABASE_URL;
      const run = spawnSync('sh', [ENTRYPOINT], { encoding: 'utf8', env, cwd: ROOT, timeout: 120_000 });
      expect(run.status).not.toBe(0);
      expect(existsSync(serverLog)).toBe(false);
      expect(run.stderr).not.toContain('db.migration.refused_preflight');
    } finally {
      rmSync(join(prismaDir, 'migrations/20260101000300_broken'), { recursive: true, force: true });
      const d = new Client({ connectionString: dbUrl('postgres') });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS ${bad} WITH (FORCE)`);
      await d.end();
    }
  }, 180_000);
});

describe('refusedMigrationNames', () => {
  const refused = { migration_name: '20260101000100_x', logs: `a\nDatabase error code: ${REFUSAL_SQLSTATE}\nb` };
  it('names only refusals, and only when every unfinished migration is one', () => {
    expect(refusedMigrationNames([refused])).toEqual(['20260101000100_x']);
    expect(refusedMigrationNames([])).toBeNull();
    expect(refusedMigrationNames([refused, { migration_name: '20260101000200_y', logs: 'Database error code: 42601' }])).toBeNull();
    expect(refusedMigrationNames([{ migration_name: '20260101000200_y', logs: null }])).toBeNull();
  });
  it('rejects a name that is not a migration directory name, and a marker that is only a substring', () => {
    expect(refusedMigrationNames([{ ...refused, migration_name: 'x; rm -rf /' }])).toBeNull();
    expect(refusedMigrationNames([{ ...refused, logs: `see Database error code: ${REFUSAL_SQLSTATE} here` }])).toBeNull();
  });
});

// Blind review P2 (Dorian, #3772): the HDPRF code alone does not prove nothing was applied before the raise. What
// does is that Prisma runs a migration file as ONE implicit transaction, so a raise rolls back every statement above
// it. Pin both halves: the mechanism, and a guard that no HDPRF migration opts out of it.
describe('#3770 a refusal leaves no partial schema', () => {
  it('the opt-out detector sees what it must and ignores a DO block', () => {
    for (const bad of ['CREATE TABLE a(i int);\nCOMMIT;\n', 'CREATE TABLE a(i int); COMMIT;', 'COMMIT AND CHAIN;', 'x; commit and no chain;',
      'ROLLBACK;', 'ABORT;', 'END;', 'x; END TRANSACTION;', 'BEGIN;\nCREATE TABLE a(i int);', 'begin transaction;', 'START TRANSACTION;',
      'CREATE INDEX CONCURRENTLY i ON t(c);',
      // a comment marker inside a string must not hide the real COMMIT after it (blind/local delta 2)
      "SELECT '--'; COMMIT;", "SELECT '/*'; COMMIT; SELECT '*/';", "SELECT E'\\'--'; COMMIT;", 'SELECT "--"; COMMIT;',
      '/* a /* nested */ still comment */ COMMIT;', "DO $a$ BEGIN NULL; END $a$; COMMIT;", "SELECT $$--$$; COMMIT;",
      // non-ASCII dollar tags (blind delta 3): two quoted apostrophes must not swallow the COMMIT between them
      "SELECT $é$'$é$; COMMIT; SELECT $é$'$é$;", "SELECT $日本$'$日本$; COMMIT; SELECT $日本$'$日本$;", "SELECT $😀$'$😀$; COMMIT; SELECT $😀$'$😀$;"]) {
      expect(endsImplicitTransaction(bad), bad).toBe(true);
    }
    for (const ok of ["DO $$ BEGIN RAISE EXCEPTION 'x'; END $$;", "DO $$\nBEGIN\n  RAISE EXCEPTION 'x';\nEND $$;",
      "DO $$ BEGIN RAISE EXCEPTION 'will commit later'; END $$; -- COMMIT", '/* COMMIT */ SELECT 1;', "SELECT 'COMMIT; END;';",
      "DO $f$ BEGIN IF true THEN NULL; END IF; END $f$;", "DO $é$ BEGIN NULL; END $é$;", "SELECT $日本$ COMMIT; $日本$;", 'CREATE TABLE "commit" (i int);', 'SELECT 1 -- BEGIN; END;']) {
      expect(endsImplicitTransaction(ok), ok).toBe(false);
    }
  });

  it('statements before the raise are rolled back with it (one implicit transaction per migration file)', async () => {
    const pdb = `${DB}_partial`;
    const pdir = mkdtempSync(join(tmpdir(), 'refused-partial-'));
    const c = new Client({ connectionString: dbUrl('postgres') });
    await c.connect();
    await c.query(`CREATE DATABASE ${pdb}`);
    await c.end();
    try {
      mkdirSync(join(pdir, 'prisma/migrations/20260101000000_mutate_then_refuse'), { recursive: true });
      writeFileSync(join(pdir, 'prisma/schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
      writeFileSync(join(pdir, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
      writeFileSync(join(pdir, 'prisma/migrations/20260101000000_mutate_then_refuse/migration.sql'),
        `CREATE TABLE partial_t (id int);\nINSERT INTO partial_t VALUES (1);\nDO $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '${REFUSAL_SQLSTATE}'; END $$;\n`);
      writeFileSync(join(pdir, 'prisma.config.ts'), `import { defineConfig, env } from "prisma/config";
export default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, engine: "classic", datasource: { url: env("DATABASE_URL") } });
`);
      const run = spawnSync(PRISMA, ['migrate', 'deploy', '--config', join(pdir, 'prisma.config.ts')], {
        encoding: 'utf8', cwd: pdir, env: { ...process.env, DATABASE_URL: dbUrl(pdb) } });
      expect(`${run.stdout}${run.stderr}`).toContain('P3018');
      const found = await sql<{ t: string }>(pdb, `SELECT tablename AS t FROM pg_tables WHERE schemaname='public' AND tablename='partial_t'`);
      expect(found).toEqual([]);
    } finally {
      rmSync(pdir, { recursive: true, force: true });
      const d = new Client({ connectionString: dbUrl('postgres') });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS ${pdb} WITH (FORCE)`);
      await d.end();
    }
  }, 60_000);

  it('no checked-in migration that raises HDPRF opts out of the transaction', async () => {
    const { readdirSync } = await import('node:fs');
    const migrations = join(ROOT, 'prisma/migrations');
    for (const name of readdirSync(migrations)) {
      const file = join(migrations, name, 'migration.sql');
      if (!existsSync(file)) continue;
      const body = readFileSync(file, 'utf8');
      if (!body.includes(REFUSAL_SQLSTATE)) continue;
      expect(endsImplicitTransaction(body), `${name} raises ${REFUSAL_SQLSTATE} but ends the implicit transaction`).toBe(false);
    }
  });
});
