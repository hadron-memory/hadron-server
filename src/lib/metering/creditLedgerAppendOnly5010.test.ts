/**
 * #5010 (billing A12, cor:dmo:170:08): a credit ledger entry is never edited and never deleted, not even by an operator.
 * The database enforces it: the owner relation is RESTRICT, a trigger refuses every UPDATE except the two the slice names
 * (the owner link to NULL; audit user ids along a recorded account merge) and every DELETE, and a CHECK keeps soft
 * delete retired. Pins 4, 7 and 8 pass on main (guards for the exceptions and the product path); the rest are red there.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { creditBalance, grantCredits } from './index.js';

let pg: Client;
beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
});
afterAll(async () => { await pg.end(); });

let orgId: string;
let entryId: string;
let userS: string;
let userT: string;
let admin: string;

let lastMessage = '';
async function code(sql: string, params: unknown[] = []): Promise<string | null> {
  lastMessage = '';
  try { await pg.query(sql, params); return null; } catch (e) { lastMessage = (e as { message?: string }).message ?? ''; return (e as { code?: string }).code ?? 'unknown'; }
}
async function entryRow() {
  return (await pg.query('SELECT * FROM credit_ledger_entries WHERE id = $1', [entryId])).rows[0];
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ledger-org', urn: `ledger-${generateId()}` } })).id;
  userS = (await db.user.create({ data: { id: generateId(), githubId: 50101, githubUsername: 'ledger-s' } })).id;
  userT = (await db.user.create({ data: { id: generateId(), githubId: 50102, githubUsername: 'ledger-t' } })).id;
  admin = (await db.user.create({ data: { id: generateId(), githubId: 50103, githubUsername: 'ledger-admin', roles: ['ADMIN'] } })).id;
  entryId = generateId();
  await pg.query(
    `INSERT INTO credit_ledger_entries (id, organization_id, kind, amount_micro_cents, note, created_by, updated_by, source_type, source_id)
     VALUES ($1, $2, 'grant', 5000000, 'seed', $3, $3, 'admin', 'seed')`,
    [entryId, orgId, userS],
  );
});

describe('#5010 restrict, not cascade', () => {
  it('pin 1: a hard delete of an organization with entries is refused and the entries remain', async () => {
    await grantCredits(db, { owner: { organizationId: orgId }, amountMicroCents: 1n, sourceType: 'admin', sourceId: 'second' });
    expect(await code('DELETE FROM organizations WHERE id = $1', [orgId])).toBe('23503');
    await expect(db.organization.delete({ where: { id: orgId } })).rejects.toThrow();
    expect((await pg.query('SELECT count(*)::int AS n FROM credit_ledger_entries WHERE organization_id = $1', [orgId])).rows[0].n).toBe(2);
  });

  it('pin 8 (guard): deleteOrganization, the product path, keeps every entry, with the link to the organization removed (#5302)', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    const before = await creditBalance(db, { organizationId: orgId });
    const ids = (await pg.query('SELECT id FROM credit_ledger_entries WHERE organization_id = $1', [orgId])).rows.map((r) => r.id);
    const res = await server.executeOperation(
      { query: 'mutation($ref: ID!) { deleteOrganization(ref: $ref) }', variables: { ref: orgId } },
      { contextValue: { db, userId: admin, roles: ['ADMIN'] } as Context },
    );
    if (res.body.kind !== 'single') throw new Error('unexpected');
    expect(res.body.singleResult.errors).toBeUndefined();
    // The entry is kept (restrict, not cascade) and its amount still sums to the balance it made; #5302 (cor:dmo:170:08 S2): it no
    // longer names the deleted organization, so the organization's own figure is now empty.
    const kept = await pg.query('SELECT organization_id, owner_user_id, amount_micro_cents FROM credit_ledger_entries WHERE id = ANY($1)', [ids]);
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows.map((r) => BigInt(r.amount_micro_cents)).reduce((a, b) => a + b, 0n)).toBe(before);
    expect(kept.rows.every((r) => r.organization_id === null && r.owner_user_id === null)).toBe(true);
    expect((await pg.query('SELECT count(*)::int AS n FROM credit_ledger_entries WHERE organization_id = $1', [orgId])).rows[0].n).toBe(0);
    expect(await creditBalance(db, { organizationId: orgId })).toBe(0n);
  });
});

describe('#5010 the trigger refuses every edit and delete', () => {
  const changes: Array<[string, string, unknown]> = [
    ['amount_micro_cents', 'amount_micro_cents = $2', 9n.toString()],
    ['kind', 'kind = $2', 'debit'],
    ['source_type', 'source_type = $2', 'other'],
    ['source_id', 'source_id = $2', 'other'],
    ['expires_at', 'expires_at = $2', new Date('2030-01-01T00:00:00Z')],
    ['note', 'note = $2', 'changed'],
    ['created_at', 'created_at = $2', new Date('2001-01-01T00:00:00Z')],
    ['updated_at', 'updated_at = $2', new Date('2001-01-01T00:00:00Z')],
    ['deleted_at', 'deleted_at = $2', new Date('2030-01-01T00:00:00Z')],
    ['id', 'id = $2', 'changed-id'],
  ];
  it.each(changes)('pin 2: UPDATE of %s is refused with 23514 and the row is unchanged', async (_c, set, value) => {
    const before = await entryRow();
    expect(await code(`UPDATE credit_ledger_entries SET ${set} WHERE id = $1`, [entryId, value])).toBe('23514');
    expect(lastMessage).toMatch(/append-only/); // the trigger fired, not the CHECK
    expect(await entryRow()).toEqual(before);
  });

  it('pin 3: DELETE is refused and the row remains', async () => {
    expect(await code('DELETE FROM credit_ledger_entries WHERE id = $1', [entryId])).toBe('23514');
    expect(await entryRow()).toBeTruthy();
  });

  it('pin 6: moving an entry to another organization is refused', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'ledger-b', urn: `ledger-b-${generateId()}` } })).id;
    expect(await code('UPDATE credit_ledger_entries SET organization_id = $2 WHERE id = $1', [entryId, other])).toBe('23514');
    expect((await entryRow()).organization_id).toBe(orgId);
  });

  it('pin 7 (guard, flipped by #5014 A6, narrowed by #5238): organization_id to NULL passes only once the organization is deleted', async () => {
    // A12 pinned 23502 here: the column was still NOT NULL, so the trigger's NULL arm was unreachable. A6 (#5014) made the
    // column nullable; #5238 (cor:dmo:170:08) lets the link clear only for a deleted owner, so a live organization's clear is
    // refused and the same clear after the soft delete succeeds. The rest of #5238's pins are in creditLedgerOwnerClear5238.test.ts.
    expect(await code('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [entryId])).toBe('23514');
    await pg.query('UPDATE organizations SET deleted_at = now() WHERE id = $1', [orgId]);
    expect(await code('UPDATE credit_ledger_entries SET organization_id = NULL WHERE id = $1', [entryId])).toBeNull();
  });

  it('pin 13: an entry that arrives soft-deleted is refused', async () => {
    expect(await code(
      `INSERT INTO credit_ledger_entries (id, organization_id, kind, amount_micro_cents, deleted_at) VALUES ($1, $2, 'grant', 1, now())`,
      [generateId(), orgId],
    )).toBe('23514');
    expect(lastMessage).toMatch(/chk_credit_ledger_not_soft_deleted/); // the CHECK fired, not the trigger
  });
});

describe('#5010 audit user ids move only along a recorded merge', () => {
  it('pin 4 (guard): with the merge recorded, created_by and updated_by follow it and nothing else changes', async () => {
    await db.userMerge.create({ data: { sourceUserId: userS, targetUserId: userT, mergedBy: userT } });
    const before = await entryRow();
    expect(await code(
      'UPDATE credit_ledger_entries SET created_by = $2, updated_by = $2 WHERE id = $1', [entryId, userT])).toBeNull();
    const after = await entryRow();
    expect([after.created_by, after.updated_by]).toEqual([userT, userT]);
    expect({ ...after, created_by: null, updated_by: null }).toEqual({ ...before, created_by: null, updated_by: null });
  });

  it('pin 5: with no merge recorded, re-pointing an audit id is refused', async () => {
    expect(await code('UPDATE credit_ledger_entries SET created_by = $2 WHERE id = $1', [entryId, userT])).toBe('23514');
    expect((await entryRow()).created_by).toBe(userS);
  });

  it('pin 5b: a merge recorded the other way round does not authorise it', async () => {
    await db.userMerge.create({ data: { sourceUserId: userT, targetUserId: userS, mergedBy: userS } });
    expect(await code('UPDATE credit_ledger_entries SET created_by = $2 WHERE id = $1', [entryId, userT])).toBe('23514');
  });
});

describe('#5010 the other audit columns, a mixed edit, and the real merge path', () => {
  it('pin 5c: updated_by and deleted_by are refused without a merge', async () => {
    expect(await code('UPDATE credit_ledger_entries SET updated_by = $2 WHERE id = $1', [entryId, userT])).toBe('23514');
    expect(await code('UPDATE credit_ledger_entries SET deleted_by = $2 WHERE id = $1', [entryId, userT])).toBe('23514');
  });

  it('pin 4b: deleted_by may follow a recorded merge too (a row that carries one)', async () => {
    // seeded outside the trigger: deleted_by on a live row is what a hand-cleared mark can leave behind
    await pg.query('ALTER TABLE credit_ledger_entries DISABLE TRIGGER credit_ledger_entries_append_only');
    await pg.query('UPDATE credit_ledger_entries SET deleted_by = $2 WHERE id = $1', [entryId, userS]);
    await pg.query('ALTER TABLE credit_ledger_entries ENABLE TRIGGER credit_ledger_entries_append_only');
    await db.userMerge.create({ data: { sourceUserId: userS, targetUserId: userT, mergedBy: userT } });
    expect(await code('UPDATE credit_ledger_entries SET deleted_by = $2 WHERE id = $1', [entryId, userT])).toBeNull();
  });

  it('pin 5d: an audit id along a recorded merge AND another column in one UPDATE is refused', async () => {
    await db.userMerge.create({ data: { sourceUserId: userS, targetUserId: userT, mergedBy: userT } });
    expect(await code("UPDATE credit_ledger_entries SET created_by = $2, note = 'x' WHERE id = $1", [entryId, userT])).toBe('23514');
    expect((await entryRow()).created_by).toBe(userS);
  });

  it('pin 16: a session temp table named user_merges cannot forge the merge proof', async () => {
    await pg.query('CREATE TEMP TABLE user_merges (LIKE public.user_merges INCLUDING DEFAULTS)');
    try {
      await pg.query('INSERT INTO pg_temp.user_merges (source_user_id, target_user_id, merged_by) VALUES ($1, $2, $2)', [userS, userT]);
      expect(await code('UPDATE credit_ledger_entries SET created_by = $2, updated_by = $2 WHERE id = $1', [entryId, userT])).toBe('23514');
      expect((await entryRow()).created_by).toBe(userS);
    } finally {
      await pg.query('DROP TABLE pg_temp.user_merges');
    }
  });

  it('pin 14: the real mergeUsers path succeeds for an owner of entries, and a chained merge A->B->C follows', async () => {
    const userU = (await db.user.create({ data: { id: generateId(), githubId: 50104, githubUsername: 'ledger-u' } })).id;
    await mergeUsers(db, { sourceUserId: userS, targetUserId: userT, actorUserId: admin });
    let row = await entryRow();
    expect([row.created_by, row.updated_by, row.note, row.amount_micro_cents]).toEqual([userT, userT, 'seed', '5000000']);
    await mergeUsers(db, { sourceUserId: userT, targetUserId: userU, actorUserId: admin });
    row = await entryRow();
    expect([row.created_by, row.updated_by]).toEqual([userU, userU]);
  });

  it('pin 15 (guard): a repeated grantCredits with the same source is one row and no error (webhook replay)', async () => {
    const args = { owner: { organizationId: orgId }, amountMicroCents: 7n, sourceType: 'stripe-checkout', sourceId: 'cs_5010' };
    const first = await grantCredits(db, args);
    const second = await grantCredits(db, args);
    expect(second.id).toBe(first.id);
    expect((await pg.query("SELECT count(*)::int AS n FROM credit_ledger_entries WHERE source_id = 'cs_5010'")).rows[0].n).toBe(1);
  });
});

describe('#5010 test reset', () => {
  it('pin 12: cleanDb empties the ledger though the trigger refuses a DELETE', async () => {
    await cleanDb(db);
    expect((await pg.query('SELECT count(*)::int AS n FROM credit_ledger_entries')).rows[0].n).toBe(0);
  });
});
