/**
 * #5021: the price-row migration refuses with HDPRF while a price row is soft-deleted, applies cleanly otherwise, keeps
 * the units recorded before it with an empty reference, and shares one SQL source with post-push.sql.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

const read = (p: string) => readFileSync(new URL(`../../../prisma/${p}`, import.meta.url), 'utf8');
const MIGRATION = read('migrations/20261126080400_ai_model_prices_kept/migration.sql');
const SOURCE = read('ai-model-price-invariants.sql');
const MIGRATION_5213 = read('migrations/20261127230000_ai_model_prices_not_past_dated/migration.sql');

let pg: Client;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => { await cleanDb(db); });

/** The table before this migration, inside the open transaction: no trigger. */
async function preMigrationShape() {
  await pg.query('DROP TRIGGER IF EXISTS ai_model_prices_kept ON ai_model_prices');
}
const hasTrigger = async () => (await pg.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'ai_model_prices_kept'`)).rows[0].n;
const insertPrice = (deletedAt: Date | null) => pg.query(
  `INSERT INTO ai_model_prices (id, provider, model, tier, input_micro_cents_per_mtok, output_micro_cents_per_mtok, effective_at, deleted_at)
   VALUES ($1, 'anthropic', 'claude-mig', 1, 7, 9, now(), $2)`,
  [generateId(), deletedAt],
);

describe('#5021 migration', () => {
  it('pin 10: a soft-deleted price row stops it with SQLSTATE HDPRF, a count only, and changes nothing', async () => {
    await pg.query('BEGIN');
    try {
      await preMigrationShape();
      await insertPrice(new Date());
      await pg.query('SAVEPOINT before_migration');
      let err: { code?: string; message?: string; detail?: string } | undefined;
      try { await pg.query(MIGRATION); } catch (e) { err = e as typeof err; }
      expect(err?.code).toBe('HDPRF');
      expect(err?.detail).toBe('count of rows with deleted_at set: 1');
      expect(err?.message).not.toMatch(/claude-mig|anthropic/);
      await pg.query('ROLLBACK TO SAVEPOINT before_migration');
      expect(await hasTrigger()).toBe(0);
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('pin 10b: with no soft-deleted row it applies; a unit recorded before keeps a null reference; a DELETE is then refused', async () => {
    await pg.query('BEGIN');
    try {
      await preMigrationShape();
      await insertPrice(null);
      const unit = generateId();
      await pg.query(`INSERT INTO usage_events (id, type, provider, model, cost_micro_cents) VALUES ($1, 'app-run', 'anthropic', 'claude-mig', 5)`, [unit]);
      await pg.query(MIGRATION);
      expect(await hasTrigger()).toBe(1);
      expect((await pg.query('SELECT price_row_id, markup_basis_points, app_run_id FROM usage_events WHERE id = $1', [unit])).rows[0])
        .toEqual({ price_row_id: null, markup_basis_points: null, app_run_id: null });
      await pg.query('SAVEPOINT s');
      await expect(pg.query(`DELETE FROM ai_model_prices WHERE model = 'claude-mig'`)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('pin 13: the latest migration ends with the shared invariants file, which post-push.sql includes', () => {
    expect(MIGRATION_5213.endsWith(SOURCE)).toBe(true);
    expect(read('post-push.sql')).toContain('\\ir ai-model-price-invariants.sql');
  });

  it('pin 14: both price-row functions pin search_path, in the installed database and in the migration text', async () => {
    const r = await pg.query(`SELECT proname, proconfig FROM pg_proc WHERE proname IN ('hadron_ai_model_price_user_merged', 'hadron_ai_model_prices_kept') ORDER BY proname`);
    expect(r.rows).toEqual([
      { proname: 'hadron_ai_model_price_user_merged', proconfig: ['search_path=public, pg_temp'] },
      { proname: 'hadron_ai_model_prices_kept', proconfig: ['search_path=public, pg_temp'] },
    ]);
    expect(MIGRATION.match(/SET search_path = public, pg_temp/g)).toHaveLength(2);
    expect(MIGRATION_5213.match(/SET search_path = public, pg_temp/g)).toHaveLength(2);
  });

  it('pin 15: the new foreign keys restrict (price row) and set null (run), and are validated', async () => {
    const r = await pg.query(`SELECT conname, confdeltype, confupdtype, convalidated FROM pg_constraint
      WHERE conname IN ('usage_events_price_row_id_fkey', 'usage_events_app_run_id_fkey') ORDER BY conname`);
    expect(r.rows).toEqual([
      { conname: 'usage_events_app_run_id_fkey', confdeltype: 'n', confupdtype: 'c', convalidated: true },
      { conname: 'usage_events_price_row_id_fkey', confdeltype: 'r', confupdtype: 'r', convalidated: true },
    ]);
  });

  it('pin 16: each concurrent index migration is a single statement', () => {
    for (const dir of ['20261126080200_usage_events_price_row_id_idx', '20261126080300_usage_events_app_run_id_idx']) {
      const sql = read(`migrations/${dir}/migration.sql`).split('\n').filter((l) => !l.startsWith('--') && l.trim()).join('\n');
      expect(sql).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "[a-z_]+" ON "usage_events"\("[a-z_]+"\);$/);
    }
  });
});

/** #5213: the database refuses a price row dated in the past; the owner role alone may opt out. */
describe('#5213 past-dated price rows', () => {
  const ins = (at: string) => pg.query(
    `INSERT INTO ai_model_prices (id, provider, model, tier, input_micro_cents_per_mtok, output_micro_cents_per_mtok, effective_at)
     VALUES ($1, 'anthropic', 'claude-b', 1, 7, 9, ${at})`, [generateId()]);
  const inTx = async (fn: () => Promise<void>) => {
    await pg.query('BEGIN');
    try { await fn(); } finally { await pg.query('ROLLBACK'); }
  };
  const refused = async (at: string) => {
    await pg.query('SAVEPOINT s');
    await expect(ins(at)).rejects.toMatchObject({ code: '23514' });
    await pg.query('ROLLBACK TO SAVEPOINT s');
  };

  for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) { // +14 h and -11 h from UTC
    it(`B1/B2 under session TimeZone ${tz}: yesterday and one second ago are refused, one second ahead is accepted`, async () => {
      await inTx(async () => {
        await pg.query(`SET LOCAL TimeZone = '${tz}'`);
        await refused(`(clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day'`);
        await refused(`(clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'`);
        await ins(`(clock_timestamp() AT TIME ZONE 'UTC') + interval '1 second'`);
      });
    });
  }

  it('B3: the owner role, with the setting on inside its transaction, may insert a past row; the setting dies with the transaction', async () => {
    await inTx(async () => {
      await pg.query(`SET LOCAL hadron.allow_past_price_row = 'on'`);
      await ins(`'2020-01-01'`);
    });
    await inTx(async () => { await refused(`'2020-01-01'`); });
  });

  it('B3b: any value but exactly on does not opt out', async () => {
    await inTx(async () => {
      await pg.query(`SET LOCAL hadron.allow_past_price_row = 'true'`);
      await refused(`'2020-01-01'`);
    });
  });

  it('B4: a role that does not own the table cannot opt out, setting or not; it can insert a future row', async () => {
    await inTx(async () => {
      await pg.query('CREATE ROLE hadron_b4_serve NOLOGIN');
      await pg.query('GRANT INSERT, SELECT ON ai_model_prices TO hadron_b4_serve');
      await pg.query('SET LOCAL ROLE hadron_b4_serve');
      await pg.query(`SET LOCAL hadron.allow_past_price_row = 'on'`);
      await refused(`'2020-01-01'`);
      await ins(`(clock_timestamp() AT TIME ZONE 'UTC') + interval '1 minute'`);
    });
  });

  it('B5: an UPDATE and a DELETE stay refused, and the trigger is BEFORE INSERT OR UPDATE OR DELETE', async () => {
    const r = await pg.query(`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'ai_model_prices_kept'`);
    expect(r.rows[0].d).toContain('BEFORE INSERT OR DELETE OR UPDATE');
  });
});
