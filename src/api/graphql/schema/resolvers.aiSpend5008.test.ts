/**
 * #5008 (Billing A2) — `aiSpend`: an organization ADMIN's spend summary for a date range and one grouping.
 * Plan: hrn:node:hadronmemory.com:hadron-server:design:subscription-billing-plan, section 7, slice A2.
 * Specs: cor:dmo:170:04 (cost and charge are separate figures; an unpriced unit is never a zero), :07 (consumed).
 *
 * Scope per the CHECKED gate: the APP, MODEL, KEY_OWNER and DAY groupings only. USER is excluded (open ruling R1).
 * Every row of a second organization carries the same shapes, so a missing org predicate shows as an extra row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildASTSchema, isObjectType, isEnumType, getNamedType, isScalarType, parse } from 'graphql';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { clearPriceCache, recordLlmUsage } from '../../../lib/metering/index.js';
import { aiSpendSummary, AI_SPEND_MAX_DAYS, AI_SPEND_MAX_ROWS } from '../../../lib/metering/spend.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

const SPEND = `query($orgRef: String!, $from: String!, $to: String!, $groupBy: AiSpendGroup!) {
  aiSpend(orgRef: $orgRef, from: $from, to: $to, groupBy: $groupBy) {
    from to truncated totalGroups
    rows { key events tokensIn tokensOut costMicroCents unpricedEvents chargedMicroCents }
  } }`;

type Row = { key: string; events: number; tokensIn: string; tokensOut: string; costMicroCents: string; unpricedEvents: number; chargedMicroCents: string };
type Summary = { from: string; to: string; truncated: boolean; totalGroups: number; rows: Row[] };

const FROM = '2026-03-01T00:00:00.000Z';
const TO = '2026-04-01T00:00:00.000Z';
const MID = new Date('2026-03-10T12:00:00.000Z');

let orgA: string;
let orgB: string;
let platformAdmin: string;
let adminA: string;
let contributorA: string;
let adminB: string;
let stranger: string;

const platformCtx = (): Partial<Context> => ({ userId: platformAdmin, roles: ['ADMIN'] });
const adminACtx = (): Partial<Context> => ({ userId: adminA, roles: ['READER'] });

async function spend(ctx: Partial<Context>, vars: Partial<{ orgRef: string; from: string; to: string; groupBy: string }> = {}) {
  return gql(SPEND, ctx, { orgRef: orgA, from: FROM, to: TO, groupBy: 'KEY_OWNER', ...vars });
}
const summaryOf = (res: Awaited<ReturnType<typeof gql>>): Summary => {
  expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
  return (res.data as { aiSpend: Summary }).aiSpend;
};
const rowOf = (s: Summary, key: string): Row => {
  const row = s.rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${JSON.stringify(key)} in ${JSON.stringify(s.rows.map((r) => r.key))}`);
  return row;
};

type EventOver = Partial<{
  organizationId: string | null; appId: string | null; userId: string | null; provider: string | null; model: string | null;
  tokensIn: number | null; tokensOut: number | null; keyOwnerType: string | null; costMicroCents: bigint | null;
  createdAt: Date; deletedAt: Date | null; type: string;
}>;
async function ev(over: EventOver = {}): Promise<string> {
  const row = await db.usageEvent.create({
    data: {
      type: 'app-run', organizationId: orgA, tokensIn: 10, tokensOut: 5, provider: 'anthropic', model: 'm1',
      keyOwnerType: 'HADRON_SERVER', costMicroCents: 100n, createdAt: MID, ...over,
    },
  });
  return row.id;
}
async function ledger(over: { organizationId?: string; kind?: string; amount: bigint; sourceType?: string | null; sourceId: string | null; deletedAt?: Date | null }) {
  await db.creditLedgerEntry.create({
    data: {
      organizationId: over.organizationId ?? orgA, kind: over.kind ?? 'debit', amountMicroCents: over.amount,
      sourceType: over.sourceType === undefined ? 'usage-event' : over.sourceType, sourceId: over.sourceId, deletedAt: over.deletedAt ?? null,
    },
  });
}
const debit = (eventId: string, amount: bigint, over: Partial<Parameters<typeof ledger>[0]> = {}) => ledger({ amount: -amount, sourceId: eventId, ...over });

/** The three-event fixture of the issue's first acceptance bullet, in one organization. */
async function threeEvents(org: string) {
  const platform = await ev({ organizationId: org, keyOwnerType: 'HADRON_SERVER', costMicroCents: 100n });
  await debit(platform, 125n, { organizationId: org });
  await ev({ organizationId: org, keyOwnerType: 'ORGANIZATION', costMicroCents: 40n });
  await ev({ organizationId: org, keyOwnerType: 'HADRON_SERVER', costMicroCents: null });
}

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  const mkUser = (n: number, name: string) => db.user.create({ data: { id: generateId(), githubId: 9100 + n, githubUsername: name } });
  platformAdmin = (await mkUser(1, 'as-platform')).id;
  adminA = (await mkUser(2, 'as-admin-a')).id;
  contributorA = (await mkUser(3, 'as-contrib-a')).id;
  adminB = (await mkUser(4, 'as-admin-b')).id;
  stranger = (await mkUser(5, 'as-stranger')).id;
  orgA = (await db.organization.create({ data: { id: generateId(), name: 'as-org-a', urn: 'as-org-a' } })).id;
  orgB = (await db.organization.create({ data: { id: generateId(), name: 'as-org-b', urn: 'as-org-b' } })).id;
  await db.orgMember.create({ data: { organizationId: orgA, userId: adminA, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgA, userId: contributorA, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: orgB, userId: adminB, role: 'ADMIN' } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('#5008 aiSpend — cost, charge and unpriced are separate figures (pin 1)', () => {
  it('a platform-key unit with a debit, an own-key unit and an unpriced unit come back as three separate numbers', async () => {
    await threeEvents(orgA);
    const s = summaryOf(await spend(adminACtx()));
    expect(s.rows).toHaveLength(2);
    const platform = rowOf(s, 'HADRON_SERVER');
    expect(platform).toMatchObject({ events: 2, costMicroCents: '100', chargedMicroCents: '125', unpricedEvents: 1, tokensIn: '20', tokensOut: '10' });
    const own = rowOf(s, 'ORGANIZATION');
    expect(own).toMatchObject({ events: 1, costMicroCents: '40', chargedMicroCents: '0', unpricedEvents: 0 });
    expect(s.truncated).toBe(false);
    expect(s.totalGroups).toBe(2);
  });

  it('echoes the normalized range as ISO strings', async () => {
    await threeEvents(orgA);
    const s = summaryOf(await spend(adminACtx(), { from: '2026-03-01', to: '2026-04-01' }));
    expect(s.from).toBe(FROM);
    expect(s.to).toBe(TO);
  });
});

describe('#5008 aiSpend — another organization is never visible (pin 2)', () => {
  it('org B holds the same three events with the same keys: org A figures are unchanged', async () => {
    await threeEvents(orgA);
    const before = summaryOf(await spend(adminACtx()));
    await threeEvents(orgB);
    const after = summaryOf(await spend(adminACtx()));
    expect(after).toEqual(before);
    // and B's own call sees only B's figures, not A's
    const b = summaryOf(await spend({ userId: adminB, roles: ['READER'] }, { orgRef: orgB }));
    expect(b.rows.map((r) => [r.key, r.events])).toEqual(before.rows.map((r) => [r.key, r.events]));
  });
});

describe('#5008 aiSpend — who may call (pin 3)', () => {
  const refused = async (ctx: Partial<Context>) => {
    await threeEvents(orgA);
    const res = await spend(ctx);
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(res.data).toBeNull();
  };
  it('an org CONTRIBUTOR is refused', () => refused({ userId: contributorA, roles: ['READER'] }));
  it('a stranger is refused', () => refused({ userId: stranger, roles: ['READER'] }));
  it('an admin of another organization is refused', () => refused({ userId: adminB, roles: ['READER'] }));
  it('an App key (no userId) is refused', () => refused({ roles: [] }));
  it('an impersonated session confined to another organization is refused', () =>
    refused({
      userId: adminA, roles: ['READER'],
      impersonation: { orgId: orgB, sessionId: generateId(), actorUserId: platformAdmin, expiresAt: new Date(Date.now() + 60_000) },
    } as Partial<Context>));
  it('a revoked org ADMIN is refused', async () => {
    await db.orgMember.updateMany({ where: { organizationId: orgA, userId: adminA }, data: { deletedAt: new Date() } });
    await refused(adminACtx());
  });
  it('the org ADMIN and a platform admin succeed', async () => {
    await threeEvents(orgA);
    expect(summaryOf(await spend(adminACtx())).rows).toHaveLength(2);
    expect(summaryOf(await spend(platformCtx())).rows).toHaveLength(2);
  });
});

describe('#5008 aiSpend — input checks (pin 4)', () => {
  const bad = async (vars: Partial<{ from: string; to: string }>) => {
    const res = await spend(adminACtx(), vars);
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  };
  it('an unparseable date is refused', () => bad({ from: 'not a date' }));
  it('a non-ISO date a lenient parser would take is refused (the year alone, a long-form date)', async () => {
    await bad({ from: '2026' });
    await bad({ from: '1 March 2026' });
    await bad({ to: 'March 31, 2026' });
  });
  it('from equal to to is refused', () => bad({ from: FROM, to: FROM }));
  it('from after to is refused', () => bad({ from: TO, to: FROM }));
  it('a span of 367 days is refused and 366 days is accepted', async () => {
    await bad({ from: '2026-01-01T00:00:00Z', to: '2027-01-03T00:00:00Z' });
    const ok = await spend(adminACtx(), { from: '2026-01-01T00:00:00Z', to: '2027-01-02T00:00:00Z' });
    expect(ok.errors).toBeUndefined();
    expect(AI_SPEND_MAX_DAYS).toBe(366);
  });
  it('an offset-less date-time is read as UTC and a date alone is midnight UTC', async () => {
    await ev({ createdAt: new Date('2026-03-05T23:30:00.000Z') });
    const s = summaryOf(await spend(adminACtx(), { from: '2026-03-05T23:00:00', to: '2026-03-06' }));
    expect(s.rows.map((r) => r.events)).toEqual([1]);
    expect(s.from).toBe('2026-03-05T23:00:00.000Z');
    expect(s.to).toBe('2026-03-06T00:00:00.000Z');
  });
  it('a refused range is refused before any figure is read (the gate answers first for a non-admin)', async () => {
    const res = await spend({ userId: contributorA, roles: ['READER'] }, { from: 'not a date' });
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});

describe('#5008 aiSpend — what is left out (pins 5, 6, 11 and the ledger rulings)', () => {
  it('a soft-deleted usage event is left out of every figure, with its debit', async () => {
    const live = await ev({ costMicroCents: 100n });
    await debit(live, 120n);
    const gone = await ev({ costMicroCents: 900n, deletedAt: new Date() });
    await debit(gone, 999n);
    const s = summaryOf(await spend(adminACtx()));
    expect(rowOf(s, 'HADRON_SERVER')).toMatchObject({ events: 1, costMicroCents: '100', chargedMicroCents: '120' });
  });

  it('an event with no tokens (a read count) is not counted', async () => {
    await ev({ type: 'read', tokensIn: null, tokensOut: null, costMicroCents: 500n });
    await ev({ costMicroCents: 100n });
    const s = summaryOf(await spend(adminACtx()));
    expect(rowOf(s, 'HADRON_SERVER')).toMatchObject({ events: 1, costMicroCents: '100' });
  });

  it('an event with only one of the two token counts is counted', async () => {
    await ev({ tokensIn: null, tokensOut: 7 });
    await ev({ tokensIn: 3, tokensOut: null });
    const s = summaryOf(await spend(adminACtx()));
    expect(rowOf(s, 'HADRON_SERVER')).toMatchObject({ events: 2, tokensIn: '3', tokensOut: '7' });
  });

  it('a grant and a refund adjustment that name a usage event are not charged', async () => {
    const own = await ev({ keyOwnerType: 'ORGANIZATION', costMicroCents: 40n });
    await ledger({ kind: 'grant', amount: 500n, sourceId: own });
    await ledger({ kind: 'adjustment', amount: 77n, sourceType: 'refund', sourceId: own });
    const s = summaryOf(await spend(adminACtx()));
    expect(rowOf(s, 'ORGANIZATION')).toMatchObject({ costMicroCents: '40', chargedMicroCents: '0' });
  });

  it('a soft-deleted debit is not charged (the balance leaves it out too)', async () => {
    const id = await ev();
    await debit(id, 125n, { deletedAt: new Date() });
    expect(rowOf(summaryOf(await spend(adminACtx())), 'HADRON_SERVER').chargedMicroCents).toBe('0');
  });

  it("another organization's ledger row naming this organization's event is not charged", async () => {
    const id = await ev();
    await debit(id, 125n, { organizationId: orgB });
    expect(rowOf(summaryOf(await spend(adminACtx())), 'HADRON_SERVER').chargedMicroCents).toBe('0');
  });
});

describe('#5008 aiSpend — the range is [from, to) (pin 7)', () => {
  it('an event at exactly from is counted and one at exactly to is not', async () => {
    await ev({ createdAt: new Date(FROM), costMicroCents: 1n });
    await ev({ createdAt: new Date(TO), costMicroCents: 1000n });
    await ev({ createdAt: new Date(new Date(FROM).getTime() - 1), costMicroCents: 1000n });
    const s = summaryOf(await spend(adminACtx()));
    expect(rowOf(s, 'HADRON_SERVER')).toMatchObject({ events: 1, costMicroCents: '1' });
  });
});

describe('#5008 aiSpend — bounds (pin 8)', () => {
  it('more than 500 groups: 500 rows, truncated, the exact total, largest charge first, the smallest absent', async () => {
    const total = AI_SPEND_MAX_ROWS + 1;
    for (let i = 0; i < total; i++) {
      const id = await ev({ model: `model-${String(i).padStart(3, '0')}`, costMicroCents: 10n });
      await debit(id, BigInt(i + 1));
    }
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'MODEL' }));
    expect(s.rows).toHaveLength(AI_SPEND_MAX_ROWS);
    expect(s.truncated).toBe(true);
    expect(s.totalGroups).toBe(total);
    expect(s.rows[0]!.chargedMicroCents).toBe(String(total));
    expect(s.rows.some((r) => r.key === 'anthropic/model-000')).toBe(false);
    const charged = s.rows.map((r) => BigInt(r.chargedMicroCents));
    expect(charged).toEqual([...charged].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  }, 120_000);

  it('exactly 500 groups is not truncated', async () => {
    for (let i = 0; i < AI_SPEND_MAX_ROWS; i++) await ev({ model: `model-${i}` });
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'MODEL' }));
    expect(s.rows).toHaveLength(AI_SPEND_MAX_ROWS);
    expect(s.truncated).toBe(false);
    expect(s.totalGroups).toBe(AI_SPEND_MAX_ROWS);
  }, 120_000);

  it('equal charges are ordered by cost, then events, then key: a total order, so truncation is stable', async () => {
    const mk = (model: string, cost: bigint, n: number) =>
      Promise.all(Array.from({ length: n }, () => ev({ model, costMicroCents: cost })));
    await mk('b', 10n, 1);
    await mk('a', 10n, 1);
    await mk('c', 20n, 1);
    await mk('d', 10n, 2);
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'MODEL' }));
    // charged is 0 everywhere; cost desc (d=20, c=20, then 10s), events desc (d=2 first), key asc
    expect(s.rows.map((r) => r.key)).toEqual(['anthropic/d', 'anthropic/c', 'anthropic/a', 'anthropic/b']);
  });
});

