/**
 * #5021 (billing A16, hrn:node:hadronmemory.com:specs:cor:dmo:170:06): setAiModelPrice refuses a price row that would
 * take effect before every server process can see it. A row dated earlier than now plus one price-cache lifetime is
 * BAD_USER_INPUT and writes nothing; an omitted effectiveAt becomes now plus that lifetime; the text is read by the
 * strict ISO rule (gate ruling 7, the rule #5008 adopted). All red on main except pin 4d (a guard: a later date is
 * accepted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { clearPriceCache } from '../../../lib/metering/index.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}
const SET_PRICE = `mutation($input: SetAiModelPriceInput!) { setAiModelPrice(input: $input) { id effectiveAt } }`;
const priceInput = { provider: 'anthropic', model: 'claude-lead', inputMicroCentsPerMTok: '30000000', outputMicroCentsPerMTok: '150000000' };
const LEAD_MS = 60_000;

let admin: string;
const adminCtx = (): Partial<Context> => ({ userId: admin, roles: ['ADMIN'] });
const NOW = new Date('2026-11-25T12:00:00.000Z');

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  admin = (await db.user.create({ data: { id: generateId(), githubId: 50221, githubUsername: 'lead-admin', roles: ['ADMIN'] } })).id;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

async function refused(effectiveAt: string) {
  const res = await gql(SET_PRICE, adminCtx(), { input: { ...priceInput, effectiveAt } });
  return { code: res.errors?.[0]?.extensions?.code, message: res.errors?.[0]?.message ?? '', rows: await db.aiModelPrice.count() };
}

describe('#5021 setAiModelPrice: the minimum lead', () => {
  it('pin 4a: yesterday is BAD_USER_INPUT and writes nothing', async () => {
    const r = await refused(new Date(NOW.getTime() - 86_400_000).toISOString());
    expect([r.code, r.rows]).toEqual(['BAD_USER_INPUT', 0]);
    expect(r.message).toMatch(/60 seconds/);
  });

  it('pin 4b: now is BAD_USER_INPUT and writes nothing', async () => {
    const r = await refused(NOW.toISOString());
    expect([r.code, r.rows]).toEqual(['BAD_USER_INPUT', 0]);
  });

  it('pin 4c: now + 30 s (less than one cache lifetime) is BAD_USER_INPUT and writes nothing', async () => {
    const r = await refused(new Date(NOW.getTime() + 30_000).toISOString());
    expect([r.code, r.rows]).toEqual(['BAD_USER_INPUT', 0]);
  });

  it('pin 4d (guard): now + 5 min is accepted and stored as given', async () => {
    const at = new Date(NOW.getTime() + 300_000).toISOString();
    const res = await gql(SET_PRICE, adminCtx(), { input: { ...priceInput, effectiveAt: at } });
    expect(res.errors).toBeUndefined();
    expect((res.data as { setAiModelPrice: { effectiveAt: string } }).setAiModelPrice.effectiveAt).toBe(at);
  });

  it('pin 4e: exactly now + one cache lifetime is accepted (the boundary is inclusive)', async () => {
    const at = new Date(NOW.getTime() + LEAD_MS).toISOString();
    const res = await gql(SET_PRICE, adminCtx(), { input: { ...priceInput, effectiveAt: at } });
    expect(res.errors).toBeUndefined();
  });

  it('pin 5: an omitted effectiveAt becomes now + one cache lifetime', async () => {
    const res = await gql(SET_PRICE, adminCtx(), { input: priceInput });
    expect(res.errors).toBeUndefined();
    const at = new Date((res.data as { setAiModelPrice: { effectiveAt: string } }).setAiModelPrice.effectiveAt).getTime();
    expect(at).toBe(NOW.getTime() + LEAD_MS);
  });
});

describe('#5021 setAiModelPrice: strict ISO effectiveAt (gate ruling 7)', () => {
  it.each(['1 December 2026', '2026', '2026-02-31T00:00:00Z', 'Tue Dec 01 2026 00:00:00 GMT+0000'])(
    'pin 4f: %s is BAD_USER_INPUT and writes nothing',
    async (text) => {
      const r = await refused(text);
      expect([r.code, r.rows]).toEqual(['BAD_USER_INPUT', 0]);
    },
  );
});
