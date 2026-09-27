/**
 * Spec 046 — metering GraphQL surface auth matrix.
 *
 * The load-bearing property: setAiModelPrice and grantCredits are PLATFORM
 * ADMIN only — an org ADMIN (who passes requireOrgRole everywhere else on
 * this surface) must be Forbidden on both, since rates set what they are
 * billed at and grants mint money. Ledger reads are org-ADMIN.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { clearPriceCache } from '../../../lib/metering/index.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation(
    { query, variables },
    { contextValue: { db, ...ctx } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

let platformAdmin: string, orgAdmin: string, contributor: string, stranger: string;
let orgId: string;

const platformCtx = (): Partial<Context> => ({ userId: platformAdmin, roles: ['ADMIN'] });
const orgAdminCtx = (): Partial<Context> => ({ userId: orgAdmin, roles: ['READER'] });
const contributorCtx = (): Partial<Context> => ({ userId: contributor, roles: ['READER'] });
const strangerCtx = (): Partial<Context> => ({ userId: stranger, roles: ['READER'] });
const anonCtx = (): Partial<Context> => ({ roles: [] });

const SET_PRICE = `mutation($input: SetAiModelPriceInput!) { setAiModelPrice(input: $input) {
  id provider model tier markupBasisPoints inputMicroCentsPerMTok outputMicroCentsPerMTok effectiveAt } }`;
const GRANT = `mutation($input: GrantCreditsInput!) { grantCredits(input: $input) {
  id kind amountMicroCents organizationId } }`;
const BALANCE = `query($orgRef: String!) { creditBalance(orgRef: $orgRef) {
  organizationId balanceMicroCents } }`;
const LEDGER = `query($orgRef: String!) { creditLedgerEntries(orgRef: $orgRef) {
  total items { kind amountMicroCents } } }`;
const PRICES = `query { aiModelPrices { total items { provider model inputMicroCentsPerMTok } } }`;

const priceInput = {
  provider: 'anthropic',
  model: 'claude-gql',
  inputMicroCentsPerMTok: '30000000',
  outputMicroCentsPerMTok: '150000000',
};

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  const mkUser = (n: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 7200 + n, githubUsername: name } });
  platformAdmin = (await mkUser(1, 'mt-platform')).id;
  orgAdmin = (await mkUser(2, 'mt-orgadmin')).id;
  contributor = (await mkUser(3, 'mt-contrib')).id;
  stranger = (await mkUser(4, 'mt-stranger')).id;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mt-org', urn: 'mt-org' },
  });
  orgId = org.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
  await db.orgMember.create({
    data: { organizationId: orgId, userId: contributor, role: 'CONTRIBUTOR' },
  });
});

describe('setAiModelPrice', () => {
  it('platform admin appends a rate row', async () => {
    const res = await gql(SET_PRICE, platformCtx(), { input: priceInput });
    expect(res.errors).toBeUndefined();
    const row = (res.data as Record<string, Record<string, string>>).setAiModelPrice;
    expect(row.inputMicroCentsPerMTok).toBe('30000000');
  });

  it('org admin is Forbidden — rates set what they are billed at', async () => {
    const res = await gql(SET_PRICE, orgAdminCtx(), { input: priceInput });
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('rejects a duplicate (provider, model, effectiveAt) as BAD_USER_INPUT', async () => {
    const effectiveAt = '2026-01-01T00:00:00.000Z';
    const input = { ...priceInput, effectiveAt };
    expect((await gql(SET_PRICE, platformCtx(), { input })).errors).toBeUndefined();
    const dup = await gql(SET_PRICE, platformCtx(), { input });
    expect(dup.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('refuses a price for openai-compatible, whose cost depends on the host serving it (#1389 review)', async () => {
    const res = await gql(SET_PRICE, platformCtx(), { input: { ...priceInput, provider: 'openai-compatible' } });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(await db.aiModelPrice.count({ where: { provider: 'openai-compatible' } })).toBe(0);
  });

  it('rejects a non-integer amount string', async () => {
    const res = await gql(SET_PRICE, platformCtx(), {
      input: { ...priceInput, inputMicroCentsPerMTok: '3.5e7' },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('defaults tier to 1 and round-trips tier + markupBasisPoints', async () => {
    const dflt = await gql(SET_PRICE, platformCtx(), { input: priceInput });
    expect(dflt.errors).toBeUndefined();
    const dfltRow = (dflt.data as Record<string, Record<string, unknown>>).setAiModelPrice;
    expect(dfltRow.tier).toBe(1);
    expect(dfltRow.markupBasisPoints).toBeNull();
    const t2 = await gql(SET_PRICE, platformCtx(), {
      input: { ...priceInput, tier: 2, markupBasisPoints: 5000 },
    });
    expect(t2.errors).toBeUndefined();
    const t2Row = (t2.data as Record<string, Record<string, unknown>>).setAiModelPrice;
    expect(t2Row.tier).toBe(2);
    expect(t2Row.markupBasisPoints).toBe(5000);
  });

  it('rejects an out-of-range tier and a negative markup', async () => {
    const badTier = await gql(SET_PRICE, platformCtx(), { input: { ...priceInput, tier: 4 } });
    expect(badTier.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const badMarkup = await gql(SET_PRICE, platformCtx(), {
      input: { ...priceInput, markupBasisPoints: -100 },
    });
    expect(badMarkup.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});

describe('aiModelPrices read', () => {
  it('any authenticated principal can read; anonymous cannot', async () => {
    await gql(SET_PRICE, platformCtx(), { input: priceInput });
    const asStranger = await gql(PRICES, strangerCtx());
    expect(asStranger.errors).toBeUndefined();
    expect((asStranger.data as { aiModelPrices: { total: number } }).aiModelPrices.total).toBe(1);
    const asAnon = await gql(PRICES, anonCtx());
    expect(asAnon.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});

describe('grantCredits', () => {
  it('platform admin mints a grant', async () => {
    const res = await gql(GRANT, platformCtx(), {
      input: { orgRef: orgId, amountMicroCents: '500000', note: 'pilot goodwill' },
    });
    expect(res.errors).toBeUndefined();
    const row = (res.data as Record<string, Record<string, string>>).grantCredits;
    expect(row.kind).toBe('grant');
    expect(row.amountMicroCents).toBe('500000');
  });

  it('org admin cannot self-grant', async () => {
    const res = await gql(GRANT, orgAdminCtx(), {
      input: { orgRef: orgId, amountMicroCents: '500000' },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('rejects a zero amount', async () => {
    const res = await gql(GRANT, platformCtx(), {
      input: { orgRef: orgId, amountMicroCents: '0' },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('is idempotent on (sourceType, sourceId) through GraphQL', async () => {
    const input = {
      orgRef: orgId,
      amountMicroCents: '2000000000',
      sourceType: 'stripe-checkout',
      sourceId: 'cs_gql_1',
    };
    const first = await gql(GRANT, platformCtx(), { input });
    const replay = await gql(GRANT, platformCtx(), { input });
    expect(first.errors).toBeUndefined();
    expect(replay.errors).toBeUndefined();
    expect((replay.data as Record<string, Record<string, string>>).grantCredits.id).toBe(
      (first.data as Record<string, Record<string, string>>).grantCredits.id,
    );
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });

  it('rejects a sourceId without a sourceType (and vice versa)', async () => {
    const res = await gql(GRANT, platformCtx(), {
      input: { orgRef: orgId, amountMicroCents: '100', sourceId: 'cs_orphan' },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('surfaces a mismatched replay as IDEMPOTENCY_CONFLICT (non-retryable)', async () => {
    const input = {
      orgRef: orgId,
      amountMicroCents: '2000000000',
      sourceType: 'stripe-checkout',
      sourceId: 'cs_gql_conflict',
    };
    expect((await gql(GRANT, platformCtx(), { input })).errors).toBeUndefined();
    const conflict = await gql(GRANT, platformCtx(), {
      input: { ...input, amountMicroCents: '999' },
    });
    expect(conflict.errors?.[0]?.extensions?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });
});

describe('ledger reads', () => {
  beforeEach(async () => {
    await gql(GRANT, platformCtx(), { input: { orgRef: orgId, amountMicroCents: '500000' } });
    await db.creditLedgerEntry.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        kind: 'debit',
        amountMicroCents: -125_000n,
      },
    });
  });

  it('org admin reads balance and ledger (URN orgRef too)', async () => {
    const bal = await gql(BALANCE, orgAdminCtx(), { orgRef: 'mt-org' });
    expect(bal.errors).toBeUndefined();
    expect((bal.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents).toBe('375000');
    const ledger = await gql(LEDGER, orgAdminCtx(), { orgRef: orgId });
    expect(ledger.errors).toBeUndefined();
    expect((ledger.data as { creditLedgerEntries: { total: number } }).creditLedgerEntries.total).toBe(2);
  });

  it('platform admin reads any org; contributor and stranger are Forbidden', async () => {
    expect((await gql(BALANCE, platformCtx(), { orgRef: orgId })).errors).toBeUndefined();
    for (const ctx of [contributorCtx(), strangerCtx()]) {
      const res = await gql(BALANCE, ctx, { orgRef: orgId });
      expect(res.errors?.[0]?.message).toBe('Forbidden');
    }
  });
});
