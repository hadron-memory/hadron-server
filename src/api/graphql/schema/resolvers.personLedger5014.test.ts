/**
 * hadron-server#5014 (Billing A6): a person has a credit ledger.
 *
 * An entry names exactly one owner, an organization or a person (hrn:node:hadronmemory.com:specs:cor:dmo:170:01);
 * `creditBalance`, `creditLedgerEntries`, `grantCredits` and `adjustCredits` take `userRef` beside `orgRef`. A person
 * reads their own ledger; a platform admin reads any; nobody else does, and the refusal does not tell whether the
 * named person exists (cor:api:140:02). Writes are for a platform admin or the BILLING role, as for an organization.
 *
 * Every pin is red on main because neither the column nor the argument exists.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}
type Result = Awaited<ReturnType<typeof gql>>;
const code = (res: Result) => res.errors?.[0]?.extensions?.code;

const GRANT = `mutation($input: GrantCreditsInput!) { grantCredits(input: $input) { id organizationId ownerUserId amountMicroCents } }`;
const ADJUST = `mutation($input: AdjustCreditsInput!) { adjustCredits(input: $input) { id organizationId ownerUserId amountMicroCents } }`;
const BALANCE = `query($orgRef: String, $userRef: ID) { creditBalance(orgRef: $orgRef, userRef: $userRef) { organizationId ownerUserId balanceMicroCents } }`;
const LEDGER = `query($orgRef: String, $userRef: ID) { creditLedgerEntries(orgRef: $orgRef, userRef: $userRef) { total items { id organizationId ownerUserId amountMicroCents } } }`;

let admin: string, billing: string, orgAdmin: string, p: string, q: string, stranger: string;
let orgId: string;
const ctxOf = (userId: string, roles: Context['roles'] = ['READER']): Partial<Context> => ({ userId, roles });
const adminCtx = () => ctxOf(admin, ['ADMIN']);
const billingCtx = () => ctxOf(billing, ['BILLING']);

const grant = (over: Record<string, unknown> = {}) => ({
  userRef: p, amountMicroCents: '1000', sourceType: 'stripe-checkout', sourceId: 'cs_p1', ...over,
});

beforeEach(async () => {
  await cleanDb(db);
  const mk = (n: number, name: string, roles: ('ADMIN' | 'READER' | 'BILLING')[]) =>
    db.user.create({ data: { id: generateId(), githubId: 50_140 + n, githubUsername: name, handle: name, roles } });
  admin = (await mk(1, 'pl-admin', ['ADMIN'])).id;
  billing = (await mk(2, 'pl-billing', ['BILLING'])).id;
  orgAdmin = (await mk(3, 'pl-orgadmin', ['READER'])).id;
  p = (await mk(4, 'pl-p', ['READER'])).id;
  q = (await mk(5, 'pl-q', ['READER'])).id;
  stranger = (await mk(6, 'pl-stranger', ['READER'])).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'pl-org', urn: 'pl-org' } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
});

describe('pin 1: a platform admin grants to a person', () => {
  it('the entry names the person and no organization; the person\'s balance moves and the organization\'s does not', async () => {
    const g = await gql(GRANT, adminCtx(), { input: grant() });
    expect(g.errors).toBeUndefined();
    expect(g.data).toMatchObject({ grantCredits: { organizationId: null, ownerUserId: p, amountMicroCents: '1000' } });
    const bal = await gql(BALANCE, ctxOf(p), { userRef: p });
    expect(bal.errors).toBeUndefined();
    expect(bal.data).toMatchObject({ creditBalance: { organizationId: null, ownerUserId: p, balanceMicroCents: '1000' } });
    const orgBal = await gql(BALANCE, adminCtx(), { orgRef: orgId });
    expect(orgBal.data).toMatchObject({ creditBalance: { organizationId: orgId, ownerUserId: null, balanceMicroCents: '0' } });
  });

  it('userRef accepts a handle and a hrn:user: URN (cor:api:140:01)', async () => {
    expect((await gql(GRANT, adminCtx(), { input: grant({ userRef: 'pl-p' }) })).errors).toBeUndefined();
    const byUrn = await gql(GRANT, adminCtx(), { input: grant({ userRef: 'hrn:user:pl-p', sourceId: 'cs_p2' }) });
    expect(byUrn.errors).toBeUndefined();
    expect((byUrn.data as { grantCredits: { ownerUserId: string } }).grantCredits.ownerUserId).toBe(p);
  });
});

describe('pin 2: exactly one of orgRef and userRef', () => {
  it('both, and neither: BAD_USER_INPUT on all four calls, and no row is written', async () => {
    const both = { orgRef: orgId, userRef: p };
    const calls: [string, Record<string, unknown>][] = [
      [GRANT, { input: { ...grant(), ...both } }],
      [ADJUST, { input: { ...both, amountMicroCents: '-5', sourceType: 'refund', sourceId: 'r1', note: 'n' } }],
      [BALANCE, both],
      [LEDGER, both],
    ];
    for (const [query, variables] of calls) expect(code(await gql(query, adminCtx(), variables))).toBe('BAD_USER_INPUT');
    const neither: [string, Record<string, unknown>][] = [
      [GRANT, { input: { amountMicroCents: '1000', sourceType: 'stripe-checkout', sourceId: 'cs_n' } }],
      [BALANCE, {}],
      [LEDGER, {}],
    ];
    for (const [query, variables] of neither) {
      const res = await gql(query, adminCtx(), variables);
      expect(res.errors?.length ?? 0).toBeGreaterThan(0);
      expect(code(res)).toBe('BAD_USER_INPUT');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});

describe('pin 5: a person does not read another person\'s ledger, and the refusal does not tell who exists', () => {
  it('P reads Q: FORBIDDEN; P reads a missing id and a missing handle: the same error, byte for byte', async () => {
    await gql(GRANT, adminCtx(), { input: grant({ userRef: q, sourceId: 'cs_q' }) });
    for (const query of [BALANCE, LEDGER]) {
      const existing = await gql(query, ctxOf(p), { userRef: q });
      const missingId = await gql(query, ctxOf(p), { userRef: generateId() });
      const missingHandle = await gql(query, ctxOf(p), { userRef: 'hrn:user:nobody-here' });
      expect(code(existing)).toBe('FORBIDDEN');
      expect(existing.data ?? null).toBeNull();
      expect(JSON.stringify(missingId.errors?.map((e) => [e.message, e.extensions]))).toBe(
        JSON.stringify(existing.errors?.map((e) => [e.message, e.extensions])),
      );
      expect(JSON.stringify(missingHandle.errors?.map((e) => [e.message, e.extensions]))).toBe(
        JSON.stringify(existing.errors?.map((e) => [e.message, e.extensions])),
      );
    }
  });

  it('an organization ADMIN and a stranger cannot read a person either', async () => {
    await gql(GRANT, adminCtx(), { input: grant() });
    expect(code(await gql(BALANCE, ctxOf(orgAdmin), { userRef: p }))).toBe('FORBIDDEN');
    expect(code(await gql(LEDGER, ctxOf(stranger), { userRef: p }))).toBe('FORBIDDEN');
  });
});

describe('pin 6: an impersonated session and an App key read nobody\'s person ledger', () => {
  it('an impersonated session of P cannot read P; an App-key context cannot read P', async () => {
    await gql(GRANT, adminCtx(), { input: grant() });
    const impersonated: Partial<Context> = {
      userId: p, roles: [],
      impersonation: { sessionId: 's1', actorUserId: admin, orgId, expiresAt: new Date(Date.now() + 60_000) },
    };
    expect(code(await gql(BALANCE, impersonated, { userRef: p }))).toBe('FORBIDDEN');
    expect(code(await gql(LEDGER, impersonated, { userRef: p }))).toBe('FORBIDDEN');
    const appKey: Partial<Context> = { appKeyId: generateId(), appId: generateId(), roles: [] };
    expect(code(await gql(BALANCE, appKey, { userRef: p }))).toBe('FORBIDDEN');
    expect(code(await gql(LEDGER, appKey, { userRef: p }))).toBe('FORBIDDEN');
  });

  it('an impersonation context is refused on the credential even if it somehow carried an admin role (the arm is direct, not only isStrictOwner)', async () => {
    await gql(GRANT, adminCtx(), { input: grant() });
    // roles are [] for an impersonated session by construction; a context that carried ADMIN anyway must still not read a person's ledger.
    const impersonatedAdmin: Partial<Context> = {
      userId: admin, roles: ['ADMIN'],
      impersonation: { sessionId: 's2', actorUserId: admin, orgId, expiresAt: new Date(Date.now() + 60_000) },
    };
    expect(code(await gql(BALANCE, impersonatedAdmin, { userRef: p }))).toBe('FORBIDDEN');
    expect(code(await gql(LEDGER, impersonatedAdmin, { userRef: p }))).toBe('FORBIDDEN');
  });

  it('an App-key context that carries a userId is still refused (the arm is judged on the credential, not on userId)', async () => {
    await gql(GRANT, adminCtx(), { input: grant() });
    const appKeyWithUser: Partial<Context> = { userId: p, appKeyId: generateId(), appId: generateId(), roles: [] };
    expect(code(await gql(BALANCE, appKeyWithUser, { userRef: p }))).toBe('FORBIDDEN');
  });
});

describe('pin 7: a person reads their own ledger; a platform admin reads any', () => {
  it('P: own balance and ledger; admin: P\'s balance and ledger', async () => {
    await gql(GRANT, adminCtx(), { input: grant() });
    const own = await gql(LEDGER, ctxOf(p), { userRef: p });
    expect(own.errors).toBeUndefined();
    expect(own.data).toMatchObject({ creditLedgerEntries: { total: 1, items: [{ organizationId: null, ownerUserId: p }] } });
    const byAdmin = await gql(BALANCE, adminCtx(), { userRef: 'pl-p' });
    expect(byAdmin.data).toMatchObject({ creditBalance: { ownerUserId: p, balanceMicroCents: '1000' } });
    expect((await gql(LEDGER, adminCtx(), { userRef: p })).errors).toBeUndefined();
  });

  it('a platform admin naming a person who does not exist gets the typed not-found, not FORBIDDEN', async () => {
    const res = await gql(BALANCE, adminCtx(), { userRef: generateId() });
    expect(code(res)).toBe('USER_NOT_FOUND');
  });
});

describe('pin 8 and 16: who may write a person\'s ledger', () => {
  it('an organization ADMIN who is not a platform admin cannot grant or adjust to a person; no row', async () => {
    expect(code(await gql(GRANT, ctxOf(orgAdmin), { input: grant() }))).toBe('FORBIDDEN');
    expect(code(await gql(ADJUST, ctxOf(orgAdmin), {
      input: { userRef: p, amountMicroCents: '-1', sourceType: 'refund', sourceId: 'r', note: 'n' },
    }))).toBe('FORBIDDEN');
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('a person cannot grant to themselves', async () => {
    expect(code(await gql(GRANT, ctxOf(p), { input: grant() }))).toBe('FORBIDDEN');
  });

  it('a BILLING user grants and adjusts a person\'s ledger, and cannot read it', async () => {
    expect((await gql(GRANT, billingCtx(), { input: grant() })).errors).toBeUndefined();
    const adj = await gql(ADJUST, billingCtx(), {
      input: { userRef: p, amountMicroCents: '-300', sourceType: 'refund', sourceId: 'r1', note: 'partial refund' },
    });
    expect(adj.errors).toBeUndefined();
    expect(adj.data).toMatchObject({ adjustCredits: { ownerUserId: p, organizationId: null } });
    expect(code(await gql(BALANCE, billingCtx(), { userRef: p }))).toBe('FORBIDDEN');
  });

  it('a soft-deleted person is not found by a write (a grant to an erased account is refused)', async () => {
    await db.user.update({ where: { id: q }, data: { deletedAt: new Date() } });
    const res = await gql(GRANT, adminCtx(), { input: grant({ userRef: q, sourceId: 'cs_del' }) });
    expect(code(res)).toBe('USER_NOT_FOUND');
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});

describe('pin 9: one source pair belongs to one owner', () => {
  it('an organization\'s pair replayed for a person, and a person\'s replayed for another person, is IDEMPOTENCY_CONFLICT', async () => {
    const org = await gql(GRANT, adminCtx(), {
      input: { orgRef: orgId, amountMicroCents: '1000', sourceType: 'stripe-checkout', sourceId: 'cs_x' },
    });
    expect(org.errors).toBeUndefined();
    expect(code(await gql(GRANT, adminCtx(), { input: grant({ sourceId: 'cs_x' }) }))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await gql(GRANT, adminCtx(), { input: grant({ sourceId: 'cs_y' }) })).errors).toBeUndefined();
    expect(code(await gql(GRANT, adminCtx(), { input: grant({ userRef: q, sourceId: 'cs_y' }) }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(await gql(GRANT, adminCtx(), {
      input: { orgRef: orgId, amountMicroCents: '1000', sourceType: 'stripe-checkout', sourceId: 'cs_y' },
    }))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a true replay for the same person returns the same entry (two null columns never read as one owner)', async () => {
    const a = await gql(GRANT, adminCtx(), { input: grant() });
    const b = await gql(GRANT, adminCtx(), { input: grant() });
    expect(b.errors).toBeUndefined();
    expect((b.data as { grantCredits: { id: string } }).grantCredits.id).toBe((a.data as { grantCredits: { id: string } }).grantCredits.id);
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });
});

describe('pin 10: an account merge moves the merged-away person\'s entries to the survivor', () => {
  it('the survivor\'s balance includes them, and they keep amount, source and expiry', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    await gql(GRANT, adminCtx(), { input: grant({ userRef: q, sourceId: 'cs_q', amountMicroCents: '400', expiresAt: expiresAt.toISOString() }) });
    await gql(GRANT, adminCtx(), { input: grant({ sourceId: 'cs_p' }) });
    await mergeUsers(db, { sourceUserId: q, targetUserId: p, actorUserId: admin });
    const rows = await db.creditLedgerEntry.findMany({ where: { sourceId: 'cs_q' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerUserId: p, organizationId: null, amountMicroCents: 400n });
    expect(rows[0]!.expiresAt?.getTime()).toBe(expiresAt.getTime());
    const bal = await gql(BALANCE, ctxOf(p), { userRef: p });
    expect(bal.data).toMatchObject({ creditBalance: { balanceMicroCents: '1400' } });
  });
});

describe('pin 13 and ruling 4: deleteUser keeps a person\'s entries, and only a platform admin can still read them', () => {
  const DELETE = `mutation($u: ID, $r: String) { deleteUser(userRef: $u, reason: $r) }`;
  it('after deleteUser the entries and the balance are unchanged; an admin reads them, nobody else does', async () => {
    await gql(GRANT, adminCtx(), { input: grant({ userRef: q, sourceId: 'cs_q' }) });
    const del = await gql(DELETE, adminCtx(), { u: q, r: 'pin 13' });
    expect(del.errors).toBeUndefined();
    expect(await db.creditLedgerEntry.count({ where: { ownerUserId: q } })).toBe(1);
    const byAdmin = await gql(BALANCE, adminCtx(), { userRef: q });
    expect(byAdmin.errors).toBeUndefined();
    expect(byAdmin.data).toMatchObject({ creditBalance: { ownerUserId: q, balanceMicroCents: '1000' } });
    expect((await gql(LEDGER, adminCtx(), { userRef: q })).data).toMatchObject({ creditLedgerEntries: { total: 1 } });
    // an erased account is not found by anyone else, so the read is the same FORBIDDEN as for a person who never existed
    expect(code(await gql(BALANCE, ctxOf(p), { userRef: q }))).toBe('FORBIDDEN');
    expect(code(await gql(BALANCE, ctxOf(q), { userRef: q }))).toBe('FORBIDDEN');
    // a write never reaches an erased account
    expect(code(await gql(GRANT, adminCtx(), { input: grant({ userRef: q, sourceId: 'cs_q2' }) }))).toBe('USER_NOT_FOUND');
  });
});

describe('pin 14: an organization\'s calls answer as before', () => {
  it('organizationId set, ownerUserId null, and the org ADMIN gate is unchanged', async () => {
    const g = await gql(GRANT, adminCtx(), {
      input: { orgRef: orgId, amountMicroCents: '50', sourceType: 'stripe-checkout', sourceId: 'cs_org' },
    });
    expect(g.data).toMatchObject({ grantCredits: { organizationId: orgId, ownerUserId: null } });
    expect((await gql(BALANCE, ctxOf(orgAdmin), { orgRef: orgId })).data).toMatchObject({
      creditBalance: { organizationId: orgId, ownerUserId: null, balanceMicroCents: '50' },
    });
    expect(code(await gql(BALANCE, ctxOf(stranger), { orgRef: orgId }))).toBe('FORBIDDEN');
  });
});
