/**
 * hadron-server#5020 (Billing A13): `aiSpend(userRef:)`, a person's AI spend read by the billable account, never by the
 * user the work was done for (hrn:node:hadronmemory.com:specs:cor:dmo:170:05). The gate is A6's `requirePersonRecordRead`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
const SPEND = `query($orgRef: String, $userRef: ID, $from: String!, $to: String!, $groupBy: AiSpendGroup!) {
  aiSpend(orgRef: $orgRef, userRef: $userRef, from: $from, to: $to, groupBy: $groupBy) {
    totalGroups rows { key events tokensIn costMicroCents chargedMicroCents } } }`;
const FROM = '2026-03-01T00:00:00.000Z';
const TO = '2026-04-01T00:00:00.000Z';
const MID = new Date('2026-03-10T12:00:00.000Z');
const code = (r: Awaited<ReturnType<typeof gql>>) => r.errors?.[0]?.extensions?.code;

let orgA: string, p: string, q: string, admin: string;
const spendOf = (userRef: string | null, ctx: Partial<Context>, extra: Record<string, unknown> = {}) =>
  gql(SPEND, ctx, { userRef, from: FROM, to: TO, groupBy: 'KEY_OWNER', ...extra });
const ctxOf = (userId: string): Partial<Context> => ({ userId, roles: ['READER'] });
const adminCtx = (): Partial<Context> => ({ userId: admin, roles: ['ADMIN'] });
const ev = (over: Record<string, unknown>) =>
  db.usageEvent.create({ data: { type: 'app-run', tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'm1', keyOwnerType: 'HADRON_SERVER', costMicroCents: 100n, createdAt: MID, ...over } as never });

beforeEach(async () => {
  await cleanDb(db);
  orgA = (await db.organization.create({ data: { id: generateId(), name: 'su-org', urn: 'su-org' } })).id;
  p = (await db.user.create({ data: { id: generateId(), handle: 'su-p' } })).id;
  q = (await db.user.create({ data: { id: generateId(), handle: 'su-q' } })).id;
  admin = (await db.user.create({ data: { id: generateId(), handle: 'su-admin', roles: ['ADMIN'] } })).id;
});

describe('pin 8: a person\'s spend is the units billed to them', () => {
  it('counts P-billed units; leaves out an organization\'s unit done for P and a client-reported recordUsage row', async () => {
    const mine = await ev({ billableUserId: p, userId: q });
    await db.creditLedgerEntry.create({ data: { id: generateId(), ownerUserId: p, kind: 'debit', amountMicroCents: -125n, sourceType: 'usage-event', sourceId: mine.id } });
    await ev({ organizationId: orgA, userId: p }); // an organization's App, done for P
    await ev({ userId: p, keyOwnerType: null, costMicroCents: null }); // recordUsage: caller's tokens, no billable account
    const res = await spendOf(p, ctxOf(p));
    expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
    const s = (res.data as { aiSpend: { rows: Array<Record<string, string | number>>; totalGroups: number } }).aiSpend;
    expect(s.totalGroups).toBe(1);
    expect(s.rows).toEqual([{ key: 'HADRON_SERVER', events: 1, tokensIn: '10', costMicroCents: '100', chargedMicroCents: '125' }]);
  });

  it('does not count a person\'s units for another person, and the organization read of the same units is unchanged', async () => {
    await ev({ billableUserId: q });
    const res = await spendOf(p, ctxOf(p));
    expect((res.data as { aiSpend: { totalGroups: number } }).aiSpend.totalGroups).toBe(0);
    await ev({ organizationId: orgA, userId: p });
    const org = await gql(SPEND, adminCtx(), { orgRef: orgA, userRef: null, from: FROM, to: TO, groupBy: 'KEY_OWNER' });
    expect((org.data as { aiSpend: { rows: Array<{ events: number }> } }).aiSpend.rows[0]!.events).toBe(1);
  });
});

describe('pin 9: who may read a person\'s spend', () => {
  it('another user, an App key, an impersonated session and a missing user: FORBIDDEN, one identical message; a platform admin is admitted', async () => {
    await ev({ billableUserId: p });
    const other = await spendOf(p, ctxOf(q));
    const missing = await spendOf(generateId(), ctxOf(q));
    const appKey = await spendOf(p, { appKeyId: generateId(), appId: generateId(), roles: [] });
    const impersonated = await spendOf(p, {
      userId: p, roles: [], impersonation: { sessionId: 's1', actorUserId: admin, orgId: orgA, expiresAt: new Date(Date.now() + 60_000) },
    });
    for (const r of [other, missing, appKey, impersonated]) expect(code(r)).toBe('FORBIDDEN');
    const messages = new Set([other, missing, appKey, impersonated].map((r) => JSON.stringify([r.errors?.[0]?.message, r.errors?.[0]?.extensions])));
    // the refusal of another user and of a missing user are the same answer; the credential refusals are the same message too
    expect(JSON.stringify([other.errors?.[0]?.message, other.errors?.[0]?.extensions])).toBe(JSON.stringify([missing.errors?.[0]?.message, missing.errors?.[0]?.extensions]));
    expect(new Set([...messages].map((m) => (JSON.parse(m) as [string])[0])).size).toBe(1);
    const byAdmin = await spendOf(p, adminCtx());
    expect(byAdmin.errors).toBeUndefined();
  });
});

describe('pin 10: exactly one of orgRef and userRef', () => {
  it('both, and neither: BAD_USER_INPUT, before any read', async () => {
    expect(code(await gql(SPEND, adminCtx(), { orgRef: orgA, userRef: p, from: FROM, to: TO, groupBy: 'DAY' }))).toBe('BAD_USER_INPUT');
    expect(code(await gql(SPEND, adminCtx(), { orgRef: null, userRef: null, from: FROM, to: TO, groupBy: 'DAY' }))).toBe('BAD_USER_INPUT');
    // judged before the gate: a caller who may not read still gets BAD_USER_INPUT for a malformed call
    expect(code(await gql(SPEND, ctxOf(q), { orgRef: orgA, userRef: p, from: FROM, to: TO, groupBy: 'DAY' }))).toBe('BAD_USER_INPUT');
  });
});

describe('pin 7 (read side): after a merge the survivor\'s spend counts the merged-away person\'s units', () => {
  it('aiSpend(userRef: survivor) counts them and their debits', async () => {
    const e = await ev({ billableUserId: p });
    await db.creditLedgerEntry.create({ data: { id: generateId(), ownerUserId: p, kind: 'debit', amountMicroCents: -50n, sourceType: 'usage-event', sourceId: e.id } });
    await mergeUsers(db, { sourceUserId: p, targetUserId: q, actorUserId: admin });
    const res = await spendOf(q, ctxOf(q));
    expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
    expect((res.data as { aiSpend: { rows: Array<{ events: number; chargedMicroCents: string }> } }).aiSpend.rows).toMatchObject([{ events: 1, chargedMicroCents: '50' }]);
  });
});
