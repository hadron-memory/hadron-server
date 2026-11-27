/**
 * hadron-server#5352 (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, Edge case "An entry is never written for a deleted owner",
 * Decided, Holger 2026-11-27): an append (a debit, a grant, an adjustment, a period grant, an expiry settlement) that finds
 * its owner deleted when it commits is refused and writes nothing, and the usage behind a debit stays recorded. The owner is
 * judged under a lock the deletion also takes, so an append that waited for a deletion sees it. In the other order, an append
 * that committed while a deletion waited for it is cleared by that deletion.
 *
 * Red on main:
 *  - A1-A4: no append path re-checks the owner, so each writes an entry naming the deleted owner.
 *  - B1: the organization delete takes no lock that FOR KEY SHARE (or the FK check) waits for, so an append during an open
 *    delete commits naming the organization after the delete has run its clear.
 *  - B2: the append waits for the person delete's FOR UPDATE (the FK check), then writes an entry naming the deleted person.
 *  - B3: the grantCredits mutation resolves the organization while the delete is open, then writes naming it.
 *  - C1-C3: an append holding the owner row commits while the delete waits; the delete's clear runs (SERIALIZABLE: on a
 *    snapshot from before the append's commit; the organization delete: before the append commits at all) and misses it.
 *
 * A raw `pg` client reads process.env.DATABASE_URL (the per-worker database), as the #5014 pins do.
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersBlockedBy } from '../../test/lockWait.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { deleteUserAccount } from '../../controller/operations/deleteUser.js';
import { softDeleteOrganizationCore } from '../../controller/operations/softDeleteOrganization.js';
import { adjustCredits, clearPriceCache, debitCredits, grantCredits, recordLlmUsage } from './index.js';
import { writeSettlements } from './settleExpiredGrants.js';
import { repointMergedLedgerOwners } from './repointMergedOwners.js';

vi.mock('../slackClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slackClient.js')>()),
  deleteSlackToolConnection: vi.fn().mockResolvedValue(true),
}));
vi.mock('../telegramClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telegramClient.js')>()),
  deleteTelegramToolConnection: vi.fn().mockResolvedValue(true),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = resolvers.Mutation as any;
const ctx = (userId: string, roles: string[]): Context => ({ db, roles, userId }) as unknown as Context;

let pg: Client;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });

let org: string, p: string, q: string, admin: string;
const mkUser = (handle: string, roles: ('ADMIN' | 'READER')[] = ['READER']) =>
  db.user.create({ data: { id: generateId(), handle, roles } }).then((u) => u.id);

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  org = (await db.organization.create({ data: { id: generateId(), name: 'l5352-org', urn: 'l5352-org' } })).id;
  p = await mkUser('l5352-p');
  q = await mkUser('l5352-q');
  admin = await mkUser('l5352-admin', ['ADMIN']);
});
afterEach(() => { vi.unstubAllEnvs(); });

const softDeleteOrg = (id: string) => db.organization.update({ where: { id }, data: { deletedAt: new Date() } });
const softDeleteUser = (id: string) => db.user.update({ where: { id }, data: { deletedAt: new Date() } });
const naming = (owner: { organizationId: string } | { ownerUserId: string }) => db.creditLedgerEntry.count({ where: owner });
const grant = (owner: { organizationId: string } | { userId: string }) =>
  grantCredits(db, { owner, amountMicroCents: 1_000n, sourceType: 't5352', sourceId: generateId() });
/** Settle a promise into a value, so a pin can read a refusal after releasing the lock it waited on. */
const settled = <T>(pr: Promise<T>) => pr.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