describe('#5008 aiSpend — each grouping (pin 9)', () => {
  it('DAY is the UTC date of created_at', async () => {
    await ev({ createdAt: new Date('2026-03-05T23:30:00.000Z') });
    await ev({ createdAt: new Date('2026-03-06T00:30:00.000Z') });
    await ev({ createdAt: new Date('2026-03-06T10:00:00.000Z') });
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'DAY' }));
    expect(rowOf(s, '2026-03-05').events).toBe(1);
    expect(rowOf(s, '2026-03-06').events).toBe(2);
  });

  it('APP is the app id only, and a null app is the row with the empty key', async () => {
    const app = (await db.app.create({ data: { name: 'spend-app', urn: 'as-org-a:spend-app', organizationId: orgA } })).id;
    await ev({ appId: app });
    await ev({ appId: null });
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'APP' }));
    expect(rowOf(s, app).events).toBe(1);
    expect(rowOf(s, '').events).toBe(1);
  });

  it('MODEL is provider/model; a half-null key keeps the other half; both null is the empty key', async () => {
    await ev({ provider: 'anthropic', model: 'm1' });
    await ev({ provider: null, model: 'only-model' });
    await ev({ provider: 'only-provider', model: null });
    await ev({ provider: null, model: null });
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'MODEL' }));
    expect(s.rows.map((r) => r.key).sort()).toEqual(['', '/only-model', 'anthropic/m1', 'only-provider/']);
  });

  it('KEY_OWNER is the key owner type; a null owner is the empty key', async () => {
    await ev({ keyOwnerType: 'APP' });
    await ev({ keyOwnerType: null });
    const s = summaryOf(await spend(adminACtx(), { groupBy: 'KEY_OWNER' }));
    expect(s.rows.map((r) => r.key).sort()).toEqual(['', 'APP']);
  });

  it('the USER grouping is not offered (open ruling R1): the enum has exactly four values', async () => {
    const res = await spend(adminACtx(), { groupBy: 'USER' });
    expect(res.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    const schema = buildASTSchema(parse(typeDefs as unknown as string));
    const enumType = schema.getType('AiSpendGroup');
    expect(isEnumType(enumType) && enumType.getValues().map((v) => v.name).sort()).toEqual(['APP', 'DAY', 'KEY_OWNER', 'MODEL']);
  });
});

