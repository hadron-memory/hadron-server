/**
 * #833 + #836 — the appRuns list can finally be ORDERED and NARROWED
 * server-side. Both gaps had the same consequence: the client could only sort
 * and filter the window it already held, so "the slowest run" meant "the
 * slowest of the most recent 200" and "still in flight" was inexpressible.
 *
 * The semantics that are easy to get subtly wrong (and are pinned here):
 *   - an explicitly EMPTY `statuses` list is the EMPTY scope, never "all";
 *   - nullable timestamps sort NULLS LAST in both directions;
 *   - every sort carries an id tiebreak so offset paging is deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { buildStatusFilter, buildAppRunOrderBy } from './resolvers.appRun.js';

const Q = resolvers.Query as any;

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

let org: { id: string; urn: string };
let member: { id: string };
let appId: string;

/** Runs seeded with distinct createdAt/startedAt/finishedAt so order is legible. */
const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min, 0));

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'rl', urn: `rl-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 49101, githubUsername: 'rl-member' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  const app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'App' },
  });
  appId = app.id;
});

async function seedRun(over: Record<string, unknown>) {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: org.id, appId,
      triggerKind: 'MANUAL', entryNodeUrn: `${org.urn}::m::n`, status: 'COMPLETED',
      ...over,
    } as never,
  });
}

const list = (args: Record<string, unknown>) => Q.appRuns(null, { orgRef: org.id, ...args }, ctx(member.id));

// ---------------------------------------------------------------------------
// #836 — statuses
// ---------------------------------------------------------------------------

describe('buildStatusFilter — the scope semantics (#836)', () => {
  it('omitted means NO filter', () => {
    expect(buildStatusFilter(null, null)).toEqual({});
    expect(buildStatusFilter(undefined, undefined)).toEqual({});
  });

  it('an explicitly EMPTY list is the EMPTY scope, not a fallback to all', () => {
    // The trap conventions:multi-ref-scope-args calls out — falling back here
    // would relabel "nothing" as "everything".
    expect(buildStatusFilter(null, [])).toEqual({ status: { in: [] } });
  });

  it('dedupes repeated values', () => {
    expect(buildStatusFilter(null, ['PENDING', 'RUNNING', 'PENDING'])).toEqual({
      status: { in: ['PENDING', 'RUNNING'] },
    });
  });

  it('statuses WINS over the deprecated singular — never ANDed', () => {
    expect(buildStatusFilter('FAILED', ['PENDING'])).toEqual({ status: { in: ['PENDING'] } });
  });

  it('the deprecated singular still works alone', () => {
    expect(buildStatusFilter('FAILED', null)).toEqual({ status: 'FAILED' });
  });
});

describe('appRuns(statuses:) — the disjunction the single arg could not express (#836)', () => {
  beforeEach(async () => {
    await seedRun({ status: 'PENDING' });
    await seedRun({ status: 'RUNNING' });
    await seedRun({ status: 'COMPLETED' });
    await seedRun({ status: 'FAILED' });
    await seedRun({ status: 'TIMED_OUT' });
  });

  it('"everything still in flight" = [PENDING, RUNNING]', async () => {
    const page = await list({ statuses: ['PENDING', 'RUNNING'] });
    expect(page.total).toBe(2);
    expect(page.items.map((r: { status: string }) => r.status).sort()).toEqual(['PENDING', 'RUNNING']);
  });

  it('"what went wrong" = [FAILED, TIMED_OUT]', async () => {
    const page = await list({ statuses: ['FAILED', 'TIMED_OUT'] });
    expect(page.total).toBe(2);
  });

  it('an EMPTY list returns nothing — and total agrees', async () => {
    const page = await list({ statuses: [] });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('omitting the filter returns every status', async () => {
    expect((await list({})).total).toBe(5);
  });

  it('the deprecated status arg is unchanged for existing callers', async () => {
    const page = await list({ status: 'FAILED' });
    expect(page.total).toBe(1);
    expect(page.items[0].status).toBe('FAILED');
  });
});

// ---------------------------------------------------------------------------
// #833 — sort
// ---------------------------------------------------------------------------

describe('buildAppRunOrderBy — tiebreak and null placement (#833)', () => {
  it('defaults to createdAt desc', () => {
    expect(buildAppRunOrderBy(null, null)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('every branch carries an id tiebreak so offset paging is deterministic', () => {
    for (const f of ['createdAt', 'startedAt', 'finishedAt', 'status'] as const) {
      const order = buildAppRunOrderBy(f, 'asc');
      expect(order[order.length - 1]).toEqual({ id: 'asc' });
    }
  });

  it('nullable timestamps sort NULLS LAST in BOTH directions', () => {
    expect(buildAppRunOrderBy('startedAt', 'desc')[0]).toEqual({ startedAt: { sort: 'desc', nulls: 'last' } });
    expect(buildAppRunOrderBy('finishedAt', 'asc')[0]).toEqual({ finishedAt: { sort: 'asc', nulls: 'last' } });
  });
});

describe('appRuns(sortBy:) — ordering the whole set, not just the page (#833)', () => {
  it('createdAt desc remains the DEFAULT (existing callers depend on it)', async () => {
    const a = await seedRun({ createdAt: T(1) });
    const b = await seedRun({ createdAt: T(3) });
    const c = await seedRun({ createdAt: T(2) });
    const page = await list({});
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([b.id, c.id, a.id]);
  });

  it('sorts by finishedAt ascending across the whole set', async () => {
    const late = await seedRun({ finishedAt: T(9) });
    const early = await seedRun({ finishedAt: T(1) });
    const mid = await seedRun({ finishedAt: T(5) });
    const page = await list({ sortBy: 'finishedAt', sortDir: 'asc' });
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([early.id, mid.id, late.id]);
  });

  it('an UNFINISHED run sorts LAST on finishedAt desc — nulls never crowd the top', async () => {
    const finished = await seedRun({ finishedAt: T(5), status: 'COMPLETED' });
    const pending = await seedRun({ finishedAt: null, status: 'PENDING' });
    const page = await list({ sortBy: 'finishedAt', sortDir: 'desc' });
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([finished.id, pending.id]);
  });

  it('the same holds ascending — nulls last, not first', async () => {
    const finished = await seedRun({ finishedAt: T(5), status: 'COMPLETED' });
    const pending = await seedRun({ finishedAt: null, status: 'PENDING' });
    const page = await list({ sortBy: 'finishedAt', sortDir: 'asc' });
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([finished.id, pending.id]);
  });

  it('paging is stable under a TIED sort key (the id tiebreak earns its keep)', async () => {
    // Every run shares one status, so status alone cannot order them.
    for (let i = 0; i < 6; i++) await seedRun({ status: 'COMPLETED', createdAt: T(i) });
    const p1 = await list({ sortBy: 'status', sortDir: 'asc', limit: 3, offset: 0 });
    const p2 = await list({ sortBy: 'status', sortDir: 'asc', limit: 3, offset: 3 });
    const ids = [...p1.items, ...p2.items].map((r: { id: string }) => r.id);
    // No row appears twice and none is skipped — which is exactly what breaks
    // without a deterministic tiebreak.
    expect(new Set(ids).size).toBe(6);
  });

  it('sort and status filter compose', async () => {
    await seedRun({ status: 'COMPLETED', createdAt: T(1) });
    const p = await seedRun({ status: 'PENDING', createdAt: T(2) });
    const r = await seedRun({ status: 'RUNNING', createdAt: T(3) });
    const page = await list({ statuses: ['PENDING', 'RUNNING'], sortBy: 'createdAt', sortDir: 'asc' });
    expect(page.items.map((x: { id: string }) => x.id)).toEqual([p.id, r.id]);
    expect(page.total).toBe(2);
  });
});
