/**
 * #855 — appRuns(sortBy: duration): the elapsed time of a run (finishedAt - startedAt) orders the WHOLE set, not the
 * loaded page. The duration is a STORED GENERATED column (`app_runs.duration_ms`, BIGINT milliseconds), so the same
 * `findMany` / `count` pair serves page and total and the column is indexable.
 *
 * Semantics pinned here (gate: hadron-server#855):
 *   - NULL (a run with no startedAt or no finishedAt: PENDING, RUNNING, failed before it finished) sorts LAST in BOTH
 *     directions, like the nullable timestamps;
 *   - equal durations order by id (the same tiebreak every sort carries), in the direction of the sort;
 *   - a negative duration (clock skew) sorts as stored, never clamped;
 *   - BIGINT: a run longer than the 24.8 days an INTEGER of milliseconds holds is stored and ordered;
 *   - no access change: the same rows are visible as under a createdAt sort.
 * The schema-sync pins (the column is GENERATED, and one `db push` reports no drift for it) read the catalog.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { buildAppRunOrderBy } from './resolvers.appRun.js';
import { testRunAgentId } from '../../../test/runAgent.js';

const Q = resolvers.Query as any;
const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

let org: { id: string; urn: string };
let member: { id: string };
let appId: string;

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
/** A run that took `ms` milliseconds. */
const took = (ms: number) => ({ startedAt: new Date(T0), finishedAt: new Date(T0 + ms), status: 'COMPLETED' });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'ds', urn: `ds-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 85501, githubUsername: 'ds-member' } });
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
      agentId: await testRunAgentId(db, org.id, appId),
      triggerKind: 'MANUAL', entryNodeUrn: `${org.urn}::m::n`, status: 'COMPLETED',
      ...over,
    } as never,
  });
}

const list = (args: Record<string, unknown>) => Q.appRuns(null, { orgRef: org.id, ...args }, ctx(member.id));
const ids = (page: { items: { id: string }[] }) => page.items.map((r) => r.id);

describe('buildAppRunOrderBy(duration) (#855)', () => {
  it('orders by the stored column, NULLS LAST in both directions, then the id tiebreak', () => {
    expect(buildAppRunOrderBy('duration' as never, 'desc')).toEqual([
      { durationMs: { sort: 'desc', nulls: 'last' } },
      { id: 'desc' },
    ]);
    expect(buildAppRunOrderBy('duration' as never, 'asc')).toEqual([
      { durationMs: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });
});

describe('appRuns(sortBy: duration) (#855)', () => {
  it('orders the WHOLE set: the longest run is first on page 1 of 3, the shortest last on page 3', async () => {
    const made: { id: string; ms: number }[] = [];
    for (let i = 0; i < 9; i++) {
      const ms = ((i * 4) % 9 + 1) * 1000; // 1..9 s, scrambled against creation order
      made.push({ id: (await seedRun({ ...took(ms) })).id, ms });
    }
    const byMsDesc = [...made].sort((a, b) => b.ms - a.ms).map((m) => m.id);
    const p1 = await list({ sortBy: 'duration', sortDir: 'desc', limit: 3, offset: 0 });
    const p2 = await list({ sortBy: 'duration', sortDir: 'desc', limit: 3, offset: 3 });
    const p3 = await list({ sortBy: 'duration', sortDir: 'desc', limit: 3, offset: 6 });
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(byMsDesc);
    expect(p1.total).toBe(9);
    expect(p3.total).toBe(9);
    const asc = await list({ sortBy: 'duration', sortDir: 'asc', limit: 9 });
    expect(ids(asc)).toEqual([...byMsDesc].reverse());
  });

  it('a run with no finish (PENDING, RUNNING, failed before finishing) sorts LAST in BOTH directions', async () => {
    const short = await seedRun({ ...took(1000) });
    const long = await seedRun({ ...took(9000) });
    const pending = await seedRun({ status: 'PENDING', startedAt: null, finishedAt: null });
    const running = await seedRun({ status: 'RUNNING', startedAt: new Date(T0), finishedAt: null });
    const failedNoStart = await seedRun({ status: 'FAILED', startedAt: null, finishedAt: new Date(T0 + 5000) });
    const nullIds = [pending.id, running.id, failedNoStart.id];
    const desc = ids(await list({ sortBy: 'duration', sortDir: 'desc' }));
    const asc = ids(await list({ sortBy: 'duration', sortDir: 'asc' }));
    expect(desc.slice(0, 2)).toEqual([long.id, short.id]);
    expect(asc.slice(0, 2)).toEqual([short.id, long.id]);
    expect([...desc.slice(2)].sort()).toEqual([...nullIds].sort());
    expect([...asc.slice(2)].sort()).toEqual([...nullIds].sort());
  });

  it('equal and NULL durations order by id, in the direction of the sort, and page without a gap or a repeat', async () => {
    const equal = [];
    for (let i = 0; i < 4; i++) equal.push((await seedRun({ ...took(2000) })).id);
    const nulls = [];
    for (let i = 0; i < 4; i++) nulls.push((await seedRun({ status: 'PENDING', startedAt: null, finishedAt: null })).id);
    for (const dir of ['asc', 'desc'] as const) {
      const sortedEq = [...equal].sort();
      const sortedNull = [...nulls].sort();
      if (dir === 'desc') {
        sortedEq.reverse();
        sortedNull.reverse();
      }
      const pages = [];
      for (let off = 0; off < 8; off += 3) pages.push(...ids(await list({ sortBy: 'duration', sortDir: dir, limit: 3, offset: off })));
      expect(pages).toEqual([...sortedEq, ...sortedNull]);
    }
  });

  it('a negative duration (clock skew) sorts as stored, without clamping', async () => {
    const pos = await seedRun({ ...took(3000) });
    const neg = await seedRun({ startedAt: new Date(T0 + 5000), finishedAt: new Date(T0), status: 'COMPLETED' });
    const zero = await seedRun({ ...took(0) });
    expect(ids(await list({ sortBy: 'duration', sortDir: 'asc' }))).toEqual([neg.id, zero.id, pos.id]);
    expect(ids(await list({ sortBy: 'duration', sortDir: 'desc' }))).toEqual([pos.id, zero.id, neg.id]);
  });

  it('is BIGINT milliseconds: a 40-day run is stored (an INTEGER of ms overflows at 24.8 days) and orders above a 1-day run', async () => {
    const day = 86_400_000;
    const forty = await seedRun({ ...took(40 * day) });
    const one = await seedRun({ ...took(day) });
    const rows = await db.$queryRaw<{ id: string; duration_ms: bigint }[]>`
      SELECT id, duration_ms FROM app_runs WHERE id IN (${forty.id}, ${one.id}) ORDER BY duration_ms DESC`;
    expect(rows.map((r) => [r.id, Number(r.duration_ms)])).toEqual([[forty.id, 40 * day], [one.id, day]]);
    expect(ids(await list({ sortBy: 'duration', sortDir: 'desc' }))).toEqual([forty.id, one.id]);
  });

  it('a one-millisecond difference orders (DateTime is millisecond-precise, so the stored value is exact)', async () => {
    const b = await seedRun({ startedAt: new Date(T0), finishedAt: new Date(T0 + 1501), status: 'COMPLETED' });
    const a = await seedRun({ startedAt: new Date(T0), finishedAt: new Date(T0 + 1500), status: 'COMPLETED' });
    expect(ids(await list({ sortBy: 'duration', sortDir: 'asc' }))).toEqual([a.id, b.id]);
  });

  it('filters compose with the sort and total matches the unsorted count', async () => {
    const slower = await seedRun({ ...took(9000), status: 'FAILED' });
    const slow = await seedRun({ ...took(8000), status: 'FAILED' });
    await seedRun({ ...took(1000) });
    await seedRun({ status: 'PENDING', startedAt: null, finishedAt: null });
    const sorted = await list({ statuses: ['FAILED'], sortBy: 'duration', sortDir: 'desc' });
    expect(ids(sorted)).toEqual([slower.id, slow.id]);
    expect(sorted.total).toBe(2);
    const unsorted = await list({ statuses: ['FAILED'] });
    expect(sorted.total).toBe(unsorted.total);
    expect((await list({ sortBy: 'duration' })).total).toBe((await list({})).total);
  });

  it('no access change: a duration sort shows exactly the rows a createdAt sort shows, and a non-member still gets NOT_FOUND', async () => {
    for (let i = 0; i < 5; i++) await seedRun({ ...took((i + 1) * 100) });
    const byCreated = await list({ sortBy: 'createdAt', limit: 200 });
    const byDuration = await list({ sortBy: 'duration', limit: 200 });
    expect([...ids(byDuration)].sort()).toEqual([...ids(byCreated)].sort());
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 85502, githubUsername: 'ds-out' } });
    await expect(Q.appRuns(null, { orgRef: org.id, sortBy: 'duration' }, ctx(outsider.id))).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

describe('app_runs.duration_ms in the catalog (#855)', () => {
  it('is a STORED GENERATED column on a database built from the schema (push + post-push), with the organization index', async () => {
    const col = await db.$queryRaw<{ attgenerated: string; typ: string; notnull: boolean }[]>`
      SELECT a.attgenerated, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'app_runs' AND a.attname = 'duration_ms' AND NOT a.attisdropped`;
    expect(col).toEqual([{ attgenerated: 's', typ: 'bigint', notnull: false }]);
    const idx = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'app_runs' AND indexname = 'app_runs_organization_id_duration_ms_idx'`;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/\(organization_id, duration_ms\)/);
  });

  it('cannot be written: the database refuses a value (generated always)', async () => {
    const run = await seedRun({ ...took(1000) });
    await expect(db.$executeRaw`UPDATE app_runs SET duration_ms = 5 WHERE id = ${run.id}`).rejects.toThrow(/generated/i);
  });
});
