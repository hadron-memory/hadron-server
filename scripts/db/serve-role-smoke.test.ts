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
import { EXIT, main } from './serve-role-smoke.js';

const GRANTS_SQL = fileURLToPath(new URL('../../prisma/runtime-role.sql', import.meta.url));
const suffix = randomBytes(4).toString('hex');
const OWNER = `smk_owner_${suffix}`;
const SERVE = `smk_serve_${suffix}`;
const DB = `smk_db_${suffix}`;
const PASSWORD = randomBytes(12).toString('hex');

// The grants file refuses a superuser runner, so the owner is a real non-superuser role that owns a database
// built from scratch (db push + post-push.sql), the way the CI lane builds its own.
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

afterAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    for (const r of [OWNER, SERVE]) await c.query(`DROP ROLE IF EXISTS ${r}`);
  });
});

describe('serve-role-smoke (#2413 S3)', { timeout: 120_000 }, () => {
  it('passes on a correctly granted serve role and leaves no fixture behind', async () => {
    const { code, out } = await smoke();
    expect(out).toContain('ok: the serve role passes every smoke check');
    expect(code).toBe(EXIT.OK);
    const left = await asOwner((c) => c.query(`SELECT (SELECT count(*) FROM memories WHERE id LIKE 'smk\\_%') + (SELECT count(*) FROM sessions WHERE id LIKE 'smk\\_%') AS n`));
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
    await asOwner((c) => c.query(`GRANT TRUNCATE ON TABLE nodes TO ${SERVE}`));
    try {
      expect((await smoke()).out).toContain('FAIL TRUNCATE is refused');
    } finally {
      grant();
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
