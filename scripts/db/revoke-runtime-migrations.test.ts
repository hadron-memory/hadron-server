/** S2 uses the harness-owned worker DB; only its temporary roles/tables are owned here. */
import { randomBytes } from 'node:crypto';
import { Client, escapeIdentifier } from 'pg';
import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { main, revokeRuntimeMigrations } from './revoke-runtime-migrations.js';

// Observe actual fixture SQL, including teardown, so database cloning cannot return.
const fixtureSql: string[] = [];
const originalQuery = Client.prototype.query;
const querySpy = vi.spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
  const first = args[0];
  fixtureSql.push(typeof first === 'string' ? first : (first as { text?: string })?.text ?? '');
  return Reflect.apply(originalQuery, this, args);
});
afterAll(() => {
  try {
    expect(fixtureSql.filter(sql => /^\s*(?:CREATE|DROP)\s+DATABASE\b/i.test(sql))).toEqual([]);
  } finally {
    querySpy.mockRestore();
  }
});

// perWorkerDb.ts sets this before imports; use its existing disposable clone.
const workerUrl = process.env.DATABASE_URL!;
const suffix = randomBytes(5).toString('hex');
const owner = `s2_owner_${suffix}`, serve = `s2_serve_${suffix}`;
const quotedServe = `s2 serve "${suffix}`;
const nodeTable = `s2_nodes_${suffix}`;
const password = randomBytes(16).toString('hex');
const q = escapeIdentifier;
const createdRoles: string[] = [];
function url(user: string) {
  const value = new URL(workerUrl);
  value.username = user;
  value.password = password;
  return value.toString();
}
async function using<T>(connectionString: string, work: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString });
  await c.connect();
  try { return await work(c); } finally { await c.end(); }
}
beforeAll(async () => {
  await using(workerUrl, async c => {
    // db-push worker clones have no Prisma migration history. Never adopt or
    // delete a pre-existing table belonging to another fixture.
    expect((await c.query("SELECT to_regclass('public._prisma_migrations') AS relation")).rows[0].relation).toBeNull();
    for (const role of [owner, serve, quotedServe]) {
      await c.query(`CREATE ROLE ${q(role)} LOGIN NOSUPERUSER NOINHERIT PASSWORD '${password}'`);
      createdRoles.push(role);
    }
    await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${q(owner)}`);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${q(serve)}, ${q(quotedServe)}`);
  });
});
beforeEach(async () => {
  await using(url(owner), async c => {
    await c.query(`DROP TABLE IF EXISTS public._prisma_migrations, public.${q(nodeTable)}`);
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${q(serve)}`);
    await c.query(`CREATE TABLE public._prisma_migrations (id text); CREATE TABLE public.${q(nodeTable)} (id text)`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${q(nodeTable)} TO ${q(serve)}`);
  });
});
afterAll(async () => {
  // Only fixture-owned objects/grants in THIS worker DB, then its unique roles.
  // Any cleanup error is awaited and still fails the hook; no database DDL,
  // swallowed errors, or raised hook/test deadlines.
  await using(workerUrl, async c => {
    for (const role of createdRoles) await c.query(`DROP OWNED BY ${q(role)}`);
    for (const role of [...createdRoles].reverse()) await c.query(`DROP ROLE ${q(role)}`);
    expect((await c.query('SELECT count(*)::int AS count FROM pg_roles WHERE rolname = ANY($1::text[])', [createdRoles])).rows[0].count).toBe(0);
    expect((await c.query("SELECT to_regclass('public._prisma_migrations') AS relation")).rows[0].relation).toBeNull();
    expect((await c.query('SELECT to_regclass($1) AS relation', [`public.${q(nodeTable)}`])).rows[0].relation).toBeNull();
  });
});

