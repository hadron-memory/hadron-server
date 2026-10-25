/**
 * #2413 S1 acceptance: the grants file and the verifier, each against a
 * THROWAWAY database with a REAL second role (an owner/migrator and a serve
 * role, both created here and dropped after). Nothing touches the worker DB.
 *
 * Roles are cluster-level, so names carry a per-run suffix and teardown drops
 * the database before the roles.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintenanceUrl } from '../../src/test/dbWorkers.js';
import { EXIT, main, redact, verifyRuntimeRole } from './verify-runtime-role.js';

const GRANTS_SQL = fileURLToPath(new URL('../../prisma/runtime-role.sql', import.meta.url));
const suffix = randomBytes(4).toString('hex');
const OWNER = `rr_owner_${suffix}`;
const SERVE = `rr_serve_${suffix}`;
const OTHER = `rr_other_${suffix}`;
const DB = `rr_db_${suffix}`;
// pg_hba on this host wants SCRAM for non-superusers over TCP, so the throwaway roles carry a throwaway password.
const PASSWORD = randomBytes(12).toString('hex');

function urlFor(user: string, db: string): string {
  const u = new URL(maintenanceUrl());
  // Keep the admin's own credentials (CI's carry a password); the throwaway roles get the throwaway one.
  if (user !== u.username) {
    u.username = user;
    u.password = PASSWORD;
  }
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>, db = 'postgres'): Promise<T> {
  const c = new Client({ connectionString: urlFor(new URL(maintenanceUrl()).username, db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function asOwner<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: urlFor(OWNER, DB) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const applyGrants = (role = SERVE) =>
  execFileSync('psql', [urlFor(OWNER, DB), '-v', 'ON_ERROR_STOP=1', '-v', `serve_role=${role}`, '-q', '-f', GRANTS_SQL], {
    stdio: 'pipe',
  });

const verify = () => asOwner((c) => verifyRuntimeRole(c, SERVE));
const rules = async () => (await verify()).map((v) => v.rule);

/** A migrated-looking schema: ordinary tables, a sequence, a trigger table, and `_prisma_migrations`. */
const migrate = () =>
  asOwner((c) =>
    c.query(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (id text PRIMARY KEY, finished_at timestamptz);
      CREATE TABLE IF NOT EXISTS nodes (id text PRIMARY KEY, body text);
      CREATE TABLE IF NOT EXISTS edges (id serial PRIMARY KEY, node_id text REFERENCES nodes(id));
    `),
  );

/** The entrypoint step the S2 script runs after `migrate deploy`. */
const entrypointRevoke = () => asOwner((c) => c.query(`REVOKE ALL ON TABLE _prisma_migrations FROM ${SERVE}`));

async function resetDb() {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${DB} OWNER ${OWNER}`);
  });
}

beforeAll(async () => {
  await admin(async (c) => {
    for (const r of [OWNER, SERVE, OTHER]) await c.query(`CREATE ROLE ${r} LOGIN NOSUPERUSER NOINHERIT PASSWORD '${PASSWORD}'`);
  });
});

afterAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    for (const r of [OWNER, SERVE, OTHER]) await c.query(`DROP ROLE IF EXISTS ${r}`);
  });
});

