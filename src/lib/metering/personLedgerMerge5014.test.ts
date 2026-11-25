/**
 * hadron-server#5014 (Billing A6), local review P2 at 601ab494: an entry written for a person after an account merge committed
 * (or a settlement computed for the merged-away person that inserts after it) is stranded on the merged-away account. The
 * survivor's read and the hourly job re-point it along the merge the append-only trigger already allows
 * (src/lib/metering/repointMergedOwners.ts). The interleavings are built by writing the stranded row directly AFTER a real merge,
 * which is the state either race leaves behind.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../id.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { expireCreditGrants } from '../../jobs/expireCreditGrants.js';
import { repointMergedLedgerOwners } from './repointMergedOwners.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function balanceOf(userId: string, asUser: string) {
  const res = await server.executeOperation(
    { query: `query($u: ID) { creditBalance(userRef: $u) { balanceMicroCents expiring { amountMicroCents } } }`, variables: { u: userId } },
    { contextValue: { db, userId: asUser, roles: ['READER'] } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  expect(res.body.singleResult.errors).toBeUndefined();
  return (res.body.singleResult.data as { creditBalance: { balanceMicroCents: string; expiring: unknown[] } }).creditBalance;
}

const DAY = 86_400_000;
let admin: string, s: string, t: string, u: string;
const mk = (handle: string) => db.user.create({ data: { id: generateId(), handle } }).then((x) => x.id);
const entry = (owner: string, over: Record<string, unknown> = {}) =>
  db.creditLedgerEntry.create({
    data: { id: generateId(), ownerUserId: owner, kind: 'grant', amountMicroCents: 100n, sourceType: 't', sourceId: generateId(), ...over },
  });

beforeEach(async () => {
  await cleanDb(db);
  admin = (await db.user.create({ data: { id: generateId(), handle: 'mg-admin', roles: ['ADMIN'] } })).id;
  s = await mk('mg-s');
  t = await mk('mg-t');
  u = await mk('mg-u');
});

describe('probe 2: a write that commits after the merge is stranded on the merged-away person', () => {
  it('the survivor\'s balance read brings it in, and the entry now names the survivor', async () => {
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    const stranded = await entry(s, { amountMicroCents: 500n });
    expect((await balanceOf(t, t)).balanceMicroCents).toBe('500');
    expect((await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: stranded.id } })).ownerUserId).toBe(t);
  });

  it('a retry of the same source pair naming the survivor is then a true replay, not a conflict', async () => {
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    const stranded = await entry(s, { sourceType: 'stripe-checkout', sourceId: 'cs_late', amountMicroCents: 500n });
    await balanceOf(t, t);
    const { grantCredits } = await import('./index.js');
    const again = await grantCredits(db, { owner: { userId: t }, amountMicroCents: 500n, sourceType: 'stripe-checkout', sourceId: 'cs_late' });
    expect(again.id).toBe(stranded.id);
  });
});

describe('probe 1: a settlement that inserts after the merge must not leave the survivor holding expired credit', () => {
  it('the settlement entry lands on the survivor, the balance is 0 and the grant is never settled twice', async () => {
    const grant = await entry(s, { amountMicroCents: 100n, createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) });
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    // the in-flight settlement of the merged-away person inserts after the merge committed
    await entry(s, { kind: 'adjustment', amountMicroCents: -100n, sourceType: 'grant-expiry', sourceId: grant.id, createdBy: 'system:credit-expiry' });
    const bal = await balanceOf(t, t);
    expect(bal.balanceMicroCents).toBe('0');
    expect(bal.expiring).toEqual([]);
    expect(await db.creditLedgerEntry.count({ where: { sourceType: 'grant-expiry' } })).toBe(1);
    expect(await db.creditLedgerEntry.count({ where: { ownerUserId: s } })).toBe(0);
  });
});

describe('the global re-point (the hourly job)', () => {
  it('follows a chain of merges hop by hop', async () => {
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    await mergeUsers(db, { sourceUserId: t, targetUserId: u, actorUserId: admin });
    const stranded = await entry(s, { amountMicroCents: 40n });
    expect(await repointMergedLedgerOwners(db)).toBe(2); // S to T, then T to U
    expect((await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: stranded.id } })).ownerUserId).toBe(u);
  });

  it('writes owner_user_id and nothing else, and changes nothing when nothing is stranded', async () => {
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    const stranded = await entry(s, { amountMicroCents: 7n });
    const kept = await entry(u, { amountMicroCents: 9n });
    expect(await repointMergedLedgerOwners(db)).toBe(1);
    const after = await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: stranded.id } });
    expect({ ...after, ownerUserId: null }).toEqual({ ...stranded, ownerUserId: null });
    expect(await repointMergedLedgerOwners(db)).toBe(0);
    expect((await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: kept.id } })).ownerUserId).toBe(u);
  });

  it('with a survivor named, only that survivor\'s direct sources are touched', async () => {
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    const other = await mk('mg-other');
    await mergeUsers(db, { sourceUserId: other, targetUserId: u, actorUserId: admin });
    const e1 = await entry(s);
    const e2 = await entry(other);
    expect(await repointMergedLedgerOwners(db, { survivor: t })).toBe(1);
    expect((await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: e1.id } })).ownerUserId).toBe(t);
    expect((await db.creditLedgerEntry.findUniqueOrThrow({ where: { id: e2.id } })).ownerUserId).toBe(other);
  });

  it('the hourly job runs it before settling, so a stranded settlement never costs the survivor a second one', async () => {
    const grant = await entry(s, { amountMicroCents: 100n, createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) });
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    await entry(s, { kind: 'adjustment', amountMicroCents: -100n, sourceType: 'grant-expiry', sourceId: grant.id });
    await expireCreditGrants(db);
    expect(await db.creditLedgerEntry.count({ where: { ownerUserId: s } })).toBe(0);
    expect(await db.creditLedgerEntry.count({ where: { sourceType: 'grant-expiry', ownerUserId: t } })).toBe(1);
  });
  it('a failed re-point skips the person leg of the run (no settlement over a partial ledger) and leaves the organization leg alone', async () => {
    await entry(t, { amountMicroCents: 100n, createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) });
    const failing = new Proxy(db, {
      get: (target, prop, recv) =>
        prop === '$executeRaw' ? async () => { throw new Error('boom'); } : Reflect.get(target, prop, recv),
    }) as typeof db;
    const settled: unknown[] = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expireCreditGrants(failing, { settle: async (_d, owner) => { settled.push(owner); return []; } });
    } finally {
      quiet.mockRestore();
    }
    expect(settled.filter((o) => 'userId' in (o as object))).toEqual([]);
  });
  it('a move cannot collide: the only unique key is (source_type, source_id), so the survivor holding its own settlement does not abort it', async () => {
    const uniques = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'credit_ledger_entries' AND indexdef ILIKE '%UNIQUE%' AND indexname <> 'credit_ledger_entries_pkey'`;
    expect(uniques.map((x) => x.indexdef.replace(/^.*\(/, '('))).toEqual(['(source_type, source_id)']);
    const g1 = await entry(s, { createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) });
    const g2 = await entry(t, { createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) });
    await mergeUsers(db, { sourceUserId: s, targetUserId: t, actorUserId: admin });
    await entry(t, { kind: 'adjustment', amountMicroCents: -100n, sourceType: 'grant-expiry', sourceId: g2.id });
    await entry(s, { kind: 'adjustment', amountMicroCents: -100n, sourceType: 'grant-expiry', sourceId: g1.id });
    expect(await repointMergedLedgerOwners(db)).toBe(1);
    expect(await db.creditLedgerEntry.count({ where: { ownerUserId: t, sourceType: 'grant-expiry' } })).toBe(2);
  });
});