async function expectFixtureGrants(c: Client) {
  const row = (await c.query(`SELECT
    has_table_privilege($1, 'public._prisma_migrations', 'SELECT,INSERT,UPDATE,DELETE') AS migration_access,
    has_table_privilege($1, $2, 'SELECT') AND has_table_privilege($1, $2, 'INSERT')
      AND has_table_privilege($1, $2, 'UPDATE') AND has_table_privilege($1, $2, 'DELETE') AS application_access`,
  [serve, `public.${q(nodeTable)}`])).rows[0];
  expect(row).toEqual({ migration_access: false, application_access: true });
}
it('uses the existing worker database without per-file database DDL', () => {
  expect(fixtureSql.filter(sql => /^\s*(?:CREATE|DROP)\s+DATABASE\b/i.test(sql))).toEqual([]);
});
it('role-before-migrate: revoke closes default-grant leak, preserves application grants, and is idempotent', async () => {
  await using(url(owner), async c => {
    await c.query(`DROP TABLE public._prisma_migrations, public.${q(nodeTable)}`);
    // The S1 default-table ACL creates this order hazard. Its complete grants
    // and verifier integration remain covered by the unchanged S1 test file.
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${q(serve)}`);
    await c.query(`CREATE TABLE public._prisma_migrations (id text); CREATE TABLE public.${q(nodeTable)} (id text)`);
    expect((await c.query("SELECT has_table_privilege($1, 'public._prisma_migrations', 'SELECT') AS held", [serve])).rows[0].held).toBe(true);
    await revokeRuntimeMigrations(c, serve);
    await revokeRuntimeMigrations(c, serve);
    await expectFixtureGrants(c);
  });
  await using(url(serve), async c => {
    await c.query(`INSERT INTO public.${q(nodeTable)} VALUES ('fixture')`);
    await expect(c.query('SELECT * FROM public._prisma_migrations')).rejects.toMatchObject({ code: '42501' });
  });
});
it('migrate-before-role grants and revoke compose; absent role is a no-op', async () => {
  await using(url(owner), async c => {
    await expectFixtureGrants(c);
    await revokeRuntimeMigrations(c, `absent_${suffix}`);
    await revokeRuntimeMigrations(c, serve);
    await expectFixtureGrants(c);
  });
});
it('CLI env contract uses owner URL and RUNTIME_ROLE_NAME', async () => {
  const logs: string[] = [];
  expect(await main({ DATABASE_URL: 'not-used', MIGRATE_DATABASE_URL: url(owner), RUNTIME_ROLE_NAME: serve }, l => logs.push(l))).toBe(0);
  expect(logs).toEqual([]);
});
it('missing config has a typed nonzero result without credentials', async () => {
  const logs: string[] = [];
  expect(await main({}, l => logs.push(l))).toBe(2);
  expect(logs).toEqual(['db.runtime_role.revoke_database_url_missing']);
});
it('connection failure never prints URL or password', async () => {
  const logs: string[] = [];
  expect(await main({ DATABASE_URL: 'postgresql://fixture:private-secret@127.0.0.1:1/missing' }, l => logs.push(l))).toBe(1);
  expect(logs).toEqual(['db.runtime_role.revoke_failed']);
});
it('owner-as-serve keeps migration-table access and ACLs on the same and next connection', async () => {
  await using(url(owner), async c => {
    const before = (await c.query("SELECT relacl::text FROM pg_class WHERE oid = 'public._prisma_migrations'::regclass")).rows;
    await revokeRuntimeMigrations(c, owner);
    await c.query('SELECT * FROM public._prisma_migrations');
    expect((await c.query("SELECT relacl::text FROM pg_class WHERE oid = 'public._prisma_migrations'::regclass")).rows).toEqual(before);
  });
  await using(url(owner), c => c.query('SELECT * FROM public._prisma_migrations'));
});
it('a table owner is protected even when it is not the connected user', async () => {
  await using(workerUrl, async c => {
    await c.query(`GRANT ALL ON public._prisma_migrations TO ${q(owner)}`);
    await revokeRuntimeMigrations(c, owner);
  });
  await using(url(owner), c => c.query('SELECT * FROM public._prisma_migrations'));
});
it('a role requiring identifier quoting gets only its migration-table grant revoked', async () => {
  await using(url(owner), async c => {
    await c.query(`GRANT SELECT ON public._prisma_migrations, public.${q(nodeTable)} TO ${q(quotedServe)}`);
    await revokeRuntimeMigrations(c, quotedServe);
    expect((await c.query("SELECT has_table_privilege($1, 'public._prisma_migrations', 'SELECT') AS held", [quotedServe])).rows[0].held).toBe(false);
    expect((await c.query('SELECT has_table_privilege($1, $2, \'SELECT\') AS held', [quotedServe, `public.${q(nodeTable)}`])).rows[0].held).toBe(true);
  });
});