describe('A: an append for an owner already deleted is refused and writes nothing', () => {
  it('A1 grantCredits for a deleted organization', async () => {
    await softDeleteOrg(org);
    await expect(grant({ organizationId: org })).rejects.toMatchObject({ name: 'LedgerOwnerDeletedError' });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('A2 adjustCredits for a deleted person', async () => {
    await softDeleteUser(p);
    await expect(
      adjustCredits(db, { owner: { userId: p }, amountMicroCents: -5n, sourceType: 't5352', sourceId: generateId(), note: 'refund' }),
    ).rejects.toMatchObject({ name: 'LedgerOwnerDeletedError' });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('A3 a debit for a deleted person: the usage event is recorded and returned, no ledger entry', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await db.aiModelPrice.create({
      data: { id: generateId(), provider: 'anthropic', model: 'claude-l5352', tier: 1, inputMicroCentsPerMTok: 30_000_000n, outputMicroCentsPerMTok: 150_000_000n, effectiveAt: new Date('2026-01-01') },
    });
    await softDeleteUser(p);
    const event = await recordLlmUsage(db, {
      type: 'app-run', provider: 'anthropic', model: 'claude-l5352', tokensIn: 1000, tokensOut: 500, keyOwnerType: 'HADRON_SERVER',
      billableAccount: { userId: p },
    });
    expect(event).not.toBeNull();
    expect(await db.usageEvent.count({ where: { id: event!.id, billableUserId: p } })).toBe(1);
    expect(await db.creditLedgerEntry.count()).toBe(0);
    // debitCredits itself refuses
    await expect(debitCredits(db, { owner: { userId: p }, amountMicroCents: 7n, sourceType: 'usage-event', sourceId: generateId() }))
      .rejects.toMatchObject({ name: 'LedgerOwnerDeletedError' });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('A4 an expiry settlement for a deleted organization', async () => {
    await softDeleteOrg(org);
    await expect(writeSettlements(db, { organizationId: org }, [{ grantId: generateId(), amountMicroCents: -3n }], new Date()))
      .rejects.toMatchObject({ name: 'LedgerOwnerDeletedError' });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('A6 a merged-away person is not "deleted": the append is written and the repoint carries it to the survivor (#5014)', async () => {
    await mergeUsers(db, { sourceUserId: p, targetUserId: q, actorUserId: admin });
    expect((await db.user.findUniqueOrThrow({ where: { id: p } })).deletedAt).not.toBeNull();
    const written = await grant({ userId: p });
    expect(written).toMatchObject({ ownerUserId: p });
    // ...and the repoint carries it to the survivor (Xenophon, team chat #154422: pin it moving).
    expect(await repointMergedLedgerOwners(db, { survivor: q })).toBe(1);
    expect((await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: written.id } })).ownerUserId).toBe(q);
    expect(await naming({ ownerUserId: p })).toBe(0);
  });

  it('A7 a live owner is unaffected', async () => {
    await expect(grant({ organizationId: org })).resolves.toMatchObject({ organizationId: org });
    await expect(grant({ userId: p })).resolves.toMatchObject({ ownerUserId: p });
  });
});

/** Run `body` in a transaction held open until the returned `release` is called; resolves `pid` once `body` has run. */
function holdOpen(body: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: (pid: number) => void;
  const pid = new Promise<number>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => {
    const [{ pid: me }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await body(tx);
    ready(me);
    await gate;
  }, { timeout: 30_000 });
  return { pid, release, done };
}

describe('B: an append that waits for an open deletion sees it and is refused', () => {
  it('B1 the organization delete (softDeleteOrganizationCore) is open: the append waits for it, then writes nothing', async () => {
    const del = holdOpen(async (tx) => { await softDeleteOrganizationCore(tx, org, null); });
    const pid = await del.pid;
    const append = settled(grant({ organizationId: org }));
    // On main nothing makes the append wait; the barrier then times out and the pin reads what the append wrote.
    await waitForLockWaitersBlockedBy(db, pid, 1, 3_000).catch(() => undefined);
    del.release();
    await del.done;
    const r = await append;
    expect(await naming({ organizationId: org })).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : (r.error as Error).name).toBe('LedgerOwnerDeletedError');
  });

  it('B2 the person delete is open (owner row FOR UPDATE, soft delete, clear): the debit waits, then writes nothing', async () => {
    const del = holdOpen(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${p} AND deleted_at IS NULL FOR UPDATE`;
      await tx.user.update({ where: { id: p }, data: { deletedAt: new Date() } });
      await tx.$executeRaw`UPDATE credit_ledger_entries SET owner_user_id = NULL WHERE owner_user_id = ${p}`;
    });
    const pid = await del.pid;
    const append = settled(debitCredits(db, { owner: { userId: p }, amountMicroCents: 7n, sourceType: 'usage-event', sourceId: generateId() }));
    await waitForLockWaitersBlockedBy(db, pid, 1, 3_000);
    del.release();
    await del.done;
    const r = await append;
    expect(await naming({ ownerUserId: p })).toBe(0);
    expect(r.ok ? null : (r.error as Error).name).toBe('LedgerOwnerDeletedError');
  });

  it('B3 the grantCredits mutation in the race answers what it answers for an organization already deleted (not found)', async () => {
    const other = (await db.organization.create({ data: { id: generateId(), name: 'l5352-other', urn: 'l5352-other' } })).id;
    await softDeleteOrg(other);
    const mutate = (ref: string) =>
      settled(M.grantCredits({}, { input: { orgRef: ref, amountMicroCents: '10', sourceType: 't5352', sourceId: generateId() } }, ctx(admin, ['ADMIN'])));
    const sequential = await mutate(other);
    expect(sequential.ok).toBe(false);
    const del = holdOpen(async (tx) => { await softDeleteOrganizationCore(tx, org, null); });
    const pid = await del.pid;
    const raced = mutate(org); // resolution reads the organization live: the delete has not committed
    await waitForLockWaitersBlockedBy(db, pid, 1, 3_000).catch(() => undefined);
    del.release();
    await del.done;
    const r = await raced;
    expect(await db.creditLedgerEntry.count()).toBe(0);
    expect(r.ok).toBe(false);
    const shape = (e: unknown) => ({ name: (e as Error).name, message: (e as Error).message.replace(org, 'REF').replace(other, 'REF') });
    expect(r.ok ? null : shape(r.error)).toEqual(sequential.ok ? null : shape(sequential.error));
  });
});

/**
 * The append's protocol on its own connection (the owner row FOR KEY SHARE, then the insert), held open so the deletion
 * starts while it holds the row. Returns the backend pid and a commit.
 */
async function appendHeldOpen(owner: { organizationId: string } | { userId: string }) {
  await pg.query('BEGIN');
  const { rows: [{ pid }] } = await pg.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  if ('organizationId' in owner) {
    await pg.query('SELECT id FROM organizations WHERE id = $1 FOR KEY SHARE', [owner.organizationId]);
  } else {
    await pg.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [owner.userId]);
  }
  await pg.query(
    `INSERT INTO credit_ledger_entries (id, organization_id, owner_user_id, kind, amount_micro_cents, source_type, source_id)
     VALUES ($1, $2, $3, 'debit', -5, 't5352', $4)`,
    [generateId(), 'organizationId' in owner ? owner.organizationId : null, 'userId' in owner ? owner.userId : null, generateId()],
  );
  return { pid, commit: () => pg.query('COMMIT') };
}

describe('C: an append that commits while the deletion waits for it is cleared by that deletion', () => {
  it('C1 the person delete (SERIALIZABLE) waits for the append, then clears its entry', async () => {
    const a = await appendHeldOpen({ userId: p });
    const del = deleteUserAccount(db, { targetUserId: p, actorUserId: p });
    await waitForLockWaitersBlockedBy(db, a.pid, 1, 5_000);
    await a.commit();
    await del;
    expect(await db.creditLedgerEntry.count()).toBe(1);
    expect(await naming({ ownerUserId: p })).toBe(0);
  });

  it('C2 the organization delete waits for the append, then clears its entry', async () => {
    const a = await appendHeldOpen({ organizationId: org });
    const del = settled(M.deleteOrganization({}, { ref: org }, ctx(admin, ['ADMIN'])));
    // On main the delete does not wait; it commits before the append does.
    await waitForLockWaitersBlockedBy(db, a.pid, 1, 3_000).catch(() => undefined);
    await a.commit();
    expect(await del).toMatchObject({ ok: true });
    expect(await db.creditLedgerEntry.count()).toBe(1);
    expect(await naming({ organizationId: org })).toBe(0);
  });

  it('C3 the sole-member organization of a person delete (SERIALIZABLE) waits for the append, then clears its entry', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org, userId: p, role: 'OWNER' } });
    const a = await appendHeldOpen({ organizationId: org });
    const del = settled(deleteUserAccount(db, { targetUserId: p, actorUserId: p }));
    await waitForLockWaitersBlockedBy(db, a.pid, 1, 3_000).catch(() => undefined);
    await a.commit();
    expect(await del).toMatchObject({ ok: true });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org } })).deletedAt).not.toBeNull();
    expect(await db.creditLedgerEntry.count()).toBe(1);
    expect(await naming({ organizationId: org })).toBe(0);
  });
});
