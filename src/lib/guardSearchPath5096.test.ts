/**
 * #5096 (same class as #5089): a guard function that reads a table unqualified can have the real table shadowed by a session-local
 * (pg_temp) table of the same name. The fix pins every guard function's search_path (prisma/guard-search-path-invariants.sql).
 * These pins judge the OUTCOME, not the mechanism: no application function may resolve names through pg_temp first, and the
 * premise that makes the pin behaviour-neutral (every guard resolves inside `public`) is checked, not assumed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { inFreshRolledBackSession, shadowTable } from '../test/freshSession5089.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grants/grantFixtures3668.js';

const prisma = (p: string) => readFileSync(new URL(`../../prisma/${p}`, import.meta.url), 'utf8');
const MARKER = '$guard_search_path$';
const EXTENSION_OWNED = `EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`;

describe('the shared source', () => {
  it('is the end of the NEWEST migration that carries the loop, and post-push applies it last', () => {
    const sql = prisma('guard-search-path-invariants.sql');
    const dirs = readdirSync(new URL('../../prisma/migrations/', import.meta.url)).sort().reverse();
    const carriers = dirs.filter((d) => { try { return prisma(`migrations/${d}/migration.sql`).includes(MARKER); } catch { return false; } });
    expect(carriers.length, 'a migration must carry the guard search_path loop').toBeGreaterThan(0);
    // A later migration may re-run the loop for functions a newer migration created; the newest carrier must hold the file verbatim.
    expect(prisma(`migrations/${carriers[0]}/migration.sql`).endsWith(sql), `${carriers[0]} must end with prisma/guard-search-path-invariants.sql`).toBe(true);
    const lines = prisma('post-push.sql').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'));
    expect(lines[lines.length - 1]).toBe('\\ir guard-search-path-invariants.sql');
  });
});

describe('every function pins its search path', () => {
  it('no application function in public lacks search_path = public, pg_temp', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ sig: string }>>(`
      SELECT p.oid::regprocedure::text AS sig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND NOT ${EXTENSION_OWNED}
         AND NOT (p.proconfig IS NOT NULL AND 'search_path=public, pg_temp' = ANY (p.proconfig))
       ORDER BY 1`);
    // A new function must carry `SET search_path = public, pg_temp` in its own CREATE, or a later migration must re-run the loop.
    expect(rows.map((r) => r.sig)).toEqual([]);
  });
  it('covers every function the prisma/*.sql sources create (derived, not listed)', async () => {
    const sources = readdirSync(new URL('../../prisma/', import.meta.url)).filter((f) => f.endsWith('.sql'));
    const names = new Set<string>();
    for (const f of sources) {
      for (const m of prisma(f).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) names.add(m[1].toLowerCase());
    }
    expect(names.size, 'the derivation must see the sources').toBeGreaterThan(80);
    const rows = await db.$queryRaw<Array<{ proname: string; proconfig: string[] | null }>>`
      SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (${[...names]})`;
    expect(rows.length, 'most of the named functions exist in the test database').toBeGreaterThan(80);
    for (const r of rows) expect(r.proconfig, r.proname).toContain('search_path=public, pg_temp');
  });
  it('there are no procedures or aggregates in public to be left out of the loop', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ sig: string }>>(`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind <> 'f' AND NOT ${EXTENSION_OWNED}`);
    expect(rows.map((r) => r.sig)).toEqual([]);
  });
});

describe('the premise that makes the pin behaviour-neutral: every guard resolves inside public', () => {
  it('no application relation lives outside public', async () => {
    const rows = await db.$queryRaw<Array<{ nspname: string; relname: string }>>`
      SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`;
    expect(rows).toEqual([]);
  });
  it('no function body names another non-system schema', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ proname: string; schema: string }>>(`
      SELECT DISTINCT p.proname, s.nspname AS schema
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_namespace s ON s.nspname NOT IN ('public', 'pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg\\_%'
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND NOT ${EXTENSION_OWNED}
         AND p.prosrc ~* ('(^|[^a-z0-9_])' || s.nspname || '\\.[a-z_]')`);
    expect(rows).toEqual([]);
  });
  it('the loop refuses with HDPRF when an application relation lives in another schema (nothing is pinned)', async () => {
    const src = prisma('guard-search-path-invariants.sql');
    await expect(inFreshRolledBackSession(async (c) => {
      await c.query('CREATE SCHEMA other5096');
      await c.query('CREATE TABLE other5096.t (id int)');
      await c.query(src);
    })).rejects.toMatchObject({ code: 'HDPRF' });
  });
  it('a function that already has another SET (work_mem) still gets its search_path, and an IMMUTABLE one is pinned too', async () => {
    const src = prisma('guard-search-path-invariants.sql');
    const config = async (c: import('pg').Client, name: string) =>
      (await c.query<{ proconfig: string[] | null }>('SELECT proconfig FROM pg_proc WHERE proname = $1 AND pronamespace = \'public\'::regnamespace', [name])).rows[0].proconfig;
    await inFreshRolledBackSession(async (c) => {
      await c.query(`CREATE FUNCTION public.zz5096_work_mem() RETURNS int LANGUAGE sql STABLE SET work_mem = '8MB' AS 'SELECT 1'`);
      await c.query(`CREATE FUNCTION public.zz5096_immutable() RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 1'`);
      await c.query(src);
      expect(await config(c, 'zz5096_work_mem')).toEqual(expect.arrayContaining(['work_mem=8MB', 'search_path=public, pg_temp']));
      expect(await config(c, 'zz5096_immutable')).toContain('search_path=public, pg_temp');
    });
  });
  it('re-running the loop on a pinned schema changes nothing', async () => {
    const src = prisma('guard-search-path-invariants.sql');
    const before = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proconfig IS NOT NULL`);
    await inFreshRolledBackSession(async (c) => {
      await c.query(src);
      const after = await c.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proconfig IS NOT NULL`);
      expect(after.rows[0].n).toBe(Number(before[0].n));
    });
  });
});

describe('behaviour: a session temp table cannot stand in for a guarded table', () => {
  let w: World;
  beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
  afterAll(async () => { await cleanDb(db); await dropTestActions(); });

  it('the secret read client guard still finds the real secret when `secrets` is shadowed by an empty temp table', async () => {
    const secretId = `sec_5096_${Math.random().toString(36).slice(2, 10)}`;
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at, protected)
      VALUES (${secretId}, 'app', ${w.appId}, 'tok', 'generic', now(), false)`;
    const grantId = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 minute'`) });
    // Unqualified, the guard would read the empty shadow and refuse a legitimate client; pinned, it reads the real row.
    await inFreshRolledBackSession(async (c) => {
      await shadowTable(c, 'secrets');
      await c.query(`INSERT INTO secret_read_clients (id, grant_id, app_id, secret_id, secret_name, issuer_user_id, self_issued)
        VALUES ($1, $2, $3, $4, 'tok', $5, false)`, ['c_5096', grantId, w.appId, secretId, w.userId]);
    });
  });
  it('and it cannot be forged: a shadow row for a secret another App owns does not admit the client', async () => {
    const secretId = `sec_5096_${Math.random().toString(36).slice(2, 10)}`;
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at, protected)
      VALUES (${secretId}, 'app', ${w.app2Id}, 'tok', 'generic', now(), false)`;
    const grantId = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 minute'`) });
    await expect(inFreshRolledBackSession(async (c) => {
      await shadowTable(c, 'secrets');
      await c.query(`INSERT INTO pg_temp.secrets (id, owner_type, owner_id, name, kind, updated_at, protected) VALUES ($1, 'app', $2, 'tok', 'generic', now(), false)`, [secretId, w.appId]);
      await c.query(`INSERT INTO secret_read_clients (id, grant_id, app_id, secret_id, secret_name, issuer_user_id, self_issued)
        VALUES ($1, $2, $3, $4, 'tok', $5, false)`, ['c_5096b', grantId, w.appId, secretId, w.userId]);
    })).rejects.toThrow(/names an App secret of its own App/);
  });
});
