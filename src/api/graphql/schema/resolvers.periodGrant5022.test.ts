/**
 * hadron-server#5022 (Billing A9): `creditBalance` ensures the month's default grant for the owner it was asked about
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:12), after its gate, never for an impersonated session (S4), and a failure to
 * write it never fails the read (cor:dmo:170:09).
 *
 * Red on main: `../../../lib/metering/periodGrant.js` does not exist, so the file fails at import; on main the read writes
 * nothing whatever the setting says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import {
  ensurePeriodGrant,
  PERIOD_GRANT_SOURCE_TYPE,
  periodGrantDue,
  reloadOwnerDefaultMonthlyGrantForTests,
  resetPeriodGrantStateForTests,
  setPeriodGrantWriterForTests,
} from '../../../lib/metering/periodGrant.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}
const BALANCE = `query($orgRef: String, $userRef: ID) { creditBalance(orgRef: $orgRef, userRef: $userRef) { balanceMicroCents } }`;
const balanceOf = (res: Awaited<ReturnType<typeof gql>>) =>
  (res.data as { creditBalance: { balanceMicroCents: string } } | null)?.creditBalance.balanceMicroCents;

let admin: string, orgAdmin: string, p: string;
let orgId: string;
const ctxOf = (userId: string, roles: Context['roles'] = ['READER']): Partial<Context> => ({ userId, roles });
const grants = () => db.creditLedgerEntry.findMany({ where: { sourceType: PERIOD_GRANT_SOURCE_TYPE } });
const firstOfNextUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

beforeEach(async () => {
  await cleanDb(db);
  resetPeriodGrantStateForTests();
  setPeriodGrantWriterForTests(null);
  const mk = (n: number, name: string, roles: ('ADMIN' | 'READER')[]) =>
    db.user.create({ data: { id: generateId(), githubId: 50_221_000 + n, githubUsername: name, handle: name, roles } });
  admin = (await mk(1, 'pgr-admin', ['ADMIN'])).id;
  orgAdmin = (await mk(2, 'pgr-orgadmin', ['READER'])).id;
  p = (await mk(3, 'pgr-p', ['READER'])).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'pgr-org', urn: 'pgr-org' } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
});

afterEach(() => {
  reloadOwnerDefaultMonthlyGrantForTests({});
  setPeriodGrantWriterForTests(null);
  vi.restoreAllMocks();
});

describe('G1: a person\'s first read of the month', () => {
  it('writes one grant expiring at the next UTC month and answers a balance that includes it', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const res = await gql(BALANCE, ctxOf(p), { userRef: p });
    expect(res.errors).toBeUndefined();
    expect(balanceOf(res)).toBe('1234');
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerUserId: p, kind: 'grant', amountMicroCents: 1234n, createdBy: 'system:period-grant' });
    expect(rows[0]!.expiresAt!.toISOString()).toBe(firstOfNextUtcMonth(rows[0]!.createdAt).toISOString());
    expect(balanceOf(await gql(BALANCE, ctxOf(p), { userRef: p }))).toBe('1234');
    expect(await grants()).toHaveLength(1);
  });

  it('the read that writes the grant lists it under expiring (QA P3, #5317): the grant is dated at the read\'s instant', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const q = `query($userRef: ID) { creditBalance(userRef: $userRef) { balanceMicroCents expiring { amountMicroCents expiresAt } } }`;
    const res = await gql(q, ctxOf(p), { userRef: p });
    expect(res.errors).toBeUndefined();
    const cb = (res.data as { creditBalance: { balanceMicroCents: string; expiring: { amountMicroCents: string; expiresAt: string }[] } })
      .creditBalance;
    expect(cb.balanceMicroCents).toBe('1234');
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(cb.expiring).toEqual([{ amountMicroCents: '1234', expiresAt: rows[0]!.expiresAt!.toISOString() }]);
  });

  it('a platform admin\'s read writes the person\'s grant, recorded as system:period-grant, not as the admin', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    expect(balanceOf(await gql(BALANCE, ctxOf(admin, ['ADMIN']), { userRef: p }))).toBe('1234');
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerUserId: p, createdBy: 'system:period-grant' });
  });

  it('a refused read writes nothing (the grant follows the gate)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234","organization":"0"}' });
    expect((await gql(BALANCE, ctxOf(p), { orgRef: orgId })).errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect((await gql(BALANCE, ctxOf(orgAdmin), { userRef: p })).errors).toBeDefined();
    expect(await grants()).toHaveLength(0);
  });
});

describe('G11: a soft-deleted owner never receives the grant (issue section 8; sec10 P3-1 on #5317)', () => {
  it('a platform admin\'s read of a soft-deleted person writes no grant and adds none to the figure', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    await db.user.update({ where: { id: p }, data: { deletedAt: new Date() } });
    const res = await gql(BALANCE, ctxOf(admin, ['ADMIN']), { userRef: p });
    expect(res.errors).toBeUndefined();
    expect(balanceOf(res)).toBe('0');
    expect(await grants()).toHaveLength(0);
  });

  it('the library writes no grant and owes none for a soft-deleted organization', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"777"}' });
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    const now = new Date();
    expect(await periodGrantDue(db, { organizationId: orgId }, now)).toBe(0n);
    await ensurePeriodGrant(db, { organizationId: orgId }, now);
    expect(await grants()).toHaveLength(0);
  });
});

describe('G2: two concurrent reads in a new month', () => {
  it('write one grant; neither read fails; both answer it', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const [a, b] = await Promise.all([gql(BALANCE, ctxOf(p), { userRef: p }), gql(BALANCE, ctxOf(p), { userRef: p })]);
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();
    expect(balanceOf(a)).toBe('1234');
    expect(balanceOf(b)).toBe('1234');
    expect(await grants()).toHaveLength(1);
  });
});

describe('G6: an impersonated read writes nothing', () => {
  const impersonating = () => ({
    ...ctxOf(orgAdmin),
    impersonation: { sessionId: generateId(), actorUserId: admin, orgId, expiresAt: new Date(Date.now() + 60_000) },
  }) as Partial<Context>;

  it('an organization is owed nothing, and an impersonated read adds nothing to its figure (cor:dmo:170:12)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"777"}' });
    const res = await gql(BALANCE, impersonating(), { orgRef: orgId });
    expect(res.errors).toBeUndefined();
    expect(await grants()).toHaveLength(0);
    expect(balanceOf(res)).toBe('0');
  });
});

describe('G7: with no amount, a read writes nothing', () => {
  it('unset (green on main: a guard)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({});
    expect(balanceOf(await gql(BALANCE, ctxOf(p), { userRef: p }))).toBe('0');
    expect(await grants()).toHaveLength(0);
  });
});

describe('G11: a failed write never fails the read', () => {
  it('the read answers the balance as it is, logs owner id and code, and the next read writes', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"1234"}' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPeriodGrantWriterForTests(async () => { throw Object.assign(new Error('down'), { code: 'P1001' }); });
    const res = await gql(BALANCE, ctxOf(p), { userRef: p });
    expect(res.errors).toBeUndefined();
    expect(balanceOf(res)).toBe('0');
    expect(err.mock.calls.filter((c) => c[0] === 'period_grant.failed')).toEqual([['period_grant.failed', { ownerUserId: p, code: 'P1001' }]]);
    setPeriodGrantWriterForTests(null);
    expect(balanceOf(await gql(BALANCE, ctxOf(p), { userRef: p }))).toBe('1234');
  });
});

describe('G12: an organization ADMIN\'s read', () => {
  it('writes no grant on the organization\'s ledger, with a user grant configured (cor:dmo:170:12)', async () => {
    reloadOwnerDefaultMonthlyGrantForTests({ OWNER_DEFAULT_MONTHLY_GRANT: '{"user":"777"}' });
    expect(balanceOf(await gql(BALANCE, ctxOf(orgAdmin), { orgRef: orgId }))).toBe('0');
    expect(await grants()).toHaveLength(0);
  });
});
