/**
 * #5096 (same class as #5089): a guard function that reads a table unqualified can have the real table shadowed by a session-local
 * (pg_temp) table of the same name. The fix pins every guard function's search_path (prisma/guard-search-path-invariants.sql).
 * These pins judge the OUTCOME, not the mechanism: no non-immutable application function may resolve names through pg_temp first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { inFreshRolledBackSession, shadowTable } from '../test/freshSession5089.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grants/grantFixtures3668.js';

const file = (p: string) => readFileSync(new URL(`../../prisma/${p}`, import.meta.url), 'utf8');

describe('the shared source', () => {
  it('is the end of the newest migration that carries it, and post-push applies it last', () => {
    const sql = file('guard-search-path-invariants.sql');
    const dirs = readdirSync(new URL('../../prisma/migrations/', import.meta.url)).sort().reverse();
    const dir = dirs.find((d) => { try { return file(`migrations/${d}/migration.sql`).includes('$guard_search_path$'); } catch { return false; } });
    expect(dir).toBe('20261124210000_guard_function_search_path');
    expect(file(`migrations/${dir}/migration.sql`).endsWith(sql)).toBe(true);
    const lines = file('post-push.sql').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'));
    expect(lines[lines.length - 1]).toBe('\\ir guard-search-path-invariants.sql');
  });
});

describe('every guard function pins its search path', () => {
  it('no non-immutable application function in public lacks search_path = public, pg_temp', async () => {
    const rows = await db.$queryRaw<Array<{ sig: string; proconfig: string[] | null }>>`
      SELECT p.oid::regprocedure::text AS sig, p.proconfig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.provolatile <> 'i'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         AND NOT (p.proconfig IS NOT NULL AND 'search_path=public, pg_temp' = ANY (p.proconfig))
       ORDER BY 1`;
    // A new function must carry `SET search_path = public, pg_temp` in its own CREATE, or a later migration must re-run the loop.
    expect(rows.map((r) => r.sig)).toEqual([]);
  });
  it('sees the functions the 31 listed files create (the sweep is not vacuous)', async () => {
    const names = ['hadron_guard_grant', 'hadron_secret_read_client_secret', 'hadron_guard_passkey_credential', 'agent_base_guard', 'hadron_signing_now'];
    const rows = await db.$queryRaw<Array<{ proname: string; proconfig: string[] | null }>>`
      SELECT proname, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND proname = ANY (${names})`;
    expect(rows.map((r) => r.proname).sort()).toEqual([...names].sort());
    for (const r of rows) expect(r.proconfig, r.proname).toContain('search_path=public, pg_temp');
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
    // Unqualified, the guard would read the empty shadow and refuse a legitimate client; qualified, it reads the real row.
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
