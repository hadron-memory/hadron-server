/**
 * #5011 (Billing A4): creditBalance settles expired grants before it sums, never writes for an impersonated session,
 * never answers a balance that holds credit whose expiry has passed, and gains `expiring`.
 *
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:10, hrn:node:hadronmemory.com:specs:cor:dmo:170:11; gate rulings 10.1
 * (settle at expiresAt <= now - 60 s, every read answers the computed figure), 10.3 (a grant already expired is
 * refused), 10.4 (a settlement that fails in a read logs one line and the read answers the computed figure), 10.7 (one
 * figure rule for the impersonated read and a read inside the 60 s).
 *
 * Red on main: `expiring` is not a field of CreditBalance (a validation error), the balance includes the expired
 * remainder, nothing settles, and grantCredits accepts an expiry in the past.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  return single(res);
}
function single(res: Awaited<ReturnType<typeof server.executeOperation>>) {
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

const BALANCE = `query($orgRef: String!) { creditBalance(orgRef: $orgRef) {
  organizationId balanceMicroCents expiring { amountMicroCents expiresAt } } }`;
const BALANCE_ONLY = `query($orgRef: String!) { creditBalance(orgRef: $orgRef) { balanceMicroCents } }`;
const GRANT = `mutation($input: GrantCreditsInput!) { grantCredits(input: $input) { id expiresAt } }`;

let platformAdmin: string, orgAdmin: string, contributor: string, stranger: string, orgId: string;
const platformCtx = (): Partial<Context> => ({ userId: platformAdmin, roles: ['ADMIN'] });
const orgAdminCtx = (): Partial<Context> => ({ userId: orgAdmin, roles: ['READER'] });
const impersonatedCtx = (): Partial<Context> => ({
  userId: orgAdmin,
  roles: [],
  impersonation: { sessionId: generateId(), actorUserId: platformAdmin, orgId, expiresAt: new Date(Date.now() + 60_000) },
});

async function dbNow(): Promise<Date> {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row.now;
}
const shift = (at: Date, ms: number) => new Date(at.getTime() + ms);

async function entry(kind: 'grant' | 'debit', amount: number, createdAt: Date, expiresAt: Date | null = null) {
  return db.creditLedgerEntry.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      kind,
      amountMicroCents: kind === 'debit' ? -BigInt(amount) : BigInt(amount),
      expiresAt,
      sourceType: kind === 'debit' ? 'usage-event' : 'test-grant',
      sourceId: generateId(),
      createdAt,
    },
  });
}
const settlementCount = () => db.creditLedgerEntry.count({ where: { sourceType: 'grant-expiry' } });

beforeEach(async () => {
  await cleanDb(db);
  const mkUser = (n: number, name: string) => db.user.create({ data: { id: generateId(), githubId: 50110 + n, githubUsername: name } });
  platformAdmin = (await mkUser(1, 'ce-platform')).id;
  orgAdmin = (await mkUser(2, 'ce-orgadmin')).id;
  contributor = (await mkUser(3, 'ce-contrib')).id;
  stranger = (await mkUser(4, 'ce-stranger')).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ce-org', urn: 'ce-org-r' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: contributor, role: 'CONTRIBUTOR' } });
});

/** A client whose `creditLedgerEntry` is wrapped by `wrap`, also inside every `$transaction` it opens (the real transaction client). */
function withLedger(base: typeof db, wrap: (ledger: typeof db.creditLedgerEntry) => typeof db.creditLedgerEntry): typeof db {
  return new Proxy(base, {
    get(target, key) {
      if (key === 'creditLedgerEntry') return wrap(target.creditLedgerEntry);
      if (key === '$transaction') {
        return (fn: (tx: unknown) => unknown, opts: unknown) =>
          (target.$transaction as (f: (t: unknown) => unknown, o: unknown) => unknown)((tx) => fn(withLedger(tx as typeof db, wrap)), opts);
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as typeof db;
}

describe('#5011 creditBalance and grant expiry', () => {
  it('R1: one second after an expiry the balance is already lower and `expiring` leaves the grant out', async () => {
    const now = await dbNow();
    await entry('grant', 100, shift(now, -3_600_000), shift(now, -1_000));
    await entry('debit', 30, shift(now, -1_800_000));
    const res = await gql(BALANCE, orgAdminCtx(), { orgRef: orgId });
    expect(res.errors).toBeUndefined();
    expect((res.data as { creditBalance: unknown }).creditBalance).toEqual({
      organizationId: orgId,
      balanceMicroCents: '0',
      expiring: [],
    });
    // Inside the 60 s the read computes the figure and writes nothing (ruling 10.1).
    expect(await settlementCount()).toBe(0);
  });

  it('R1b: a read more than 60 s after the expiry writes the settlement first, then sums', async () => {
    const now = await dbNow();
    const g = await entry('grant', 100, shift(now, -3_600_000), shift(now, -120_000));
    await entry('debit', 30, shift(now, -1_800_000));
    const res = await gql(BALANCE_ONLY, orgAdminCtx(), { orgRef: orgId });
    expect(res.errors).toBeUndefined();
    expect((res.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents).toBe('0');
    const rows = await db.creditLedgerEntry.findMany({ where: { sourceType: 'grant-expiry' } });
    expect(rows.map((r) => [r.sourceId, r.amountMicroCents])).toEqual([[g.id, -70n]]);
    // The stored entries now add up to the answer.
    const agg = await db.creditLedgerEntry.aggregate({ where: { organizationId: orgId }, _sum: { amountMicroCents: true } });
    expect(agg._sum.amountMicroCents).toBe(0n);
  });

  it('R2: an impersonated read shows the same balance and writes nothing', async () => {
    const now = await dbNow();
    await entry('grant', 100, shift(now, -3_600_000), shift(now, -120_000));
    await entry('debit', 30, shift(now, -1_800_000));
    const before = await db.creditLedgerEntry.count();
    const res = await gql(BALANCE, impersonatedCtx(), { orgRef: orgId });
    expect(res.errors).toBeUndefined();
    expect((res.data as { creditBalance: { balanceMicroCents: string; expiring: unknown[] } }).creditBalance).toMatchObject({
      balanceMicroCents: '0',
      expiring: [],
    });
    expect(await db.creditLedgerEntry.count()).toBe(before);
  });

  it('R3: `expiring` lists what is left of each unexpired grant, soonest first, beside credit that never expires', async () => {
    const now = await dbNow();
    const soon = shift(now, 86_400_000);
    const late = shift(now, 30 * 86_400_000);
    await entry('grant', 200, shift(now, -7_200_000), late);
    await entry('grant', 100, shift(now, -7_000_000), soon);
    await entry('grant', 500, shift(now, -6_000_000));
    await entry('debit', 40, shift(now, -3_600_000));
    const res = await gql(BALANCE, orgAdminCtx(), { orgRef: orgId });
    expect(res.errors).toBeUndefined();
    expect((res.data as { creditBalance: unknown }).creditBalance).toEqual({
      organizationId: orgId,
      balanceMicroCents: '760',
      expiring: [
        { amountMicroCents: '60', expiresAt: soon.toISOString() },
        { amountMicroCents: '200', expiresAt: late.toISOString() },
      ],
    });
  });

  it('R4: a contributor and a stranger are FORBIDDEN on a read selecting `expiring`', async () => {
    for (const userId of [contributor, stranger]) {
      const res = await gql(BALANCE, { userId, roles: ['READER'] }, { orgRef: orgId });
      expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
  });

  it('R5: GrantCreditsInput.expiresAt states the enforced rule; the input keeps its fields and types', () => {
    const block = typeDefs.match(/input GrantCreditsInput \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(block).not.toMatch(/no enforcement/);
    expect(block).toMatch(/expires/i);
    const fields = [...block.matchAll(/^\s{4}(\w+): ([\w!]+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
    // #5014 (A6): orgRef becomes optional and userRef is new (exactly one of the two is required by the resolver).
    expect(fields).toEqual([
      'orgRef: String',
      'userRef: ID',
      'amountMicroCents: String!',
      'expiresAt: String',
      'sourceType: String',
      'sourceId: String',
      'note: String',
    ]);
  });

  it('R7 (ruling 10.4): a settlement that fails inside the read logs one line and answers the computed figure', async () => {
    const now = await dbNow();
    await entry('grant', 100, shift(now, -3_600_000), shift(now, -120_000));
    await entry('debit', 30, shift(now, -1_800_000));
    // The settlement's one write fails as a database error would; every read goes through.
    const failing = withLedger(db, (ledger) =>
      new Proxy(ledger, {
        get(target, key) {
          if (key === 'createMany') {
            return () => Promise.reject(Object.assign(new Error('secret detail 70 grant-expiry'), { code: 'P1001' }));
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = single(
        await server.executeOperation(
          { query: BALANCE_ONLY, variables: { orgRef: orgId } },
          { contextValue: { ...orgAdminCtx(), db: failing } as Context },
        ),
      );
      expect(res.errors).toBeUndefined();
      expect((res.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents).toBe('0');
      const lines = log.mock.calls.filter((c) => c[0] === 'credit_expiry.settle_failed');
      expect(lines).toEqual([['credit_expiry.settle_failed', { organizationId: orgId, code: 'P1001' }]]);
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
    } finally {
      log.mockRestore();
    }
    expect(await settlementCount()).toBe(0);
  });

  it('R6 (ruling 10.3): a grant whose expiresAt is not later than now is refused BAD_USER_INPUT and writes nothing', async () => {
    const now = await dbNow();
    for (const expiresAt of [shift(now, -86_400_000).toISOString(), shift(now, -1_000).toISOString()]) {
      const res = await gql(GRANT, platformCtx(), {
        input: { orgRef: orgId, amountMicroCents: '100', expiresAt, sourceType: 'test-grant', sourceId: generateId() },
      });
      expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
    const future = shift(now, 86_400_000).toISOString();
    const ok = await gql(GRANT, platformCtx(), {
      input: { orgRef: orgId, amountMicroCents: '100', expiresAt: future, sourceType: 'test-grant', sourceId: generateId() },
    });
    expect(ok.errors).toBeUndefined();
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });
  it('#5100 item 1: the org-ADMIN gate runs BEFORE any settlement write: a contributor or stranger gets FORBIDDEN and the ledger is unchanged', async () => {
    const now = await dbNow();
    await entry('grant', 100, shift(now, -3_600_000), shift(now, -120_000));
    const before = await db.creditLedgerEntry.count();
    for (const userId of [contributor, stranger]) {
      const res = await gql(BALANCE_ONLY, { userId, roles: ['READER'] }, { orgRef: orgId });
      expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
    expect(await db.creditLedgerEntry.count()).toBe(before);
    expect(await settlementCount()).toBe(0);
  });

  /** A db whose grant-window reads (one per replay, `readReplayWindow`) are counted. */
  function countingDb() {
    const state = { windowReads: 0 };
    const ledger = new Proxy(db.creditLedgerEntry, {
      get(target, key) {
        if (key === 'findMany') {
          return (args: { where?: { kind?: string } }) => {
            if (args?.where?.kind === 'grant') state.windowReads += 1;
            return (target.findMany as (a: unknown) => unknown)(args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const counted = new Proxy(db, {
      get(target, key) {
        if (key === 'creditLedgerEntry') return ledger;
        // The read-only snapshot runs its callback on the counted client (the count, not the isolation, is what this seam pins).
        if (key === '$transaction') return (fn: (tx: unknown) => unknown) => fn(counted);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof db;
    return { state, counted };
  }
  const withDb = (counted: typeof db, ctx: Partial<Context>) => ({ ...ctx, db: counted });
  const run = async (counted: typeof db, query: string, ctx: Partial<Context>) =>
    single(await server.executeOperation({ query, variables: { orgRef: orgId } }, { contextValue: withDb(counted, ctx) as Context }));

  it('#5100 item 2: a read replays the window ONCE, whether it settles, only computes (inside the 60 s, impersonated) or selects `expiring`', async () => {
    const now = await dbNow();
    await entry('grant', 100, shift(now, -3_600_000), shift(now, -120_000)); // settles on a plain read
    await entry('grant', 50, shift(now, -3_600_000), shift(now, -1_000)); // inside the 60 s
    await entry('grant', 70, shift(now, -3_600_000), shift(now, 86_400_000)); // still expiring
    const a = countingDb();
    const res = await run(a.counted, BALANCE, orgAdminCtx());
    expect(res.errors).toBeUndefined();
    expect(a.state.windowReads).toBe(1);
    expect((res.data as { creditBalance: { balanceMicroCents: string; expiring: unknown[] } }).creditBalance.balanceMicroCents).toBe('70');
    expect((res.data as { creditBalance: { expiring: unknown[] } }).creditBalance.expiring).toHaveLength(1);
    // Impersonated: nothing written, still one replay, same figure.
    const b = countingDb();
    const imp = await run(b.counted, BALANCE, impersonatedCtx());
    expect(b.state.windowReads).toBe(1);
    expect((imp.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents).toBe('70');
  });

  it('#5100 item 3: a grant dated after now with an expiry in the past is no hot row: no replay, nothing settled', async () => {
    const now = await dbNow();
    await entry('grant', 100, shift(now, 86_400_000), shift(now, -3_600_000));
    const c = countingDb();
    const res = await run(c.counted, BALANCE_ONLY, orgAdminCtx());
    expect(res.errors).toBeUndefined();
    expect(c.state.windowReads).toBe(0);
    expect(await settlementCount()).toBe(0);
  });
  it('#5100 BLIND P2-1: a read that writes nothing takes its figure from ONE snapshot: a settlement committed between the replay and the sum is not subtracted twice', async () => {
    const now = await dbNow();
    const g = await entry('grant', 100, shift(now, -3_600_000), shift(now, -120_000));
    await entry('debit', 30, shift(now, -1_800_000));
    // Inside the snapshot, after the replay and just before the stored sum is read, another settler commits the grant's settlement.
    let raced = false;
    const snapshotDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return (fn: (tx: unknown) => unknown, opts: unknown) =>
            (target.$transaction as (f: (t: unknown) => unknown, o: unknown) => unknown)((tx) => {
              const ledger = new Proxy((tx as typeof db).creditLedgerEntry, {
                get(t, k) {
                  if (k === 'aggregate') {
                    return async (args: { where?: { createdAt?: unknown } }) => {
                      if (args?.where?.createdAt === undefined && !raced) {
                        raced = true;
                        await db.creditLedgerEntry.create({
                          data: { id: generateId(), organizationId: orgId, kind: 'adjustment', amountMicroCents: -70n, sourceType: 'grant-expiry', sourceId: g.id, createdBy: 'system:credit-expiry' },
                        });
                      }
                      return (t.aggregate as (a: unknown) => Promise<unknown>)(args);
                    };
                  }
                  const v = Reflect.get(t, k);
                  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                },
              });
              return fn(new Proxy(tx as object, { get: (t2, k2) => (k2 === 'creditLedgerEntry' ? ledger : Reflect.get(t2, k2)) }));
            }, opts);
        }
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as typeof db;
    const res = await run(snapshotDb, BALANCE_ONLY, impersonatedCtx());
    expect(res.errors).toBeUndefined();
    expect(raced).toBe(true);
    // 100 granted - 30 debited, the 70 left having expired: 0. Counting the racing settlement twice would answer -70.
    expect((res.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents).toBe('0');
  });
  it('#5242 item 2 (Abigail on #5207): a WRITING read takes its figure from ONE snapshot too: a sweep that settles a grant just past its 60 s mark between the replay and the sum is not subtracted twice', async () => {
    const now = await dbNow();
    // 59.7 s past its expiry for this read (inside the 60 s: unsettled, not written here); the sweep's later clock settles it.
    const g = await entry('grant', 100, shift(now, -3_600_000), shift(now, -59_700));
    let raced = false;
    const racing = withLedger(db, (ledger) =>
      new Proxy(ledger, {
        get(target, key) {
          if (key === 'aggregate') {
            return async (args: { where?: { createdAt?: unknown } }) => {
              if (args?.where?.createdAt === undefined && !raced) {
                raced = true;
                await db.creditLedgerEntry.create({
                  data: { id: generateId(), organizationId: orgId, kind: 'adjustment', amountMicroCents: -100n, sourceType: 'grant-expiry', sourceId: g.id, createdBy: 'system:credit-expiry' },
                });
              }
              return (target.aggregate as (a: unknown) => Promise<unknown>)(args);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    );
    const res = await run(racing, BALANCE_ONLY, orgAdminCtx());
    expect(res.errors).toBeUndefined();
    expect(raced).toBe(true);
    // 100 granted, all of it expired: 0. Counting the racing settlement in the sum AND the remainder would answer -100.
    expect((res.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents).toBe('0');
  });
});
