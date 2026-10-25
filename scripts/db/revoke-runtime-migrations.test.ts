/** S2 post-migrate revoke: disposable DB/roles, never the development database. */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, escapeIdentifier } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { maintenanceUrl } from '../../src/test/dbWorkers.js';
import { main, revokeRuntimeMigrations } from './revoke-runtime-migrations.js';
import { verifyRuntimeRole } from './verify-runtime-role.js';

const suffix = randomBytes(5).toString('hex');
const owner = `s2_owner_${suffix}`, serve = `s2_serve_${suffix}`, database = `s2_db_${suffix}`;
const quotedServe = `s2 serve \"${suffix}`;
const password = randomBytes(16).toString('hex');
const q = escapeIdentifier;
function url(user: string, db = database) {
  const value = new URL(maintenanceUrl());
  if (user !== value.username) { value.username = user; value.password = password; }
  value.pathname = `/${db}`;
  return value.toString();
}
async function using<T>(connectionString: string, work: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString });
  await c.connect();
  try { return await work(c); } finally { await c.end(); }
}
const adminUrl = () => url(new URL(maintenanceUrl()).username, 'postgres');
const grants = () => execFileSync('psql', [url(owner), '-v', 'ON_ERROR_STOP=1', '-v', `serve_role=${serve}`, '-q', '-f',
  fileURLToPath(new URL('../../prisma/runtime-role.sql', import.meta.url))], { stdio: 'pipe' });
beforeAll(async () => {
  await using(adminUrl(), async c => {
    for (const role of [owner, serve, quotedServe]) await c.query(`CREATE ROLE ${q(role)} LOGIN NOSUPERUSER NOINHERIT PASSWORD '${password}'`);
    await c.query(`CREATE DATABASE ${q(database)} OWNER ${q(owner)}`);
  });
});
// Full-suite four-worker QA exceeded the default 10s while dropping this DB.
// Bound cleanup separately; assertions keep their original test timeout and
// cleanup/query errors still reject this hook and fail the suite.
afterAll(async () => {
  await using(adminUrl(), async c => {
    await c.query(`DROP DATABASE IF EXISTS ${q(database)} WITH (FORCE)`);
    for (const role of [serve, quotedServe, owner]) await c.query(`DROP ROLE IF EXISTS ${q(role)}`);
  });
}, 60_000);
it('role-before-migrate: revoke closes default-grant leak, preserves application grants, and is idempotent', async () => {
  grants();
  await using(url(owner), async c => {
    await c.query('CREATE TABLE public._prisma_migrations (id text); CREATE TABLE public.s2_nodes (id text)');
    expect((await verifyRuntimeRole(c, serve)).map(v => v.rule)).toContain('migrations-table-granted');
    await revokeRuntimeMigrations(c, serve);
    await revokeRuntimeMigrations(c, serve);
    expect(await verifyRuntimeRole(c, serve)).toEqual([]);
  });
  await using(url(serve), async c => {
    await c.query("INSERT INTO public.s2_nodes VALUES ('fixture')");
    await expect(c.query('SELECT * FROM public._prisma_migrations')).rejects.toMatchObject({ code: '42501' });
  });
});
it('migrate-before-role grants and revoke compose; absent role is a no-op', async () => {
  // Reset only this fixture's tables/default ACL, avoiding a second template
  // database clone while other review suites may be creating databases.
  await using(url(owner), async c => {
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${q(serve)}`);
    await c.query('DROP TABLE public._prisma_migrations, public.s2_nodes');
    await c.query('CREATE TABLE public._prisma_migrations (id text); CREATE TABLE public.s2_nodes (id text)');
  });
  grants();
  await using(url(owner), async c => {
    await revokeRuntimeMigrations(c, `absent_${suffix}`);
    await revokeRuntimeMigrations(c, serve);
    expect(await verifyRuntimeRole(c, serve)).toEqual([]);
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
  await using(url(new URL(maintenanceUrl()).username), async c => {
    // Independent control even if an earlier owner-protection assertion failed.
    await c.query(`GRANT ALL ON public._prisma_migrations TO ${q(owner)}`);
    await revokeRuntimeMigrations(c, owner);
  });
  await using(url(owner), c => c.query('SELECT * FROM public._prisma_migrations'));
});
it('a role requiring identifier quoting gets only its migration-table grant revoked', async () => {
  await using(url(owner), async c => {
    await c.query(`GRANT SELECT ON public._prisma_migrations, public.s2_nodes TO ${q(quotedServe)}`);
    await revokeRuntimeMigrations(c, quotedServe);
    expect((await c.query("SELECT has_table_privilege($1, 'public._prisma_migrations', 'SELECT') AS held", [quotedServe])).rows[0].held).toBe(false);
    expect((await c.query("SELECT has_table_privilege($1, 'public.s2_nodes', 'SELECT') AS held", [quotedServe])).rows[0].held).toBe(true);
  });
});
