/**
 * hadron-server#5014 (Billing A6), database and library level: an entry names exactly one owner; the append-only trigger
 * lets `owner_user_id` move only along a recorded merge; a person's entries outlive the person
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:01, :03, :08).
 *
 * A raw `pg` client reads process.env.DATABASE_URL (the per-worker database), as the #5010 pins do.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import type { OwnerRef } from '../owner.js';
import { adjustCredits, creditBalance, debitCredits, grantCredits } from './index.js';

let pg: Client;
let orgId: string, a: string, b: string;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'pl-lib-org', urn: 'pl-lib-org' } })).id;
  a = (await db.user.create({ data: { id: generateId(), handle: 'pl-lib-a' } })).id;
  b = (await db.user.create({ data: { id: generateId(), handle: 'pl-lib-b' } })).id;
});

const insert = (cols: { org?: string | null; user?: string | null }) =>
  pg.query(
    `INSERT INTO credit_ledger_entries (id, organization_id, owner_user_id, kind, amount_micro_cents) VALUES ($1, $2, $3, 'grant', 10) RETURNING id`,
    [generateId(), cols.org ?? null, cols.user ?? null],
  );
const rejected = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { code?: string; message?: string; constraint?: string }; } };

describe('pin 3: the database refuses an entry with two owners', () => {
  it('both columns set: 23514 naming chk_credit_ledger_one_owner; one column set: fine', async () => {
    const err = await rejected(insert({ org: orgId, user: a }));
    expect(err?.code).toBe('23514');
    expect(err?.constraint).toBe('chk_credit_ledger_one_owner');
    await insert({ org: orgId });
    await insert({ user: a });
    expect((await pg.query('SELECT count(*)::int AS n FROM credit_ledger_entries')).rows[0].n).toBe(2);
  });
});

describe('pin 4: the library refuses an owner that names neither, before any insert', () => {
  it('grantCredits, adjustCredits and debitCredits throw and write nothing', async () => {
    // built INSIDE the test: orgId and a are assigned in beforeEach, so a value built in the describe body holds undefined
    // ids and would test "neither" twice (blind review F2 at 601ab494).
    const neither = {} as unknown as OwnerRef;
    const both = { organizationId: orgId, userId: a } as unknown as OwnerRef;
    expect(orgId).toBeTruthy();
    expect(a).toBeTruthy();
    for (const owner of [neither, both]) {
      await expect(grantCredits(db, { owner, amountMicroCents: 5n, sourceType: 't', sourceId: 'x' })).rejects.toThrow(/owner/i);
      await expect(adjustCredits(db, { owner, amountMicroCents: 5n, sourceType: 't', sourceId: 'x', note: 'n' })).rejects.toThrow(/owner/i);
      await expect(debitCredits(db, { owner, amountMicroCents: 5n })).rejects.toThrow(/owner/i);
      await expect(creditBalance(db, owner)).rejects.toThrow(/owner/i);
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('a person owner writes with the person column and an organization owner with the organization column', async () => {
    const g = await grantCredits(db, { owner: { userId: a }, amountMicroCents: 7n, sourceType: 't', sourceId: 'p' });
    expect(g).toMatchObject({ organizationId: null, ownerUserId: a });
    const d = await debitCredits(db, { owner: { userId: a }, amountMicroCents: 2n });
    expect(d).toMatchObject({ organizationId: null, ownerUserId: a, amountMicroCents: -2n });
    const o = await grantCredits(db, { owner: { organizationId: orgId }, amountMicroCents: 9n, sourceType: 't', sourceId: 'o' });
    expect(o).toMatchObject({ organizationId: orgId, ownerUserId: null });
    expect(await creditBalance(db, { userId: a })).toBe(5n);
    expect(await creditBalance(db, { organizationId: orgId })).toBe(9n);
  });
});

describe('pin 11: owner_user_id moves only along a merge recorded in user_merges', () => {
  it('moving to another person with no user_merges row: 23514', async () => {
    const id = (await insert({ user: a })).rows[0].id;
    const err = await rejected(pg.query('UPDATE credit_ledger_entries SET owner_user_id = $1 WHERE id = $2', [b, id]));
    expect(err?.code).toBe('23514');
    expect((await pg.query('SELECT owner_user_id FROM credit_ledger_entries WHERE id = $1', [id])).rows[0].owner_user_id).toBe(a);
  });

  it('a person entry cannot become an organization entry, and an organization entry cannot become a person entry', async () => {
    const pid = (await insert({ user: a })).rows[0].id;
    const oid = (await insert({ org: orgId })).rows[0].id;
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET organization_id = $1, owner_user_id = NULL WHERE id = $2', [orgId, pid])))?.code).toBe('23514');
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET owner_user_id = $1, organization_id = NULL WHERE id = $2', [a, oid])))?.code).toBe('23514');
  });

  it('the move is allowed once the merge is recorded, in the direction recorded only', async () => {
    const id = (await insert({ user: a })).rows[0].id;
    await pg.query('INSERT INTO user_merges (source_user_id, target_user_id, merged_by) VALUES ($1, $2, $2)', [a, b]);
    await pg.query('UPDATE credit_ledger_entries SET owner_user_id = $1 WHERE id = $2', [b, id]);
    // the reverse direction (b back to a) is not recorded
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET owner_user_id = $1 WHERE id = $2', [a, id])))?.code).toBe('23514');
  });
});

describe('pin 12: the link may be cleared (plan section 13 item 18 is not built, the trigger allows it)', () => {
  it('SET owner_user_id = NULL on a person row and SET organization_id = NULL on an organization row are allowed', async () => {
    const pid = (await insert({ user: a })).rows[0].id;
    const oid = (await insert({ org: orgId })).rows[0].id;
    await pg.query('UPDATE credit_ledger_entries SET owner_user_id = NULL WHERE id = $1', [pid]);
    await pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [oid]);
    // and the cleared link is what it says: no owner at all, which the CHECK ("at most one") admits (blind review F10)
    const rows = (await pg.query('SELECT id, organization_id, owner_user_id FROM credit_ledger_entries WHERE id = ANY($1)', [[pid, oid]])).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.organization_id, r.owner_user_id]).toEqual([null, null]);
  });
});

describe('pin 13: a person\'s entries outlive the person', () => {
  it('a hard delete of a user who has entries is refused by the database (FK restrict) and the entries stay', async () => {
    await grantCredits(db, { owner: { userId: a }, amountMicroCents: 7n, sourceType: 't', sourceId: 'p' });
    const err = await rejected(pg.query('DELETE FROM users WHERE id = $1', [a]));
    expect(err?.code).toBe('23503');
    expect(await db.creditLedgerEntry.count({ where: { ownerUserId: a } })).toBe(1);
  });
});