describe('runtime-role.sql + verify-runtime-role (#2413 S1)', { timeout: 60_000 }, () => {
  describe('migrate-before-role', () => {
    beforeAll(async () => {
      await resetDb();
      await migrate();
      applyGrants();
    });

    it('a correct setup passes and exits 0', async () => {
      expect(await verify()).toEqual([]);
      const lines: string[] = [];
      const code = await main(['--role', SERVE], { MIGRATE_DATABASE_URL: urlFor(OWNER, DB) }, (l) => lines.push(l));
      expect(code).toBe(EXIT.OK);
      expect(lines.join('\n')).toContain('ok:');
    });

    it('is idempotent', async () => {
      applyGrants();
      applyGrants();
      expect(await verify()).toEqual([]);
    });

    it('the serve role really can do DML and cannot do DDL, TRUNCATE or touch _prisma_migrations', async () => {
      const c = new Client({ connectionString: urlFor(SERVE, DB) });
      await c.connect();
      try {
        await c.query(`INSERT INTO nodes VALUES ('a', 'x')`);
        await c.query(`UPDATE nodes SET body = 'y' WHERE id = 'a'`);
        await c.query(`INSERT INTO edges (node_id) VALUES ('a')`); // needs the sequence grant
        await c.query(`DELETE FROM edges`);
        await c.query(`DELETE FROM nodes`);
        await expect(c.query('TRUNCATE nodes')).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('CREATE TABLE t (i int)')).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('ALTER TABLE nodes ADD COLUMN z int')).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('SELECT * FROM _prisma_migrations')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.end();
      }
    });

    it('a table the next migration creates is usable with no follow-up step (default privileges)', async () => {
      await asOwner((c) => c.query('CREATE TABLE later (id serial PRIMARY KEY)'));
      expect(await verify()).toEqual([]);
    });

    it('a table missing its grant fails, naming the rule and the table', async () => {
      await asOwner((c) => c.query(`REVOKE DELETE ON nodes FROM ${SERVE}`));
      const v = await verify();
      expect(v.map((x) => x.rule)).toEqual(['missing-table-privilege']);
      expect(v[0].detail).toContain('public.nodes');
      applyGrants();
      expect(await verify()).toEqual([]);
    });

    it('a serve role holding TRUNCATE fails, naming the rule', async () => {
      await asOwner((c) => c.query(`GRANT TRUNCATE ON nodes TO ${SERVE}`));
      const v = await verify();
      expect(v.map((x) => x.rule)).toEqual(['forbidden-table-privilege']);
      expect(v[0].detail).toContain('TRUNCATE');
      applyGrants(); // the grants file removes a stray extra privilege too
      expect(await verify()).toEqual([]);
    });

    it('TRIGGER and REFERENCES are forbidden too', async () => {
      await asOwner((c) => c.query(`GRANT TRIGGER, REFERENCES ON edges TO ${SERVE}`));
      expect(await rules()).toEqual(['forbidden-table-privilege']);
      applyGrants();
    });

    it('a grant on _prisma_migrations fails (tested negative), table or column level', async () => {
      await asOwner((c) => c.query(`GRANT SELECT ON _prisma_migrations TO ${SERVE}`));
      const v = await verify();
      expect(v.map((x) => x.rule)).toEqual(['migrations-table-granted']);
      expect(v[0].detail).toContain('_prisma_migrations');
      applyGrants();
      expect(await verify()).toEqual([]);

      await asOwner((c) => c.query(`GRANT SELECT (id) ON _prisma_migrations TO ${SERVE}`));
      expect(await rules()).toEqual(['migrations-table-granted']);
      await entrypointRevoke();
      expect(await verify()).toEqual([]);
    });

    it('a relation owned by another role is reported', async () => {
      await asOwner((c) => c.query(`GRANT CREATE ON SCHEMA public TO ${OTHER}`));
      await admin((c) => c.query(`SET ROLE ${OTHER}; CREATE TABLE stray (id int); GRANT ALL ON stray TO ${SERVE}`), DB);
      const v = await verify();
      expect(v.map((x) => x.rule)).toContain('relation-not-owned-by-migrator');
      expect(v.find((x) => x.rule === 'relation-not-owned-by-migrator')!.detail).toContain('stray');
      await asOwner(async (c) => {
        await c.query(`DROP TABLE stray`);
        await c.query(`REVOKE CREATE ON SCHEMA public FROM ${OTHER}`);
      });
    });

    it('CREATE on the schema (even via PUBLIC), role attributes and owned objects each fail', async () => {
      await asOwner((c) => c.query('GRANT CREATE ON SCHEMA public TO PUBLIC'));
      expect(await rules()).toEqual(['create-privilege']);
      await asOwner((c) => c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'));

      await admin((c) => c.query(`ALTER ROLE ${SERVE} CREATEDB`));
      expect(await rules()).toEqual(['role-attributes']);
      await admin((c) => c.query(`ALTER ROLE ${SERVE} NOCREATEDB`));

      await admin((c) => c.query(`GRANT ${OTHER} TO ${SERVE}`));
      expect(await rules()).toEqual(['role-membership']);
      await admin((c) => c.query(`REVOKE ${OTHER} FROM ${SERVE}`));

      await admin((c) => c.query(`CREATE TABLE owned_by_serve (i int); ALTER TABLE owned_by_serve OWNER TO ${SERVE}`), DB);
      expect(await rules()).toEqual(expect.arrayContaining(['role-owns-objects', 'relation-not-owned-by-migrator']));
      await admin((c) => c.query('DROP TABLE owned_by_serve'), DB);

      expect(await verify()).toEqual([]);
    });
  });

  describe('role-before-migrate', () => {
    beforeAll(async () => {
      await resetDb();
      applyGrants(); // no tables yet: nothing to grant, default privileges armed
    });

    it('verify fails on _prisma_migrations until the entrypoint revoke runs, then passes', async () => {
      await migrate(); // default privileges hand the serve role DML on _prisma_migrations
      const v = await verify();
      expect(v.map((x) => x.rule)).toEqual(['migrations-table-granted']);
      await entrypointRevoke();
      expect(await verify()).toEqual([]);
    });

    it('re-running the grants file after migrate also fixes it', async () => {
      await asOwner((c) => c.query('CREATE TABLE more (id int)')); // gets DML by default
      await asOwner((c) => c.query(`GRANT SELECT ON _prisma_migrations TO ${SERVE}`));
      expect(await rules()).toEqual(['migrations-table-granted']);
      applyGrants();
      expect(await verify()).toEqual([]);
    });
  });

  describe('failure modes', () => {
    it('the grants file fails loudly when the serve role is absent', async () => {
      await resetDb();
      expect(() => applyGrants(`rr_nobody_${suffix}`)).toThrow(/does not exist/);
    });

    it('exits 4 and names the rule when the serve role is absent', async () => {
      const lines: string[] = [];
      const code = await main(['--role', `rr_nobody_${suffix}`], { MIGRATE_DATABASE_URL: urlFor(OWNER, DB) }, (l) =>
        lines.push(l),
      );
      expect(code).toBe(EXIT.ROLE_MISSING);
      expect(lines[0]).toContain('role-missing');
    });

    it('exits 1 with FAIL lines when a rule is violated', async () => {
      await migrate();
      applyGrants();
      await asOwner((c) => c.query(`GRANT TRUNCATE ON nodes TO ${SERVE}`));
      const lines: string[] = [];
      const code = await main(['--role', SERVE], { MIGRATE_DATABASE_URL: urlFor(OWNER, DB) }, (l) => lines.push(l));
      expect(code).toBe(EXIT.VIOLATIONS);
      expect(lines[0]).toMatch(/^FAIL forbidden-table-privilege:/);
    });

    it('exits 2 on a missing URL or a bad flag, 3 on a connection failure, and never prints the URL or password', async () => {
      const lines: string[] = [];
      const log = (l: string) => lines.push(l);
      expect(await main([], {}, log)).toBe(EXIT.USAGE);
      expect(await main(['--nope'], { DATABASE_URL: urlFor(OWNER, DB) }, log)).toBe(EXIT.USAGE);

      const bad = new URL(urlFor(OWNER, DB));
      bad.password = 'hunter2-secret';
      bad.port = '1'; // nothing listens here
      expect(await main([], { MIGRATE_DATABASE_URL: bad.toString() }, log)).toBe(EXIT.CONNECT);
      const text = lines.join('\n');
      expect(text).not.toContain('hunter2-secret');
      expect(text).not.toContain('postgres://');
      expect(text).not.toContain('postgresql://');
    });

    it('redact strips URLs and known passwords from arbitrary text', () => {
      expect(redact('boom postgresql://u:p@h:5432/d?x=1 end')).toBe('boom <redacted-url> end');
      expect(redact('password hunter2 leaked', ['hunter2'])).toBe('password <redacted> leaked');
    });
  });
});
