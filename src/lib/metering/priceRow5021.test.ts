/**
 * #5021 (billing A16, hrn:node:hadronmemory.com:specs:cor:dmo:170:06): a unit records the price row that priced it, the
 * markup applied to its charge and its run; the price lookup switches to a new row at its effective instant in every
 * process; and price rows are kept: the database refuses every DELETE and every content UPDATE, and an audit user id
 * moves only along a recorded account merge. Pins 9 and 9b pass on main (guards for the merge exception); the rest are
 * red there.
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { testRunAgentId } from '../../test/runAgent.js';
import { generateId } from '../id.js';
import { clearPriceCache, getAiModelPrice, recordLlmUsage } from './index.js';

const IN_RATE = 30_000_000n;
const OUT_RATE = 150_000_000n;
const BASE = { type: 'app-run', provider: 'anthropic', model: 'claude-5021', tokensIn: 1000, tokensOut: 500 } as const;
// 1000 in @ $3/MTok + 500 out @ $15/MTok = 105_000 micro-cents.
const COST = 105_000n;

let pg: Client;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });

let orgId: string;
let userS: string;
let userT: string;
let admin: string;

async function mkPrice(effectiveAt: Date, extra: { inRate?: bigint; markupBasisPoints?: number | null; createdBy?: string | null; model?: string } = {}) {
  return db.aiModelPrice.create({
    data: {
      id: generateId(),
      provider: 'anthropic',
      model: extra.model ?? BASE.model,
      tier: 1,
      inputMicroCentsPerMTok: extra.inRate ?? IN_RATE,
      outputMicroCentsPerMTok: OUT_RATE,
      markupBasisPoints: extra.markupBasisPoints ?? null,
      effectiveAt,
      createdBy: extra.createdBy ?? null,
    },
  });
}
async function unitRow(id: string) {
  return (await pg.query('SELECT price_row_id, markup_basis_points, app_run_id, cost_micro_cents FROM usage_events WHERE id = $1', [id])).rows[0];
}

let lastMessage = '';
async function code(sql: string, params: unknown[] = []): Promise<string | null> {
  lastMessage = '';
  try { await pg.query(sql, params); return null; } catch (e) { lastMessage = (e as { message?: string }).message ?? ''; return (e as { code?: string }).code ?? 'unknown'; }
}

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'price-org', urn: `price-${generateId()}` } })).id;
  userS = (await db.user.create({ data: { id: generateId(), githubId: 50211, githubUsername: 'price-s' } })).id;
  userT = (await db.user.create({ data: { id: generateId(), githubId: 50212, githubUsername: 'price-t' } })).id;
  admin = (await db.user.create({ data: { id: generateId(), githubId: 50213, githubUsername: 'price-admin', roles: ['ADMIN'] } })).id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('#5021 a unit records its price row', () => {
  it('pin 1: a priced unit carries the id of the row in force', async () => {
    await mkPrice(new Date('2026-01-01T00:00:00Z'), { inRate: 1n });
    const inForce = await mkPrice(new Date('2026-02-01T00:00:00Z'));
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    expect(event).not.toBeNull();
    const row = await unitRow(event!.id);
    expect([row.price_row_id, row.cost_micro_cents]).toEqual([inForce.id, COST.toString()]);
  });

  it('pin 1b: an unpriced unit carries no price row', async () => {
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    const row = await unitRow(event!.id);
    expect([row.price_row_id, row.cost_micro_cents]).toEqual([null, null]);
  });

  it('pin 1c: an openai-compatible unit carries no price row even when a row exists for it', async () => {
    await db.aiModelPrice.create({ data: { id: generateId(), provider: 'openai-compatible', model: BASE.model, tier: 1, inputMicroCentsPerMTok: IN_RATE, outputMicroCentsPerMTok: OUT_RATE, effectiveAt: new Date('2026-01-01T00:00:00Z') } });
    const event = await recordLlmUsage(db, { ...BASE, provider: 'openai-compatible', organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    expect((await unitRow(event!.id)).price_row_id).toBeNull();
  });
});

describe('#5021 a unit records the markup of its charge', () => {
  it('pin 2: a charged platform-key unit with a row of no markup records the fleet default (2500) and is debited at it', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25');
    await mkPrice(new Date('2026-01-01T00:00:00Z'));
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    expect((await unitRow(event!.id)).markup_basis_points).toBe(2500);
    const [debit] = await db.creditLedgerEntry.findMany({ where: { sourceId: event!.id } });
    expect(debit.amountMicroCents).toBe(-131_250n); // 105_000 x 1.25
  });

  it('pin 2b: an own-key unit records no markup', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25');
    await mkPrice(new Date('2026-01-01T00:00:00Z'));
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, keyOwnerType: 'ORGANIZATION' });
    expect((await unitRow(event!.id)).markup_basis_points).toBeNull();
  });

  it('pin 2c: with debits off, a platform-key unit records no markup', async () => {
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25');
    const price = await mkPrice(new Date('2026-01-01T00:00:00Z'));
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    const row = await unitRow(event!.id);
    expect([row.price_row_id, row.markup_basis_points]).toEqual([price.id, null]);
  });

  it('pin 2d: a platform-key unit with no billable organization is not charged and records no markup', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25');
    await mkPrice(new Date('2026-01-01T00:00:00Z'));
    const event = await recordLlmUsage(db, { ...BASE, keyOwnerType: 'HADRON_SERVER' });
    expect((await unitRow(event!.id)).markup_basis_points).toBeNull();
  });

  it('pin 3: a row with its own markup (1000) is what the unit records, whatever the env says', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '25');
    await mkPrice(new Date('2026-01-01T00:00:00Z'), { markupBasisPoints: 1000 });
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, keyOwnerType: 'HADRON_SERVER' });
    expect((await unitRow(event!.id)).markup_basis_points).toBe(1000);
    const [debit] = await db.creditLedgerEntry.findMany({ where: { sourceId: event!.id } });
    expect(debit.amountMicroCents).toBe(-115_500n); // 105_000 x 1.10
  });
});

describe('#5021 a unit records its run (gate ruling 9)', () => {
  async function mkRun() {
    const app = await db.app.create({ data: { name: 'Price app', urn: `price.test:${generateId()}`, organizationId: orgId } });
    return (await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId: app.id, agentId: await testRunAgentId(db, orgId, app.id), triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:example.com:synthetic:entry', costMicroCents: 0n } })).id;
  }

  it('pin 11: a priced unit of a run names the run, and the run total still moves in the same transaction', async () => {
    await mkPrice(new Date('2026-01-01T00:00:00Z'));
    const runId = await mkRun();
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, appRunId: runId });
    expect((await unitRow(event!.id)).app_run_id).toBe(runId);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).costMicroCents).toBe(COST);
  });

  it('pin 11b: an unpriced unit of a run names the run too', async () => {
    const runId = await mkRun();
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId, appRunId: runId });
    expect((await unitRow(event!.id)).app_run_id).toBe(runId);
  });
});

describe('#5021 every process switches to a new row at its effective instant', () => {
  it('pin 6: a unit recorded 1 s after a new row takes effect is priced from it, by a process that cached the old row', async () => {
    const T = new Date(Date.now() + 120_000);
    await mkPrice(new Date('2026-01-01T00:00:00Z'), { inRate: 1n });
    const next = await mkPrice(T); // seeded directly, as another process's setAiModelPrice would have written it
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T.getTime() - 10_000));
    const cached = await getAiModelPrice(db, 'anthropic', BASE.model); // fills this process's cache with the old row
    expect(cached?.inputMicroCentsPerMTok).toBe(1n);
    vi.setSystemTime(new Date(T.getTime() + 1_000));
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId });
    expect(event!.costMicroCents).toBe(COST); // the old row (input rate 1) would give 75_001
    const row = await unitRow(event!.id);
    expect([row.price_row_id, row.cost_micro_cents]).toEqual([next.id, COST.toString()]);
  });

  it('pin 6b: the unit is priced at its own recorded instant', async () => {
    const T = new Date(Date.now() + 120_000);
    const next = await mkPrice(T);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T.getTime() + 1_000));
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId });
    expect(event!.createdAt.getTime()).toBe(T.getTime() + 1_000);
    expect((await unitRow(event!.id)).price_row_id).toBe(next.id);
  });

  it('pin 6c (gate ruling 5): the row that priced a unit is the row in force at its recorded instant, even when the clock passes a new row during the lookup', async () => {
    const T = new Date(Date.now() + 120_000);
    const old = await mkPrice(new Date('2026-01-01T00:00:00Z'), { inRate: 1n });
    const next = await mkPrice(T);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T.getTime() - 1_000));
    // The clock crosses T while the price lookup runs, as it can on a busy server.
    const slow = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'aiModelPrice') return Reflect.get(target, prop, receiver);
        return new Proxy(target.aiModelPrice, {
          get(model, method, r) {
            const fn = Reflect.get(model, method, r);
            if (method !== 'findFirst') return fn;
            return async (...args: unknown[]) => {
              const out = await (fn as (...a: unknown[]) => Promise<unknown>).apply(model, args);
              vi.setSystemTime(new Date(T.getTime() + 1_000));
              return out;
            };
          },
        });
      },
    }) as typeof db;
    const event = await recordLlmUsage(slow, { ...BASE, organizationId: orgId });
    const inForceAtStamp = event!.createdAt.getTime() >= T.getTime() ? next.id : old.id;
    expect((await unitRow(event!.id)).price_row_id).toBe(inForceAtStamp);
  });
});

describe('#5021 price rows are kept', () => {
  let priceId: string;
  beforeEach(async () => {
    priceId = (await mkPrice(new Date('2026-01-01T00:00:00Z'), { createdBy: userS, markupBasisPoints: 500 })).id;
  });
  const priceRow = async () => (await pg.query('SELECT * FROM ai_model_prices WHERE id = $1', [priceId])).rows[0];

  it('pin 7: DELETE of a row nothing references is refused', async () => {
    expect(await code('DELETE FROM ai_model_prices WHERE id = $1', [priceId])).toBe('23514');
    expect(await priceRow()).toBeTruthy();
  });

  it('pin 7b: DELETE of a row a unit references is refused', async () => {
    const event = await recordLlmUsage(db, { ...BASE, organizationId: orgId });
    expect((await unitRow(event!.id)).price_row_id).toBe(priceId);
    expect(await code('DELETE FROM ai_model_prices WHERE id = $1', [priceId])).toBe('23514');
    expect(await priceRow()).toBeTruthy();
  });

  const changes: Array<[string, string, unknown]> = [
    ['id', 'id = $2', 'changed-id'],
    ['provider', 'provider = $2', 'other'],
    ['model', 'model = $2', 'other'],
    ['tier', 'tier = $2', 2],
    ['input_micro_cents_per_mtok', 'input_micro_cents_per_mtok = $2', '1'],
    ['output_micro_cents_per_mtok', 'output_micro_cents_per_mtok = $2', '1'],
    ['markup_basis_points', 'markup_basis_points = $2', 9],
    ['markup_basis_points to null', 'markup_basis_points = $2', null],
    ['effective_at', 'effective_at = $2', new Date('2030-01-01T00:00:00Z')],
    ['created_at', 'created_at = $2', new Date('2001-01-01T00:00:00Z')],
    ['updated_at', 'updated_at = $2', new Date('2001-01-01T00:00:00Z')],
    ['deleted_at', 'deleted_at = $2', new Date('2030-01-01T00:00:00Z')],
  ];
  it.each(changes)('pin 8: UPDATE of %s is refused with 23514 and the row is unchanged', async (_c, set, value) => {
    const before = await priceRow();
    expect(await code(`UPDATE ai_model_prices SET ${set} WHERE id = $1`, [priceId, value])).toBe('23514');
    expect(lastMessage).toMatch(/kept/);
    expect(await priceRow()).toEqual(before);
  });

  it('pin 8b: re-pointing an audit id with no recorded merge is refused, for each audit column', async () => {
    expect(await code('UPDATE ai_model_prices SET created_by = $2 WHERE id = $1', [priceId, userT])).toBe('23514');
    expect(await code('UPDATE ai_model_prices SET updated_by = $2 WHERE id = $1', [priceId, userT])).toBe('23514');
    expect(await code('UPDATE ai_model_prices SET deleted_by = $2 WHERE id = $1', [priceId, userT])).toBe('23514');
    expect((await priceRow()).created_by).toBe(userS);
  });

  it('pin 8c: a merge recorded the other way round does not authorise it', async () => {
    await db.userMerge.create({ data: { sourceUserId: userT, targetUserId: userS, mergedBy: userS } });
    expect(await code('UPDATE ai_model_prices SET created_by = $2 WHERE id = $1', [priceId, userT])).toBe('23514');
  });

  it('pin 8d: an audit id along a recorded merge AND a price change in one UPDATE is refused', async () => {
    await db.userMerge.create({ data: { sourceUserId: userS, targetUserId: userT, mergedBy: userT } });
    expect(await code("UPDATE ai_model_prices SET created_by = $2, input_micro_cents_per_mtok = 1 WHERE id = $1", [priceId, userT])).toBe('23514');
    expect((await priceRow()).created_by).toBe(userS);
  });

  it('pin 8e: a session temp table named user_merges cannot forge the merge proof', async () => {
    await pg.query('CREATE TEMP TABLE user_merges (LIKE public.user_merges INCLUDING DEFAULTS)');
    try {
      await pg.query('INSERT INTO pg_temp.user_merges (source_user_id, target_user_id, merged_by) VALUES ($1, $2, $2)', [userS, userT]);
      expect(await code('UPDATE ai_model_prices SET created_by = $2 WHERE id = $1', [priceId, userT])).toBe('23514');
    } finally {
      await pg.query('DROP TABLE pg_temp.user_merges');
    }
  });

  it('pin 9 (guard): merging away a user who set a price row succeeds and re-points created_by; nothing else changes', async () => {
    const before = await priceRow();
    await mergeUsers(db, { sourceUserId: userS, targetUserId: userT, actorUserId: admin });
    const after = await priceRow();
    expect(after.created_by).toBe(userT);
    expect({ ...after, created_by: null }).toEqual({ ...before, created_by: null });
  });

  it('pin 9b (guard): with the merge recorded, every audit column may follow it', async () => {
    await db.userMerge.create({ data: { sourceUserId: userS, targetUserId: userT, mergedBy: userT } });
    expect(await code('UPDATE ai_model_prices SET created_by = $2 WHERE id = $1', [priceId, userT])).toBeNull();
  });

  it('pin 12: cleanDb empties the price table and the units that reference it, though the trigger refuses a DELETE', async () => {
    await recordLlmUsage(db, { ...BASE, organizationId: orgId });
    await cleanDb(db);
    expect((await pg.query('SELECT (SELECT count(*) FROM ai_model_prices)::int AS p, (SELECT count(*) FROM usage_events)::int AS u')).rows[0]).toEqual({ p: 0, u: 0 });
  });
});
