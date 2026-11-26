/**
 * hadron-server#5014 (Billing A6), pin 15: grant expiry (#5011, A4; hrn:node:hadronmemory.com:specs:cor:dmo:170:10) works for a
 * person's ledger exactly as for an organization's. A4 refused a person owner "until A6" (`ownerOrganizationId` threw); this slice
 * removes that refusal and adapts the probe, the replay window, the settlement writer and the hourly job's owner search.
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { expireCreditGrants } from '../../jobs/expireCreditGrants.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}
const BALANCE = `query($userRef: ID, $orgRef: String) { creditBalance(userRef: $userRef, orgRef: $orgRef) {
  organizationId ownerUserId balanceMicroCents expiring { amountMicroCents } } }`;

const DAY = 86_400_000;
let person: string, other: string, orgId: string;
const meCtx = (): Partial<Context> => ({ userId: person, roles: ['READER'] });

async function grant(owner: { ownerUserId?: string; organizationId?: string }, amount: bigint, createdAgoDays: number, expiresInDays: number | null) {
  const now = Date.now();
  return db.creditLedgerEntry.create({
    data: {
      id: generateId(), ...owner, kind: 'grant', amountMicroCents: amount,
      sourceType: 't', sourceId: generateId(),
      createdAt: new Date(now - createdAgoDays * DAY),
      expiresAt: expiresInDays == null ? null : new Date(now + expiresInDays * DAY),
    },
  });
}
const settlements = () => db.creditLedgerEntry.findMany({ where: { sourceType: 'grant-expiry' } });

beforeEach(async () => {
  await cleanDb(db);
  person = (await db.user.create({ data: { id: generateId(), handle: 'pe-p' } })).id;
  other = (await db.user.create({ data: { id: generateId(), handle: 'pe-q' } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'pe-org', urn: 'pe-org' } })).id;
});

describe('pin 15: a person\'s expired grant is settled', () => {
  it('creditBalance(userRef:) writes the settlement entry on the person, excludes the expired credit, and lists what still expires', async () => {
    const expired = await grant({ ownerUserId: person }, 100n, 3, -1);
    await grant({ ownerUserId: person }, 40n, 1, 5);
    const res = await gql(BALANCE, meCtx(), { userRef: person });
    expect(res.errors).toBeUndefined();
    expect(res.data).toMatchObject({ creditBalance: { organizationId: null, ownerUserId: person, balanceMicroCents: '40', expiring: [{ amountMicroCents: '40' }] } });
    const written = await settlements();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ sourceId: expired.id, amountMicroCents: -100n, ownerUserId: person, organizationId: null });
  });

  it('another person\'s and an organization\'s expired grants take no part', async () => {
    await grant({ ownerUserId: other }, 70n, 3, -1);
    await grant({ organizationId: orgId }, 90n, 3, -1);
    const mine = await grant({ ownerUserId: person }, 10n, 3, -1);
    await gql(BALANCE, meCtx(), { userRef: person });
    const written = await settlements();
    expect(written.map((w) => w.sourceId)).toEqual([mine.id]);
  });

  it('a second read writes nothing more (the pair is unique)', async () => {
    await grant({ ownerUserId: person }, 100n, 3, -1);
    await gql(BALANCE, meCtx(), { userRef: person });
    await gql(BALANCE, meCtx(), { userRef: person });
    expect(await settlements()).toHaveLength(1);
  });
});

describe('pin 15: the hourly job reaches persons and organizations in one run', () => {
  it('settles a person and an organization that no read reached, each on its own column', async () => {
    const pg = await grant({ ownerUserId: person }, 100n, 3, -1);
    const og = await grant({ organizationId: orgId }, 50n, 3, -1);
    const result = await expireCreditGrants(db);
    expect(result).toEqual({ owners: 2, settlements: 2, failures: 0 });
    const byGrant = new Map((await settlements()).map((s) => [s.sourceId, s]));
    expect(byGrant.get(pg.id)).toMatchObject({ ownerUserId: person, organizationId: null, amountMicroCents: -100n });
    expect(byGrant.get(og.id)).toMatchObject({ organizationId: orgId, ownerUserId: null, amountMicroCents: -50n });
  });

  it('a person owner whose settlement throws is counted and logged by owner id, and the persons after it are still settled', async () => {
    const second = (await db.user.create({ data: { id: generateId(), handle: 'pe-r' } })).id;
    await grant({ ownerUserId: person }, 10n, 3, -1);
    await grant({ ownerUserId: second }, 10n, 3, -1);
    const failing = [person, second].sort()[0]!;
    const settle = (async (client, owner, opts) => {
      if ('userId' in owner && owner.userId === failing) throw Object.assign(new Error('boom'), { code: 'P2010' });
      const { settleExpiredGrants } = await import('./settleExpiredGrants.js');
      return settleExpiredGrants(client, owner, opts);
    }) as NonNullable<Parameters<typeof expireCreditGrants>[1]>['settle'];
    expect(await expireCreditGrants(db, { batchSize: 1, settle })).toEqual({ owners: 1, settlements: 1, failures: 1 });
  });

  it('the person leg has its own pass budget: an organization leg that fills it does not starve the persons', async () => {
    const orgs: string[] = [];
    for (let i = 0; i < 2; i++) orgs.push((await db.organization.create({ data: { id: generateId(), name: `pe-o${i}`, urn: `pe-o${i}` } })).id);
    for (const o of orgs) await grant({ organizationId: o }, 5n, 3, -1);
    await grant({ ownerUserId: person }, 5n, 3, -1);
    // batchSize 1, maxPasses 2: the organization leg uses its two passes on two organizations; the person leg still runs.
    const result = await expireCreditGrants(db, { batchSize: 1, maxPasses: 2 });
    expect(result.owners).toBe(3);
  });
});