describe('#5008 aiSpend — ids only, scalars only (pin 10)', () => {
  it('every field of AiSpendRow and AiSpendSummary is a scalar or a list of AiSpendRow: no App or User is reachable', () => {
    const schema = buildASTSchema(parse(typeDefs as unknown as string));
    const row = schema.getType('AiSpendRow');
    const summary = schema.getType('AiSpendSummary');
    expect(isObjectType(row) && isObjectType(summary)).toBe(true);
    for (const f of Object.values((row as never as { getFields(): Record<string, { type: never }> }).getFields())) {
      expect(isScalarType(getNamedType(f.type)), 'AiSpendRow field').toBe(true);
    }
    for (const [name, f] of Object.entries((summary as never as { getFields(): Record<string, { type: never }> }).getFields())) {
      const named = getNamedType(f.type);
      expect(isScalarType(named) || named.name === 'AiSpendRow', `AiSpendSummary.${name}`).toBe(true);
    }
    const field = (schema.getQueryType()!.getFields() as Record<string, { type: never }>).aiSpend!;
    expect(getNamedType(field.type).name).toBe('AiSpendSummary');
  });
});

describe('#5008 aiSpend — a real debit through the write path (pin 12)', () => {
  it('recordLlmUsage on the platform key with debits on shows its cost and the marked-up charge', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await db.aiModelPrice.create({
      data: {
        provider: 'anthropic', model: 'claude-spend', tier: 1, inputMicroCentsPerMTok: 30_000_000n, outputMicroCentsPerMTok: 150_000_000n,
        markupBasisPoints: 2500, effectiveAt: new Date('2026-01-01T00:00:00Z'), createdBy: platformAdmin,
      },
    });
    clearPriceCache();
    const rec = await recordLlmUsage(db, {
      type: 'app-run', organizationId: orgA, provider: 'anthropic', model: 'claude-spend', tokensIn: 1000, tokensOut: 1000, keyOwnerType: 'HADRON_SERVER',
    });
    expect(rec).not.toBeNull();
    const debitRow = await db.creditLedgerEntry.findFirstOrThrow({ where: { sourceType: 'usage-event', sourceId: rec!.id } });
    // an explicit future `to`: the event is stamped "now" and `to` is exclusive (the same-millisecond finding)
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const row = rowOf(summaryOf(await spend(adminACtx(), { from, to })), 'HADRON_SERVER');
    expect(row.events).toBe(1);
    expect(row.costMicroCents).toBe(String(rec!.costMicroCents));
    expect(row.chargedMicroCents).toBe((-debitRow.amountMicroCents).toString());
    expect(BigInt(row.chargedMicroCents) > BigInt(row.costMicroCents)).toBe(true);
  });
});

describe('#5008 aiSpend — naive-UTC binding under a non-UTC session (pin 13)', () => {
  it('the boundary rows and the DAY key still hold with the session zone at America/Los_Angeles', async () => {
    await ev({ createdAt: new Date(FROM), costMicroCents: 1n });
    await ev({ createdAt: new Date(TO), costMicroCents: 1000n });
    await ev({ createdAt: new Date('2026-03-05T23:30:00.000Z'), costMicroCents: 2n });
    const run = (groupBy: 'KEY_OWNER' | 'DAY') =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Los_Angeles'`;
        return aiSpendSummary(tx, { organizationId: orgA, from: new Date(FROM), to: new Date(TO), groupBy });
      });
    const byOwner = await run('KEY_OWNER');
    expect(byOwner.rows[0]).toMatchObject({ events: 2, costMicroCents: '3' });
    const byDay = await run('DAY');
    expect(byDay.rows.map((r) => r.key).sort()).toEqual(['2026-03-01', '2026-03-05']);
  });
});
