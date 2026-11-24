/**
 * #5011 (Billing A4): creditBalance settles expired grants before it sums, never writes for an impersonated session,
 * never answers a balance that holds credit whose expiry has passed, and gains `expiring`.
 *
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:10, hrn:node:hadronmemory.com:specs:cor:dmo:170:11; gate rulings 10.1
 * (settle at expiresAt <= now - 60 s, every read answers the computed figure), 10.3 (a grant already expired is
 * refused), 10.7 (one figure rule for the impersonated read and a read inside the 60 s).
 *
 * Red on main: `expiring` is not a field of CreditBalance (a validation error), the balance includes the expired
 * remainder, nothing settles, and grantCredits accepts an expiry in the past.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
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
    expect(fields).toEqual([
      'orgRef: String!',
      'amountMicroCents: String!',
      'expiresAt: String',
      'sourceType: String',
      'sourceId: String',
      'note: String',
    ]);
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
});
