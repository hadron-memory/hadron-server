/**
 * hadron-server#5007 (Billing A1): ledger adjustments (`adjustCredits`), and
 * every entry names its source.
 *
 * Specs: hrn:node:hadronmemory.com:specs:cor:dmo:170:03 (a credit ledger entry:
 * an adjustment of either sign; each entry names its source; the same source
 * again returns the existing entry, a different amount or account is refused)
 * and hrn:node:hadronmemory.com:specs:cor:dmo:170:08 (a correction is a new
 * entry, never an edit). Gate rulings (issue #5007, CHECKED): the source pair is
 * required in the library and the mutation; a blank value counts as missing;
 * the source types the server writes itself are refused at the mutation,
 * trimmed and case-insensitively; one fixed conflict sentence; `expiresAt` is
 * not compared on a replay (A4).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { parse, type InputObjectTypeDefinitionNode, print } from 'graphql';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import * as metering from '../../../lib/metering/index.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation(
    { query, variables },
    { contextValue: { db, ...ctx } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

const FIXED_CONFLICT =
  'This source is already recorded on the ledger with a different account, amount or kind.';
const SERVER_WRITTEN = ['usage-event', 'grant-expiry', 'period-grant', 'cost-correction'];

let platformAdmin: string, orgAdmin: string;
let orgId: string, otherOrgId: string;

const platformCtx = (): Partial<Context> => ({ userId: platformAdmin, roles: ['ADMIN'] });
const orgAdminCtx = (): Partial<Context> => ({ userId: orgAdmin, roles: ['READER'] });

const GRANT = `mutation($input: GrantCreditsInput!) { grantCredits(input: $input) {
  id kind amountMicroCents organizationId sourceType sourceId note } }`;
const ADJUST = `mutation($input: AdjustCreditsInput!) { adjustCredits(input: $input) {
  id kind amountMicroCents organizationId sourceType sourceId note } }`;
const BALANCE = `query($orgRef: String!) { creditBalance(orgRef: $orgRef) { balanceMicroCents } }`;

type Entry = { id: string; kind: string; amountMicroCents: string; organizationId: string };
const adjusted = (res: Awaited<ReturnType<typeof gql>>) =>
  (res.data as { adjustCredits: Entry } | null)?.adjustCredits;
const granted = (res: Awaited<ReturnType<typeof gql>>) =>
  (res.data as { grantCredits: Entry } | null)?.grantCredits;

const adjustInput = (over: Record<string, unknown> = {}) => ({
  orgRef: orgId,
  amountMicroCents: '-300',
  sourceType: 'refund',
  sourceId: 'r1',
  note: 'partial refund',
  ...over,
});
const grantInput = (over: Record<string, unknown> = {}) => ({
  orgRef: orgId,
  amountMicroCents: '1000',
  sourceType: 'stripe-checkout',
  sourceId: 'cs_1',
  ...over,
});

async function balance(): Promise<string> {
  const res = await gql(BALANCE, platformCtx(), { orgRef: orgId });
  expect(res.errors).toBeUndefined();
  return (res.data as { creditBalance: { balanceMicroCents: string } }).creditBalance
    .balanceMicroCents;
}

/** The fixed sentence, and nothing about the stored row or the caller's values. */
function expectFixedConflict(res: Awaited<ReturnType<typeof gql>>, leak: string[]) {
  expect(res.errors?.[0]?.extensions?.code).toBe('IDEMPOTENCY_CONFLICT');
  const message = res.errors?.[0]?.message ?? '';
  expect(message).toBe(FIXED_CONFLICT);
  for (const s of leak) expect(message).not.toContain(s);
}

beforeEach(async () => {
  await cleanDb(db);
  const mkUser = (n: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 75_000 + n, githubUsername: name } });
  platformAdmin = (await mkUser(1, 'adj-platform')).id;
  orgAdmin = (await mkUser(2, 'adj-orgadmin')).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'adj-org', urn: 'adj-org' } })).id;
  otherOrgId = (
    await db.organization.create({ data: { id: generateId(), name: 'adj-org-b', urn: 'adj-org-b' } })
  ).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
});

