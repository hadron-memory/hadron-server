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
}

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
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('pin 10: with no soft-deleted entry it applies, and the FK then restricts', async () => {
    await pg.query('BEGIN');
    try {
      await preMigrationShape();
      await pg.query(`INSERT INTO credit_ledger_entries (id, organization_id, kind, amount_micro_cents) VALUES ($1, $2, 'grant', 1)`, [generateId(), orgId]);
      await pg.query(MIGRATION);
      const fk = await pg.query(`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = 'credit_ledger_entries_organization_id_fkey'`);
      expect(fk.rows).toEqual([{ confdeltype: 'r', confupdtype: 'r' }]);
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
