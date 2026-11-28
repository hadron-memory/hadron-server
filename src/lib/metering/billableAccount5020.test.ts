/**
 * hadron-server#5020 (Billing A13), library and database level: a unit of AI spend names exactly one billable account, the
 * owner of the work (hrn:node:hadronmemory.com:specs:cor:dmo:170:05). The account is an organization or a person, the
 * database refuses a unit naming both, an embedding unit is never debited, and an account merge moves the units billed to
 * the merged-away person to the survivor.
 *
 * A raw `pg` client reads process.env.DATABASE_URL (the per-worker database), as the #5014 pins do.
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createPriceRowForTest } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../id.js';
import { creditBalance, clearPriceCache, recordLlmUsage } from './index.js';

let pg: Client;
let orgA: string, orgB: string, p: string, q: string, admin: string;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });

const mkUser = (handle: string) => db.user.create({ data: { id: generateId(), handle } }).then((x) => x.id);
const mkApp = (slug: string, owner: { organizationId?: string; ownerUserId?: string }) =>
  db.app.create({ data: { id: generateId(), name: slug, urn: `hrn:app:b5020.test:${slug}`, ...owner } });
const mkAgent = (slug: string, owner: { organizationId?: string; ownerUserId?: string }) =>
  db.agent.create({ data: { id: generateId(), name: slug, urn: `hrn:agent:b5020.test:${slug}`, ...owner } });
const mkPrice = () =>
  createPriceRowForTest(db, {
    data: { id: generateId(), provider: 'anthropic', model: 'claude-b5020', tier: 1, inputMicroCentsPerMTok: 30_000_000n, outputMicroCentsPerMTok: 150_000_000n, effectiveAt: new Date('2026-01-01') },
  });

beforeEach(async () => {
  await cleanDb(db);
  clearPriceCache();
  orgA = (await db.organization.create({ data: { id: generateId(), name: 'b5020-a', urn: 'b5020-a' } })).id;
  orgB = (await db.organization.create({ data: { id: generateId(), name: 'b5020-b', urn: 'b5020-b' } })).id;
  p = await mkUser('b5020-p');
  q = await mkUser('b5020-q');
  admin = (await db.user.create({ data: { id: generateId(), handle: 'b5020-admin', roles: ['ADMIN'] } })).id;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const base = { type: 'app-run', provider: 'anthropic', model: 'claude-b5020', tokensIn: 1000, tokensOut: 500, keyOwnerType: 'HADRON_SERVER' } as const;

describe('pin 1: the owner of the work', () => {
  it('the App\'s owner first, then the Agent\'s, and nobody when neither names one', async () => {
    const { billableAccountFor } = await import('./billableAccount.js');
    const appA = await mkApp('app-a', { organizationId: orgA });
    const appP = await mkApp('app-p', { ownerUserId: p });
    const agentB = await mkAgent('agent-b', { organizationId: orgB });
    const agentP = await mkAgent('agent-p', { ownerUserId: p });
    // spec S3: an Agent another organization owns, run in this organization's App: the App's organization.
    expect(await billableAccountFor(db, { appId: appA.id, agentId: agentB.id })).toEqual({ organizationId: orgA });
    expect(await billableAccountFor(db, { appId: appP.id, agentId: agentB.id })).toEqual({ userId: p });
    // no App: the Agent's owner
    expect(await billableAccountFor(db, { appId: null, agentId: agentP.id })).toEqual({ userId: p });
    expect(await billableAccountFor(db, { agentId: agentB.id })).toEqual({ organizationId: orgB });
    // neither
    expect(await billableAccountFor(db, {})).toBeNull();
    expect(await billableAccountFor(db, { appId: 'no-such-app', agentId: 'no-such-agent' })).toBeNull();
  });
});

describe('pin 4: an embedding unit is never debited', () => {
  it('type embedding, platform key, debits on, a price row: the unit is recorded, no ledger entry', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await mkPrice();
    const event = await recordLlmUsage(db, { ...base, type: 'embedding', billableAccount: { organizationId: orgA } });
    expect(event).not.toBeNull();
    expect(event!.organizationId).toBe(orgA);
    expect(event!.costMicroCents).not.toBeNull();
    expect(await db.creditLedgerEntry.count()).toBe(0);
    // and no markup is recorded for a unit that is not charged (cor:dmo:170:06)
    expect(event!.markupBasisPoints).toBeNull();
  });
});

describe('pin 5: a person as the billable account', () => {
  it('writes one debit on that person\'s ledger and none on any organization\'s', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('CREDIT_MARKUP_PERCENT', '0');
    await mkPrice();
    const event = await recordLlmUsage(db, { ...base, userId: q, billableAccount: { userId: p } });
    expect(event).toMatchObject({ billableUserId: p, organizationId: null, userId: q });
    const entries = await db.creditLedgerEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ownerUserId: p, organizationId: null, kind: 'debit', sourceType: 'usage-event', sourceId: event!.id });
    expect(await creditBalance(db, { userId: p })).toBe(-event!.costMicroCents!);
    expect(await creditBalance(db, { organizationId: orgA })).toBe(0n);
  });

  it('an organization as the billable account still writes the organization column and debits the organization', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await mkPrice();
    const event = await recordLlmUsage(db, { ...base, billableAccount: { organizationId: orgA } });
    expect(event).toMatchObject({ organizationId: orgA, billableUserId: null });
    expect(await db.creditLedgerEntry.count({ where: { organizationId: orgA } })).toBe(1);
  });

  it('no billable account: the unit is recorded with neither column and nothing is debited', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    await mkPrice();
    const event = await recordLlmUsage(db, { ...base, billableAccount: null });
    expect(event).toMatchObject({ organizationId: null, billableUserId: null });
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});

describe('pin 6: the database refuses a unit with two billable accounts', () => {
  const insert = (cols: { org?: string | null; user?: string | null }) =>
    pg.query(`INSERT INTO usage_events (id, type, organization_id, billable_user_id) VALUES ($1, 'app-run', $2, $3)`, [generateId(), cols.org ?? null, cols.user ?? null]);
  const rejected = async (pr: Promise<unknown>) => { try { await pr; return null; } catch (e) { return e as { code?: string; constraint?: string }; } };

  it('both columns set: 23514 naming chk_usage_event_one_billable; one column or none: fine', async () => {
    const err = await rejected(insert({ org: orgA, user: p }));
    expect(err?.code).toBe('23514');
    expect(err?.constraint).toBe('chk_usage_event_one_billable');
    await insert({ org: orgA });
    await insert({ user: p });
    await insert({});
    expect((await pg.query('SELECT count(*)::int AS n FROM usage_events')).rows[0].n).toBe(3);
  });

  it('deleting the person nulls the column (SET NULL), so the unit survives', async () => {
    await insert({ user: p });
    await pg.query('DELETE FROM users WHERE id = $1', [p]);
    const row = (await pg.query('SELECT billable_user_id FROM usage_events')).rows[0];
    expect(row.billable_user_id).toBeNull();
  });
});

describe('pin 7: an account merge re-points the billable person', () => {
  it('units billed to the merged-away person are billed to the survivor; units of the survivor and of others do not move', async () => {
    const mine = await db.usageEvent.create({ data: { type: 'app-run', billableUserId: p, tokensIn: 1 } });
    const theirs = await db.usageEvent.create({ data: { type: 'app-run', billableUserId: q, tokensIn: 1 } });
    const forP = await db.usageEvent.create({ data: { type: 'app-run', organizationId: orgA, userId: p, tokensIn: 1 } });
    await mergeUsers(db, { sourceUserId: p, targetUserId: q, actorUserId: admin });
    expect((await db.usageEvent.findUniqueOrThrow({ where: { id: mine.id } })).billableUserId).toBe(q);
    expect((await db.usageEvent.findUniqueOrThrow({ where: { id: theirs.id } })).billableUserId).toBe(q);
    // `userId` (the work done for) was already re-pointed by the merge; the organization-billed unit stays organization-billed
    const moved = await db.usageEvent.findUniqueOrThrow({ where: { id: forP.id } });
    expect(moved).toMatchObject({ organizationId: orgA, billableUserId: null });
  });
});