describe('adjustCredits (#5007)', () => {
  it('pin 1: a negative adjustment lowers creditBalance by its amount, as a new adjustment entry', async () => {
    expect((await gql(GRANT, platformCtx(), { input: grantInput() })).errors).toBeUndefined();
    const res = await gql(ADJUST, platformCtx(), { input: adjustInput() });
    expect(res.errors).toBeUndefined();
    expect(adjusted(res)?.kind).toBe('adjustment');
    expect(adjusted(res)?.amountMicroCents).toBe('-300');
    expect(await balance()).toBe('700');
    // :08 — the grant is untouched; the correction is a second row.
    expect(await db.creditLedgerEntry.count()).toBe(2);
  });

  it('a positive adjustment raises the balance', async () => {
    const res = await gql(ADJUST, platformCtx(), { input: adjustInput({ amountMicroCents: '250' }) });
    expect(res.errors).toBeUndefined();
    expect(await balance()).toBe('250');
  });

  it('pin 2: a replay of the same source, org, amount and kind returns the same entry', async () => {
    const first = await gql(ADJUST, platformCtx(), { input: adjustInput() });
    const replay = await gql(ADJUST, platformCtx(), { input: adjustInput() });
    expect(first.errors).toBeUndefined();
    expect(replay.errors).toBeUndefined();
    expect(adjusted(replay)?.id).toBe(adjusted(first)?.id);
    expect(await db.creditLedgerEntry.count({ where: { kind: 'adjustment' } })).toBe(1);
    expect(await balance()).toBe('-300');
  });

  it('pin 3 + 6: the same source with another amount is IDEMPOTENCY_CONFLICT with the fixed sentence', async () => {
    const first = await gql(ADJUST, platformCtx(), { input: adjustInput() });
    const id = adjusted(first)!.id;
    const res = await gql(ADJUST, platformCtx(), { input: adjustInput({ amountMicroCents: '-200' }) });
    expectFixedConflict(res, [id, orgId, '300', '200']);
    expect(await db.creditLedgerEntry.count()).toBe(1);
    expect(await balance()).toBe('-300');
  });

  it('org compare: the same source on another organization is a conflict', async () => {
    const first = await gql(ADJUST, platformCtx(), { input: adjustInput() });
    expect(first.errors).toBeUndefined();
    const res = await gql(ADJUST, platformCtx(), { input: adjustInput({ orgRef: otherOrgId }) });
    expectFixedConflict(res, [adjusted(first)!.id, orgId, otherOrgId, '300']);
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });

  it('pin 4 + 6: an adjustment reusing a grant\'s source (same org and amount) is a conflict, not the grant', async () => {
    const g = await gql(GRANT, platformCtx(), {
      input: grantInput({ amountMicroCents: '500', sourceId: 'cs1' }),
    });
    expect(g.errors).toBeUndefined();
    const res = await gql(ADJUST, platformCtx(), {
      input: adjustInput({ amountMicroCents: '500', sourceType: 'stripe-checkout', sourceId: 'cs1' }),
    });
    expectFixedConflict(res, [granted(g)!.id, orgId, '500']);
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });

  it('pin 7: a zero, signed-zero, fractional, plus-signed or out-of-int8 amount is BAD_USER_INPUT', async () => {
    for (const amountMicroCents of [
      '0',
      '-0',
      '1.5',
      '+5',
      '',
      '9223372036854775808',
      '-9223372036854775809',
    ]) {
      const res = await gql(ADJUST, platformCtx(), {
        input: adjustInput({ amountMicroCents, sourceId: `r-${amountMicroCents}` }),
      });
      expect(res.errors?.[0]?.extensions?.code, amountMicroCents).toBe('BAD_USER_INPUT');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('int8 bounds themselves are accepted', async () => {
    const lo = await gql(ADJUST, platformCtx(), {
      input: adjustInput({ amountMicroCents: '-9223372036854775808', sourceId: 'lo' }),
    });
    expect(lo.errors).toBeUndefined();
    expect(adjusted(lo)?.amountMicroCents).toBe('-9223372036854775808');
  });

  it('pin 8: a blank note, sourceType or sourceId is BAD_USER_INPUT and writes nothing', async () => {
    for (const over of [
      { note: '' },
      { note: '   ' },
      { sourceType: '' },
      { sourceType: ' \t ' },
      { sourceId: '' },
      { sourceId: '  ' },
    ]) {
      const res = await gql(ADJUST, platformCtx(), { input: adjustInput(over) });
      expect(res.errors?.[0]?.extensions?.code, JSON.stringify(over)).toBe('BAD_USER_INPUT');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('pin 11: an org ADMIN, an impersonated session and an App key are FORBIDDEN', async () => {
    const impersonated: Partial<Context> = {
      userId: orgAdmin,
      roles: [],
      impersonation: {
        sessionId: generateId(),
        actorUserId: platformAdmin,
        orgId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const appKey: Partial<Context> = { appId: generateId(), appKeyId: generateId(), roles: [] };
    for (const ctx of [orgAdminCtx(), impersonated, appKey, { roles: [] }]) {
      const res = await gql(ADJUST, ctx, { input: adjustInput() });
      expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('a forbidden caller gets the same refusal for an organization that does not exist', async () => {
    const res = await gql(ADJUST, orgAdminCtx(), { input: adjustInput({ orgRef: 'no-such-org' }) });
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(res.errors?.[0]?.message).toBe('Forbidden');
  });
});

describe('grantCredits under the A1 rules (#5007)', () => {
  it('pin 9: a grant with no source pair is BAD_USER_INPUT and writes nothing', async () => {
    for (const over of [
      { sourceType: undefined, sourceId: undefined },
      { sourceType: null, sourceId: null },
      { sourceType: '', sourceId: '' },
      { sourceType: '  ', sourceId: 'cs_x' },
      { sourceType: 'stripe-checkout', sourceId: ' ' },
    ]) {
      const res = await gql(GRANT, platformCtx(), { input: grantInput(over) });
      expect(res.errors?.[0]?.extensions?.code, JSON.stringify(over)).toBe('BAD_USER_INPUT');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('pin 6: a grant amount conflict answers the fixed sentence', async () => {
    const first = await gql(GRANT, platformCtx(), { input: grantInput() });
    expect(first.errors).toBeUndefined();
    const res = await gql(GRANT, platformCtx(), { input: grantInput({ amountMicroCents: '999' }) });
    expectFixedConflict(res, [granted(first)!.id, orgId, '1000', '999']);
  });

  it('pin 13: an out-of-int8 grant amount is BAD_USER_INPUT, not an internal error', async () => {
    const res = await gql(GRANT, platformCtx(), {
      input: grantInput({ amountMicroCents: '9223372036854775808' }),
    });
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('a stored source pair is kept as given (not trimmed or lower-cased)', async () => {
    const res = await gql(GRANT, platformCtx(), {
      input: grantInput({ sourceType: 'Stripe-Checkout', sourceId: ' cs_Mixed ' }),
    });
    expect(res.errors).toBeUndefined();
    const row = await db.creditLedgerEntry.findFirstOrThrow();
    expect([row.sourceType, row.sourceId]).toEqual(['Stripe-Checkout', ' cs_Mixed ']);
  });
});

describe('the source types the server writes itself (#5007 ruling 3)', () => {
  it('pin 10: each is refused on both mutations, trimmed and case-insensitively, before any write', async () => {
    const spellings = SERVER_WRITTEN.flatMap((t) => [t, ` ${t.toUpperCase()} `]);
    for (const sourceType of spellings) {
      const a = await gql(ADJUST, platformCtx(), { input: adjustInput({ sourceType }) });
      expect(a.errors?.[0]?.extensions?.code, `adjust ${sourceType}`).toBe('BAD_USER_INPUT');
      const g = await gql(GRANT, platformCtx(), { input: grantInput({ sourceType }) });
      expect(g.errors?.[0]?.extensions?.code, `grant ${sourceType}`).toBe('BAD_USER_INPUT');
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('the exported list is exactly the four the plan names', () => {
    expect([...metering.SERVER_WRITTEN_SOURCE_TYPES].sort()).toEqual([...SERVER_WRITTEN].sort());
  });

  it('the library itself does not refuse them (A4 and A15 write their own types)', async () => {
    const row = await metering.adjustCredits(db, {
      organizationId: orgId,
      amountMicroCents: -10n,
      sourceType: 'cost-correction',
      sourceId: 'ue_1',
      note: 'cost correction',
    });
    expect(row.kind).toBe('adjustment');
  });
});

describe('library replay rules (#5007)', () => {
  it('pin 5: a grant reusing an adjustment\'s source (same org and amount) is IdempotencyConflictError', async () => {
    await metering.adjustCredits(db, {
      organizationId: orgId,
      amountMicroCents: 500n,
      sourceType: 'refund',
      sourceId: 'x',
      note: 'n',
    });
    const err = await metering
      .grantCredits(db, {
        organizationId: orgId,
        amountMicroCents: 500n,
        sourceType: 'refund',
        sourceId: 'x',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(metering.IdempotencyConflictError);
    expect((err as Error).message).toBe(FIXED_CONFLICT);
    expect(await db.creditLedgerEntry.count()).toBe(1);
  });

  it('the library refuses a grant or an adjustment with a missing or blank source, and an adjustment with no note or zero', async () => {
    const bad: Array<() => Promise<unknown>> = [
      () =>
        metering.grantCredits(db, {
          organizationId: orgId,
          amountMicroCents: 1n,
        } as metering.GrantCreditsParams),
      () =>
        metering.grantCredits(db, {
          organizationId: orgId,
          amountMicroCents: 1n,
          sourceType: ' ',
          sourceId: 'a',
        }),
      () =>
        metering.adjustCredits(db, {
          organizationId: orgId,
          amountMicroCents: 1n,
          sourceType: 'refund',
          sourceId: ' ',
          note: 'n',
        }),
      () =>
        metering.adjustCredits(db, {
          organizationId: orgId,
          amountMicroCents: 1n,
          sourceType: 'refund',
          sourceId: 'a',
          note: '  ',
        }),
      () =>
        metering.adjustCredits(db, {
          organizationId: orgId,
          amountMicroCents: 0n,
          sourceType: 'refund',
          sourceId: 'a',
          note: 'n',
        }),
    ];
    for (const call of bad) {
      await expect(call()).rejects.toBeInstanceOf(metering.InvalidLedgerAmountError);
    }
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});

describe('GrantCreditsInput keeps its shape (#5007, a guard pin)', () => {
  it('pin 12: field names, types and nullability are unchanged', () => {
    const doc = parse(typeDefs);
    const input = doc.definitions.find(
      (d): d is InputObjectTypeDefinitionNode =>
        d.kind === 'InputObjectTypeDefinition' && d.name.value === 'GrantCreditsInput',
    );
    const fields = input?.fields?.map((f) => `${f.name.value}: ${print(f.type)}`);
    expect(fields).toEqual([
      'orgRef: String!',
      'amountMicroCents: String!',
      'expiresAt: String',
      'sourceType: String',
      'sourceId: String',
      'note: String',
    ]);
  });
});
