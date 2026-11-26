/**
 * hadron-server#5238 (follow-up of #5014): a credit ledger entry's owner link may be cleared only because its owner is gone
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:08: "When the billable account is deleted, its entries are kept, with the link
 * to the deleted owner removed"; Edge Cases: an erased person's entries are "kept without the person"). Clearing a LIVE owner's
 * link edits the entry and silently drops it from every balance, so the append-only trigger refuses it with its one error.
 * Re-pointing along a recorded merge is unchanged (pinned in personLedger5014.test.ts pin 11).
 *
 * "Gone" is judged on the owner's row at the moment of the UPDATE: no row with deleted_at IS NULL. Both organizations and
 * persons are deleted by soft delete (softDeleteOrganization, deleteUser); a hard delete is refused by the RESTRICT FK while
 * entries exist, so the row-missing arm is only what a later SET NULL action would meet.
 *
 * A raw `pg` client reads process.env.DATABASE_URL (the per-worker database), as the #5010 and #5014 pins do.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

let pg: Client;
let orgId: string, person: string;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'clr-org', urn: `clr-${generateId()}` } })).id;
  person = (await db.user.create({ data: { id: generateId(), handle: 'clr-p' } })).id;
});

const insert = async (cols: { org?: string; user?: string }) =>
  (await pg.query(
    `INSERT INTO credit_ledger_entries (id, organization_id, owner_user_id, kind, amount_micro_cents) VALUES ($1, $2, $3, 'grant', 10) RETURNING id`,
    [generateId(), cols.org ?? null, cols.user ?? null],
  )).rows[0].id as string;
const rejected = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { code?: string; message?: string }; } };
const owners = async (id: string) =>
  (await pg.query('SELECT organization_id, owner_user_id FROM credit_ledger_entries WHERE id = $1', [id])).rows[0];

describe('#5238: a live owner\'s link is never cleared', () => {
  it('pin 1: clearing a live organization\'s link is refused with the append-only error, and the entry keeps it', async () => {
    const id = await insert({ org: orgId });
    const err = await rejected(pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [id]));
    expect(err?.code).toBe('23514');
    expect(err?.message).toBe('Credit ledger entries are append-only');
    expect(await owners(id)).toEqual({ organization_id: orgId, owner_user_id: null });
  });

  it('pin 2: clearing a live person\'s link is refused with the append-only error, and the entry keeps it', async () => {
    const id = await insert({ user: person });
    const err = await rejected(pg.query('UPDATE credit_ledger_entries SET owner_user_id = NULL WHERE id = $1', [id]));
    expect(err?.code).toBe('23514');
    expect(err?.message).toBe('Credit ledger entries are append-only');
    expect(await owners(id)).toEqual({ organization_id: null, owner_user_id: person });
  });
});

describe('#5238: a deleted owner\'s link may be cleared', () => {
  it('pin 3: once the organization is soft-deleted, its entries\' link may be cleared', async () => {
    const id = await insert({ org: orgId });
    await pg.query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [orgId]);
    await pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [id]);
    expect(await owners(id)).toEqual({ organization_id: null, owner_user_id: null });
  });

  it('pin 4: once the person is deleted or erased, their entries\' link may be cleared', async () => {
    const id = await insert({ user: person });
    await pg.query('UPDATE users SET deleted_at = now() WHERE id = $1', [person]);
    await pg.query('UPDATE credit_ledger_entries SET owner_user_id = NULL WHERE id = $1', [id]);
    expect(await owners(id)).toEqual({ organization_id: null, owner_user_id: null });
  });

  it('pin 5: the deletion and the clear in one transaction work; the clear before the deletion does not', async () => {
    const id = await insert({ org: orgId });
    await pg.query('BEGIN');
    try {
      expect((await rejected(pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [id])))?.code).toBe('23514');
    } finally { await pg.query('ROLLBACK'); }
    await pg.query('BEGIN');
    try {
      await pg.query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [orgId]);
      await pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [id]);
      await pg.query('COMMIT');
    } catch (e) { await pg.query('ROLLBACK'); throw e; }
    expect(await owners(id)).toEqual({ organization_id: null, owner_user_id: null });
  });

  it('pin 6: one deleted owner does not open another owner\'s entries', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'clr-live', urn: `clr-live-${generateId()}` } })).id;
    const otherPerson = (await db.user.create({ data: { id: generateId(), handle: 'clr-q' } })).id;
    const liveOrgEntry = await insert({ org: other });
    const livePersonEntry = await insert({ user: otherPerson });
    await pg.query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [orgId]);
    await pg.query('UPDATE users SET deleted_at = now() WHERE id = $1', [person]);
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [liveOrgEntry])))?.code).toBe('23514');
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET owner_user_id = NULL WHERE id = $1', [livePersonEntry])))?.code).toBe('23514');
  });

  it('pin 7: a deleted owner\'s link is cleared, never moved: re-pointing to another organization stays refused', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'clr-b', urn: `clr-b-${generateId()}` } })).id;
    const id = await insert({ org: orgId });
    await pg.query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [orgId]);
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET organization_id = $2 WHERE id = $1', [id, other])))?.code).toBe('23514');
    expect(await owners(id)).toEqual({ organization_id: orgId, owner_user_id: null });
  });

  it('pin 8: a deleted person\'s link is cleared, never moved: re-pointing to a person they were not merged into stays refused', async () => {
    const other = (await db.user.create({ data: { id: generateId(), handle: 'clr-r' } })).id;
    const id = await insert({ user: person });
    await pg.query('UPDATE users SET deleted_at = now() WHERE id = $1', [person]);
    expect((await rejected(pg.query('UPDATE credit_ledger_entries SET owner_user_id = $2 WHERE id = $1', [id, other])))?.code).toBe('23514');
    expect(await owners(id)).toEqual({ organization_id: null, owner_user_id: person });
  });

  it('pin 9: a cleared link never comes back, to the old owner or anyone else', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'clr-c', urn: `clr-c-${generateId()}` } })).id;
    const orgEntry = await insert({ org: orgId });
    const personEntry = await insert({ user: person });
    await pg.query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [orgId]);
    await pg.query('UPDATE users SET deleted_at = now() WHERE id = $1', [person]);
    await pg.query('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [orgEntry]);
    await pg.query('UPDATE credit_ledger_entries SET owner_user_id = NULL WHERE id = $1', [personEntry]);
    for (const [col, val] of [['organization_id', orgId], ['organization_id', other], ['owner_user_id', person]] as const) {
      for (const id of [orgEntry, personEntry]) {
        expect((await rejected(pg.query(`UPDATE credit_ledger_entries SET ${col} = $2 WHERE id = $1`, [id, val])))?.code).toBe('23514');
      }
    }
    expect(await owners(orgEntry)).toEqual({ organization_id: null, owner_user_id: null });
    expect(await owners(personEntry)).toEqual({ organization_id: null, owner_user_id: null });
  });
});
