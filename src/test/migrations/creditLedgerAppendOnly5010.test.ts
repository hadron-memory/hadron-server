/** #5010: the migration refuses with HDPRF on a soft-deleted entry, applies cleanly otherwise, and shares one SQL source. */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

const read = (p: string) => readFileSync(new URL(`../../../prisma/${p}`, import.meta.url), 'utf8');
const MIGRATION = read('migrations/20261124170000_credit_ledger_append_only/migration.sql');
const SOURCE = read('credit-ledger-invariants.sql');

let pg: Client;
let orgId: string;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'mig-org', urn: `mig-${generateId()}` } })).id;
});

/** Put the table in its pre-migration shape inside the open transaction (no trigger, no CHECK, cascade FK). */
async function preMigrationShape() {
  await pg.query('DROP TRIGGER IF EXISTS credit_ledger_entries_append_only ON credit_ledger_entries');
  await pg.query('ALTER TABLE credit_ledger_entries DROP CONSTRAINT IF EXISTS chk_credit_ledger_not_soft_deleted');
  await pg.query('ALTER TABLE credit_ledger_entries DROP CONSTRAINT credit_ledger_entries_organization_id_fkey');
  await pg.query(`ALTER TABLE credit_ledger_entries ADD CONSTRAINT credit_ledger_entries_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE`);
}
const fkAction = async () => (await pg.query(`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = 'credit_ledger_entries_organization_id_fkey'`)).rows;
const hasTrigger = async () => (await pg.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'credit_ledger_entries_append_only'`)).rows[0].n;
const hasCheck = async () => (await pg.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'chk_credit_ledger_not_soft_deleted'`)).rows[0].n;

describe('#5010 migration', () => {
  it('pin 9: a soft-deleted entry stops it with SQLSTATE HDPRF and changes nothing', async () => {
    await pg.query('BEGIN');
    try {
      await preMigrationShape();
      await pg.query(`INSERT INTO credit_ledger_entries (id, organization_id, kind, amount_micro_cents, deleted_at) VALUES ($1, $2, 'grant', 1, now())`, [generateId(), orgId]);
      await pg.query('SAVEPOINT before_migration');
      let err: { code?: string; message?: string; detail?: string } | undefined;
      try { await pg.query(MIGRATION); } catch (e) { err = e as { code?: string; message?: string; detail?: string }; }
      expect(err?.code).toBe('HDPRF');
      expect(err?.detail).toBe('count of rows with deleted_at set: 1');
      expect(err?.message).not.toContain(orgId);
      await pg.query('ROLLBACK TO SAVEPOINT before_migration');
      // changes nothing: still the pre-migration shape (cascade FK, no trigger, no CHECK)
      expect(await fkAction()).toEqual([{ confdeltype: 'c', confupdtype: 'c' }]);
      expect([await hasTrigger(), await hasCheck()]).toEqual([0, 0]);
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('pin 10: with no soft-deleted entry it applies, and the FK then restricts', async () => {
    await pg.query('BEGIN');
    try {
      await preMigrationShape();
      await pg.query(`INSERT INTO credit_ledger_entries (id, organization_id, kind, amount_micro_cents) VALUES ($1, $2, 'grant', 1)`, [generateId(), orgId]);
      expect(await fkAction()).toEqual([{ confdeltype: 'c', confupdtype: 'c' }]);
      await pg.query(MIGRATION);
      expect(await fkAction()).toEqual([{ confdeltype: 'r', confupdtype: 'r' }]);
      expect([await hasTrigger(), await hasCheck()]).toEqual([1, 1]);
      await pg.query('SAVEPOINT s');
      await expect(pg.query('DELETE FROM organizations WHERE id = $1', [orgId])).rejects.toMatchObject({ code: '23503' });
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('pin 11: the migration ends with the shared invariants file, which post-push.sql includes', () => {
    expect(MIGRATION.endsWith(SOURCE)).toBe(true);
    expect(read('post-push.sql')).toContain('\\ir credit-ledger-invariants.sql');
  });
});
