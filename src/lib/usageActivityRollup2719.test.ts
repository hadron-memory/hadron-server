/**
 * #2719 slice 2: the usage-activity rollup answers `getUsageActivity` and must never change an answer. The oracle is the
 * ORIGINAL aggregation (a plain GROUP BY over usage_events, copied below), so every read pin is "rollup path == raw scan".
 * The write pins run each path that changes usage_events after the fact (insert, soft delete, user merge, user delete,
 * type or time update, hard delete, truncate) and then require the stored cells to equal a recount (the drift check).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { getUsageActivity, ROLLUP_CELL_MS, ROLLUP_MIN_MS, type UsageActivityBucketSize, type UsageActivityScope } from './usageActivity.js';
import { backfillUsageActivityRollup, findUsageActivityRollupDrift } from '../jobs/usageActivityRollup.js';

// The seed and the backfills are heavy on a loaded CI shard (a 5 s default timed out in shard 4): one file-wide bound.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const naive = (d: Date) => d.toISOString().replace('Z', '');
const T0 = Date.UTC(2026, 8, 20, 10, 7, 33, 123); // a fixed, deliberately unaligned instant
const at = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000);
const MIN = 60_000;
let alice: { id: string };
let bob: { id: string };
let memX: string;
let memY: string;

/** The aggregation as it was before the rollup (#796): the oracle every read pin compares against. */
async function oracle(scope: UsageActivityScope) {
  if (scope.memoryIds?.length === 0) return [];
  const pred = scope.memoryIds ? Prisma.sql`e.memory_id IN (${Prisma.join(scope.memoryIds)})` : Prisma.sql`e.user_id = ${scope.userId}`;
  const field = { DAY: 'day', WEEK: 'week', MONTH: 'month' }[scope.bucket];
  const rows = await db.$queryRaw<Array<{ date: string; reads: bigint; writes: bigint }>>`
    SELECT to_char(date_trunc(${field}, (e.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${scope.timeZone}), 'YYYY-MM-DD') AS date,
           COUNT(*) FILTER (WHERE e.type = 'read') AS reads, COUNT(*) FILTER (WHERE e.type = 'write') AS writes
    FROM usage_events e
    WHERE e.created_at >= ${naive(scope.from)}::timestamp AND e.created_at < ${naive(scope.to)}::timestamp
      AND e.type IN ('read', 'write') AND e.deleted_at IS NULL AND ${pred}
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({ date: r.date, reads: Number(r.reads), writes: Number(r.writes) }));
}

const setState = (complete: boolean, appliesFrom: Date) => db.$executeRaw`
  UPDATE usage_activity_rollup_state SET complete = ${complete}, applies_from = ${naive(appliesFrom)}::timestamp WHERE id = 1`;
const insert = (rows: Array<{ type?: string; userId?: string | null; memoryId?: string | null; createdAt: Date; deletedAt?: Date | null }>) =>
  db.usageEvent.createMany({ data: rows.map((r) => ({ id: generateId(), type: r.type ?? 'read', userId: r.userId ?? null, memoryId: r.memoryId ?? null, createdAt: r.createdAt, deletedAt: r.deletedAt ?? null })) });
const drift = () => findUsageActivityRollupDrift(db, { from: new Date(0), to: new Date(T0 + 400 * 86_400_000), limit: 20 });
const cellCount = async () => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM usage_activity_cells`)[0].n);

/** Events across ~45 days on and around cell edges, both scopes, every type and the rows that must not count. */
async function seedMixed() {
  const edges = [0, 1, 14 * 1, 15, 16, 29, 30, 44, 45, 59, 60, 61, 119, 120];
  const rows: Parameters<typeof insert>[0] = [];
  for (let day = 0; day < 45; day++) {
    for (const m of edges) {
      const createdAt = new Date(Math.floor(T0 / 900_000) * 900_000 - day * 86_400_000 + m * MIN - 1 + (m % 2) * 1);
      rows.push({ type: m % 3 === 0 ? 'write' : 'read', userId: m % 4 === 0 ? bob.id : alice.id, memoryId: m % 5 === 0 ? memY : memX, createdAt });
    }
  }
  rows.push({ type: 'embedding', userId: alice.id, memoryId: memX, createdAt: at(-30) });
  rows.push({ type: 'read', userId: alice.id, memoryId: memX, createdAt: at(-31), deletedAt: at(-1) });
  rows.push({ type: 'read', userId: null, memoryId: memX, createdAt: at(-32) });
  rows.push({ type: 'write', userId: alice.id, memoryId: null, createdAt: at(-33) });
  await insert(rows);
}

beforeEach(async () => {
  await cleanDb(db);
  // cleanDb's delete nets events out of the cells, but a test that moved the state row's boundary can leave cells the
  // trigger declined to touch: no cell outlives its fixture.
  await db.$executeRaw`TRUNCATE usage_activity_cells`;
  alice = await db.user.create({ data: { id: generateId(), githubId: 271901, githubUsername: 'rollup-alice' } });
  bob = await db.user.create({ data: { id: generateId(), githubId: 271902, githubUsername: 'rollup-bob' } });
  memX = generateId();
  memY = generateId();
  await setState(true, new Date(0));
});

// A worker's database clone is reused by later files: leave the state row as a fresh deploy would.
afterAll(async () => {
  await cleanDb(db);
  await db.$executeRaw`TRUNCATE usage_activity_cells`;
  await db.$executeRaw`INSERT INTO usage_activity_rollup_state (id, applies_from, complete) VALUES (1, hadron_usage_cell((now() AT TIME ZONE 'UTC')::timestamp) + interval '15 minutes', false)
    ON CONFLICT (id) DO UPDATE SET applies_from = EXCLUDED.applies_from, complete = false`;
});

describe('#2719 rollup read equals the raw scan', () => {
  const windows: Array<[string, Date, Date]> = [
    ['the default window, unaligned both ends', at(-7 * 1440), at(0)],
    ['an explicit unaligned from/to', at(-33 * 1440 - 7), at(-3 * 1440 + 4)],
    ['a window narrower than one cell (raw only)', at(-3), at(-1)],
    ['a window of exactly whole cells (no raw edge)', new Date(Math.floor(T0 / 900_000) * 900_000 - 10 * 86_400_000), new Date(Math.floor(T0 / 900_000) * 900_000)],
    ['the whole seeded span', at(-46 * 1440), at(1)],
  ];
  const zones = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Kathmandu'];
  const buckets: UsageActivityBucketSize[] = ['DAY', 'WEEK', 'MONTH'];

  it.each(windows)('%s: every bucket size, zone and scope', async (_name, from, to) => {
    await seedMixed();
    expect((await drift()).total).toBe(0);
    for (const timeZone of zones) for (const bucket of buckets) {
      for (const sc of [{ userId: alice.id }, { userId: bob.id }, { memoryIds: [memX] }, { memoryIds: [memY] }, { memoryIds: [memX, memY] }]) {
        const scope = { from, to, bucket, timeZone, ...sc };
        const want = await oracle(scope);
        expect(await getUsageActivity(db, scope), `${timeZone} ${bucket} ${JSON.stringify(sc)}`).toEqual(want);
      }
    }
  });

  it('is not vacuous: the cells hold rows and the oracle is non-empty', async () => {
    await seedMixed();
    expect(await cellCount()).toBeGreaterThan(100);
    expect((await oracle({ from: at(-46 * 1440), to: at(1), bucket: 'DAY', timeZone: 'UTC', userId: alice.id })).length).toBeGreaterThan(30);
  });

  it('serves whole interior cells FROM the rollup and the partial edge cells from the raw rows', async () => {
    const cellStart = Math.floor(T0 / 900_000) * 900_000 - 2 * 86_400_000; // an aligned cell two days back
    await insert([{ userId: alice.id, createdAt: new Date(cellStart + 5 * MIN) }, { userId: alice.id, createdAt: new Date(cellStart + 15 * MIN + 5 * MIN) }]);
    await db.$executeRaw`UPDATE usage_activity_cells SET reads = reads + 1000 WHERE scope_kind = 'user' AND scope_id = ${alice.id} AND cell = ${naive(new Date(cellStart))}::timestamp`;
    const total = async (from: Date, to: Date) => (await getUsageActivity(db, { from, to, bucket: 'MONTH', timeZone: 'UTC', userId: alice.id })).reduce((n, b) => n + b.reads, 0);
    // the planted cell is wholly inside the window: the rollup value (1 + 1000) shows
    expect(await total(new Date(cellStart - 15 * MIN), new Date(cellStart + 45 * MIN))).toBe(1 + 1000 + 1);
    // the same cell as the window's partial FIRST edge (from inside it): raw rows answer, no planted value
    expect(await total(new Date(cellStart + 1 * MIN), new Date(cellStart + 45 * MIN))).toBe(1 + 1);
    // and as the partial LAST edge
    expect(await total(new Date(cellStart - 15 * MIN), new Date(cellStart + 10 * MIN))).toBe(1);
  });

  it('keeps the memory-scope union exact and never falls back to own activity for an empty scope', async () => {
    await seedMixed();
    const base = { from: at(-46 * 1440), to: at(1), bucket: 'DAY' as const, timeZone: 'UTC' };
    expect(await getUsageActivity(db, { ...base, memoryIds: [] })).toEqual([]);
    // unattributed events (no memory) live in user scope only; the memory-less write of alice is absent from both memory scopes
    const user = (await getUsageActivity(db, { ...base, userId: alice.id })).reduce((n, b) => n + b.writes, 0);
    const mem = (await getUsageActivity(db, { ...base, memoryIds: [memX, memY] })).reduce((n, b) => n + b.writes, 0);
    expect(user).not.toBe(mem);
  });
});

describe('#2719 the triggers keep the cells equal to a recount on every write path', () => {
  const expectConsistent = async (label: string) => {
    const found = await drift();
    expect(found.rows, label).toEqual([]);
    expect(found.total, label).toBe(0);
  };

  it('insert', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5) }, { type: 'write', userId: alice.id, memoryId: memX, createdAt: at(-4) }, { type: 'embedding', userId: alice.id, createdAt: at(-4) }]);
    await expectConsistent('insert');
    expect(await cellCount()).toBe(2); // user + memory scope of one cell; the embedding counts nowhere
  });

  it('soft delete, set and cleared', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5) }]);
    await db.$executeRaw`UPDATE usage_events SET deleted_at = now()`;
    await expectConsistent('soft delete');
    expect((await getUsageActivity(db, { from: at(-60), to: at(0), bucket: 'DAY', timeZone: 'UTC', userId: alice.id }))).toEqual([]);
    // a wide window whose cell holding the event is whole: the zeroed cell must read as no bucket, not a 0/0 bucket
    expect(await getUsageActivity(db, { from: at(-1440), to: at(120), bucket: 'DAY', timeZone: 'UTC', userId: alice.id })).toEqual([]);
    expect(await getUsageActivity(db, { from: at(-1440), to: at(120), bucket: 'DAY', timeZone: 'UTC', memoryIds: [memX] })).toEqual([]);
    await db.$executeRaw`UPDATE usage_events SET deleted_at = NULL`;
    await expectConsistent('restored');
    expect((await getUsageActivity(db, { from: at(-60), to: at(0), bucket: 'DAY', timeZone: 'UTC', userId: alice.id }))[0].reads).toBe(1);
  });

  it('user merge (the raw-SQL user_id reassignment) moves the user-scope counts and leaves memory scope', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5) }, { userId: alice.id, memoryId: memX, createdAt: at(-4) }]);
    await db.$executeRaw`UPDATE usage_events SET user_id = ${bob.id} WHERE user_id = ${alice.id}`;
    await expectConsistent('merge');
    const w = { from: at(-60), to: at(0), bucket: 'DAY' as const, timeZone: 'UTC' };
    expect(await getUsageActivity(db, { ...w, userId: alice.id })).toEqual([]);
    expect((await getUsageActivity(db, { ...w, userId: bob.id }))[0].reads).toBe(2);
    expect((await getUsageActivity(db, { ...w, memoryIds: [memX] }))[0].reads).toBe(2);
  });

  it('user delete (the SET NULL foreign-key action) drops the user scope and keeps the memory scope', async () => {
    await insert([{ userId: bob.id, memoryId: memX, createdAt: at(-5) }]);
    await db.user.delete({ where: { id: bob.id } });
    await expectConsistent('user delete');
    const w = { from: at(-60), to: at(0), bucket: 'DAY' as const, timeZone: 'UTC' };
    expect((await getUsageActivity(db, { ...w, memoryIds: [memX] }))[0].reads).toBe(1);
    expect(await getUsageActivity(db, { ...w, userId: bob.id })).toEqual([]);
  });

  it('a type change, a time move across cells, a memory change and a no-op update', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5) }]);
    await db.$executeRaw`UPDATE usage_events SET type = 'write'`;
    await expectConsistent('type');
    await db.$executeRaw`UPDATE usage_events SET created_at = created_at - interval '3 days'`;
    await expectConsistent('time');
    await db.$executeRaw`UPDATE usage_events SET memory_id = ${memY}`;
    await expectConsistent('memory');
    const before = await cellCount();
    await db.$executeRaw`UPDATE usage_events SET model = 'noop'`;
    await expectConsistent('no-op');
    expect(await cellCount()).toBe(before);
  });

  it('an erased user leaves no cell row behind, and a merge leaves none for the loser (zero cells are dropped)', async () => {
    const carol = await db.user.create({ data: { id: generateId(), githubId: 271903, githubUsername: 'rollup-carol' } });
    await insert([{ userId: carol.id, memoryId: memX, createdAt: at(-5) }, { userId: carol.id, memoryId: memX, createdAt: at(-50) }, { userId: alice.id, memoryId: memX, createdAt: at(-5) }]);
    await db.user.delete({ where: { id: carol.id } });
    const left = async (id: string) => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM usage_activity_cells WHERE scope_id = ${id}`)[0].n);
    expect(await left(carol.id)).toBe(0);
    expect((await drift()).total).toBe(0);
    expect(await cellCount()).toBeGreaterThan(0); // alice's and memX's rows stay
    // #4320 item 1: the merge leg the name always claimed but never ran (BLIND Dorian, 32f81c04). mergeUsers' raw
    // reassignment zeroes the loser's user-scope cells — the drop-zero trigger removes them — and moves the counts
    // to the winner; memory scope never carries a user id, so it is untouched.
    const dave = await db.user.create({ data: { id: generateId(), githubId: 271906, githubUsername: 'rollup-dave' } });
    await insert([{ userId: dave.id, memoryId: memX, createdAt: at(-5) }, { type: 'write', userId: dave.id, memoryId: memX, createdAt: at(-6) }]);
    await db.$executeRaw`UPDATE usage_events SET user_id = ${alice.id} WHERE user_id = ${dave.id}`;
    expect(await left(dave.id)).toBe(0);
    const w = { from: at(-60), to: at(0), bucket: 'DAY' as const, timeZone: 'UTC' };
    const winner = (await getUsageActivity(db, { ...w, userId: alice.id }))[0];
    expect(winner).toMatchObject({ reads: 2, writes: 1 }); // alice's own read plus both moved counts
    expect((await drift()).total).toBe(0);
  });

  it('an erased user with history from before the install (cells empty, backfill not run) leaves no cell row behind', async () => {
    const carol = await db.user.create({ data: { id: generateId(), githubId: 271904, githubUsername: 'rollup-carol2' } });
    // The fresh-install state: events exist, no cell does, the boundary is later than the events.
    await db.$executeRaw`DELETE FROM usage_activity_rollup_state WHERE id = 1`;
    await insert([{ userId: carol.id, memoryId: memX, createdAt: at(-5) }, { type: 'write', userId: carol.id, createdAt: at(-50) }]);
    await db.$executeRaw`INSERT INTO usage_activity_rollup_state (id, applies_from, complete) VALUES (1, ${naive(at(60))}::timestamp, false)`;
    expect(await cellCount()).toBe(0);
    await db.user.delete({ where: { id: carol.id } });
    const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM usage_activity_cells WHERE scope_id = ${carol.id}`;
    expect(Number(left[0].n)).toBe(0);
    expect(await cellCount()).toBe(0);
    await backfillUsageActivityRollup(db);
    expect((await drift()).total).toBe(0);
  });

  it('an erased user whose cell mixes pre-install and post-install events leaves no cell row (the update goes negative)', async () => {
    const carol = await db.user.create({ data: { id: generateId(), githubId: 271905, githubUsername: 'rollup-carol3' } });
    await db.$executeRaw`DELETE FROM usage_activity_rollup_state WHERE id = 1`;
    // #4320 item 2: explicit timestamps that SHARE a cell, asserted, instead of at(-5)/at(-4) landing together by
    // accident of T0 (BLIND Dorian, 36a8bde2). cellStart is the 15-minute cell holding at(-5).
    const cellStart = Math.floor(at(-5).getTime() / 900_000) * 900_000;
    const preInstall = new Date(cellStart + 60_000), postInstall = new Date(cellStart + 2 * 60_000);
    expect(Math.floor(preInstall.getTime() / 900_000)).toBe(Math.floor(postInstall.getTime() / 900_000)); // one cell
    await insert([{ userId: carol.id, memoryId: memX, createdAt: preInstall }]); // pre-install: never counted
    await db.$executeRaw`INSERT INTO usage_activity_rollup_state (id, applies_from, complete) VALUES (1, ${naive(at(60))}::timestamp, false)`;
    await insert([{ userId: carol.id, memoryId: memX, createdAt: postInstall }]); // post-install: counted into the same cell
    // The precondition the old `cellCount() > 0` could not show: the user's OWN cell exists, holds exactly the one
    // counted post-install read, and is the cell both timestamps share — so the delete must net it to -1.
    const mine = await db.$queryRaw<Array<{ cell: Date; reads: bigint; writes: bigint }>>`SELECT cell, reads, writes FROM usage_activity_cells WHERE scope_kind = 'user' AND scope_id = ${carol.id}`;
    expect(mine.map((r) => [r.cell.getTime(), Number(r.reads), Number(r.writes)])).toEqual([[cellStart, 1, 0]]);
    await db.user.delete({ where: { id: carol.id } });
    const left = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM usage_activity_cells WHERE scope_id = ${carol.id}`;
    expect(Number(left[0].n)).toBe(0);
  });

  it('a memory-scope cell whose scope_id equals a user id is not counted in that user\'s activity', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-60) }]);
    await db.$executeRaw`INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes) VALUES ('memory', ${alice.id}, ${naive(new Date(Math.floor(at(-60).getTime() / 900_000) * 900_000))}::timestamp, 7, 7)`;
    const scope = { from: at(-300), to: at(0), bucket: 'DAY' as const, timeZone: 'UTC', userId: alice.id };
    expect((await getUsageActivity(db, scope)).reduce((n, b) => n + b.reads + b.writes, 0)).toBe(1);
  });

  it('an update of a pre-install event keeps the destination\'s count while the source\'s negative cell is dropped', async () => {
    // #4320 item 3 (BLIND Dorian, 70c15466): moving an event that was never counted (history from before the state row
    // existed) nets -1 into the source cell — born non-positive, so the insert-drop removes it — and +1 into the
    // destination cell, which MUST survive with its count even though the same statement touched a dropping row.
    const carol = await db.user.create({ data: { id: generateId(), githubId: 271907, githubUsername: 'rollup-carol4' } });
    await db.$executeRaw`DELETE FROM usage_activity_rollup_state WHERE id = 1`;
    const srcCell = Math.floor(at(-5).getTime() / 900_000) * 900_000;
    const dstCell = srcCell - 900_000; // the previous 15-minute cell
    await insert([{ userId: carol.id, memoryId: memX, createdAt: new Date(srcCell + 60_000) }]); // pre-install: never counted
    await db.$executeRaw`INSERT INTO usage_activity_rollup_state (id, applies_from, complete) VALUES (1, ${naive(at(60))}::timestamp, false)`;
    await db.$executeRaw`UPDATE usage_events SET created_at = ${naive(new Date(dstCell + 60_000))}::timestamp WHERE user_id = ${carol.id}`;
    const cells = await db.$queryRaw<Array<{ scope_kind: string; cell: Date; reads: bigint; writes: bigint }>>`SELECT scope_kind, cell, reads, writes FROM usage_activity_cells WHERE scope_id = ${carol.id} OR (scope_kind = 'memory' AND scope_id = ${memX}) ORDER BY scope_kind, cell`;
    expect(cells.map((r) => [r.scope_kind, r.cell.getTime(), Number(r.reads), Number(r.writes)])).toEqual([
      ['memory', dstCell, 1, 0], // the destination keeps the moved count in both scopes…
      ['user', dstCell, 1, 0], // …while the never-counted source nets to no row in either
    ]);
  });

  it('hard delete and truncate', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5) }, { userId: alice.id, memoryId: memX, createdAt: at(-6000) }]);
    await db.$executeRaw`DELETE FROM usage_events WHERE created_at > ${naive(at(-100))}::timestamp`;
    await expectConsistent('delete');
    await db.$executeRaw`TRUNCATE usage_events`;
    expect(await cellCount()).toBe(0);
  });

  it('parallel chunks on the same cells sum exactly, in differing key orders, without deadlock', async () => {
    // 40 concurrent statements over 8 cells and 4 scopes, each statement listing its cells in a different order
    const cells = Array.from({ length: 8 }, (_, c) => -5 - c * 15);
    const chunks = Array.from({ length: 40 }, (_, i) => insert(Array.from({ length: 24 }, (_, j) => ({
      type: j % 2 ? 'read' : 'write',
      userId: i % 2 ? alice.id : bob.id,
      memoryId: i % 3 ? memX : memY,
      createdAt: at(cells[(i % 2 ? 7 - (j % 8) : j % 8)]),
    }))));
    await Promise.all(chunks);
    await expectConsistent('parallel');
    const w = { from: at(-300), to: at(0), bucket: 'DAY' as const, timeZone: 'UTC' };
    const sum = (b: Array<{ reads: number; writes: number }>) => b.reduce((n, x) => n + x.reads + x.writes, 0);
    expect(sum(await getUsageActivity(db, { ...w, memoryIds: [memX, memY] }))).toBe(960);
    expect(sum(await getUsageActivity(db, { ...w, userId: alice.id })) + sum(await getUsageActivity(db, { ...w, userId: bob.id }))).toBe(960);
  });

  it('a 500-row chunk writes one row per distinct (scope, cell), not per event', async () => {
    await insert(Array.from({ length: 500 }, (_, i) => ({ userId: alice.id, memoryId: memX, createdAt: at(-5 - (i % 3) * 15) })));
    await expectConsistent('chunk');
    expect(await cellCount()).toBeLessThanOrEqual(2 * 4); // 2 scopes x at most 4 cells (3 minutes-offsets can straddle one more boundary)
  });
});

describe('#2719 backfill and the watermark', () => {
  it('before the backfill an old window is answered from the raw rows, so the answer is unchanged', async () => {
    await seedMixed();
    await db.$executeRaw`TRUNCATE usage_activity_cells`;
    await setState(false, at(1)); // the rollup maintains nothing yet and every seeded cell is older
    const scope = { from: at(-46 * 1440), to: at(1), bucket: 'DAY' as const, timeZone: 'Asia/Kolkata', userId: alice.id };
    expect(await getUsageActivity(db, scope)).toEqual(await oracle(scope));
    expect(await cellCount()).toBe(0);
  });

  it('the triggers maintain cells on both sides of the boundary, and a mixed window still equals the raw scan', async () => {
    await setState(false, at(-10 * 1440));
    await seedMixed();
    const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM usage_activity_cells WHERE cell < ${naive(new Date(Math.ceil(at(-10 * 1440).getTime() / 900_000) * 900_000))}::timestamp`;
    expect(Number(n)).toBeGreaterThan(0); // maintained, but the reader does not trust them until complete
    const scope = { from: at(-46 * 1440), to: at(1), bucket: 'WEEK' as const, timeZone: 'UTC', memoryIds: [memX] };
    expect(await getUsageActivity(db, scope)).toEqual(await oracle(scope));
  });

  it('a change to an already rebuilt span before completion is not lost (delete, soft delete, move, backdated insert)', async () => {
    // #4320 item 5 (BLIND Dorian, d20dc14e): explicit timestamps replace the seedMixed lean. Four events sit in the
    // FIRST chunk, a marker one chunk later forces a second; the mutations run at afterChunk(1), when chunk 1 is
    // committed, and each mutated timestamp is ASSERTED to lie before that chunk's end — the committed boundary.
    await setState(false, at(-2870));
    await insert([-3000, -2998, -2996, -2994].map((m) => ({ userId: alice.id, memoryId: memX, createdAt: at(m) })));
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-2900) }]); // chunk 2's marker
    const chunk1End = Math.floor(at(-3000).getTime() / ROLLUP_CELL_MS) * ROLLUP_CELL_MS + 4 * ROLLUP_CELL_MS; // the job's own arithmetic: floorCell(first) + chunkCells cells
    for (const m of [-3000, -2998, -2996, -2997]) {
      expect(at(m).getTime(), `minute ${m} must lie in chunk 1`).toBeLessThan(chunk1End);
    }
    const rows = await db.usageEvent.findMany({ where: { userId: alice.id }, select: { id: true, createdAt: true } });
    const byTime = (m: number) => rows.find((e) => e.createdAt.getTime() === at(m).getTime())!;
    const result = await backfillUsageActivityRollup(db, {
      chunkCells: 4,
      afterChunk: async (i) => {
        if (i !== 1) return; // chunk 1 is committed now: change it behind the backfill
        await db.usageEvent.delete({ where: { id: byTime(-3000).id } });
        await db.usageEvent.update({ where: { id: byTime(-2998).id }, data: { deletedAt: new Date() } });
        await db.usageEvent.update({ where: { id: byTime(-2996).id }, data: { userId: bob.id } });
        await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-2997) }]); // backdated into the committed chunk
      },
    });
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect((await drift()).total).toBe(0);
    const scope = { from: at(-3020), to: at(-2860), bucket: 'DAY' as const, timeZone: 'UTC', userId: alice.id };
    expect(await getUsageActivity(db, scope)).toEqual(await oracle(scope));
  });

  it('two backfills at once take their chunks one after the other, and both end complete with no drift', async () => {
    // #4320 item 4 (BLIND Dorian, d20dc14e): Promise.allSettled alone never proved the runs overlap. The barrier holds
    // the STATE ROW locked from outside (no usage_events lock), so run A's first chunk takes its LOCK TABLE and then
    // blocks on that row — holding the table lock the whole time. Run B, started now, must wait at its own LOCK TABLE:
    // neither run completes a chunk until the barrier lifts. Both waits are asserted directly — A by a GRANTED
    // ShareRowExclusiveLock on usage_events, B by a NOT-granted one (its request queued behind A's); with the chunk's
    // LOCK TABLE removed, neither lock row appears and the granted assertion fails first.
    await setState(false, at(1));
    await seedMixed();
    const chunksOf = () => { let n = 0; return { get: () => n, after: async () => { n++; } }; };
    const a = chunksOf(), b = chunksOf();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let rowLocked!: () => void;
    const locked = new Promise<void>((r) => { rowLocked = r; });
    const stateRowHolder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM usage_activity_rollup_state WHERE id = 1 FOR UPDATE`;
      rowLocked();
      await held;
    });
    await locked; // the row lock is held before A starts, so A's first chunk cannot slip past the barrier
    const first = backfillUsageActivityRollup(db, { chunkCells: 5, afterChunk: a.after });
    // pg_locks lists the whole CLUSTER, and the per-worker test databases are clones of one template, so
    // 'usage_events'::regclass is the same OID in every one of them — a backfill parked in another worker's clone
    // would satisfy this without the database filter (#4358 READ, Braxton F3).
    const tableLockHeld = async (granted: boolean) => Number((await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND relation = 'usage_events'::regclass AND mode = 'ShareRowExclusiveLock' AND granted = ${granted}`)[0].n) > 0;
    for (let i = 0; i < 500 && !(await tableLockHeld(true)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await tableLockHeld(true)).toBe(true); // A is inside its first chunk: table lock held, blocked on the state row
    const second = backfillUsageActivityRollup(db, { chunkCells: 5, afterChunk: b.after });
    for (let i = 0; i < 500 && !(await tableLockHeld(false)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await tableLockHeld(false)).toBe(true); // B is parked AT ITS OWN LOCK TABLE, queued behind A's (#4358 READ, F2)
    expect(a.get()).toBe(0); // A still parked on the barrier inside chunk 1
    expect(b.get()).toBe(0); // …and B has completed nothing either: the chunks serialize
    release();
    await stateRowHolder;
    const runs = await Promise.allSettled([first, second]);
    expect(runs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await drift()).total).toBe(0);
    const [state] = await db.$queryRaw<Array<{ complete: boolean }>>`SELECT complete FROM usage_activity_rollup_state WHERE id = 1`;
    expect(state.complete).toBe(true);
  });

  it('a backfill chunk waits for a writer that is mid-transaction, and the cells still equal a recount', async () => {
    await setState(false, at(1));
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-3000) }]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const writerIn = new Promise<void>((r) => { inserted = r; });
    const writer = db.$transaction(async (tx) => {
      await tx.usageEvent.create({ data: { id: generateId(), type: 'write', userId: alice.id, memoryId: memX, createdAt: at(-2990) } });
      inserted();
      await held;
    });
    await writerIn;
    let finished = false;
    const backfill = backfillUsageActivityRollup(db).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 600));
    expect(finished).toBe(false); // the chunk is queued behind the writer's lock
    release();
    await writer;
    expect((await backfill).alreadyComplete).toBe(false);
    expect((await drift()).total).toBe(0);
  });

  it('a stale negative cell older than every event is rebuilt away', async () => {
    await setState(false, at(1));
    await db.$executeRaw`INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes) VALUES ('user', ${alice.id}, ${naive(new Date(Math.floor(T0 / 900_000) * 900_000 - 90 * 86_400_000))}::timestamp, -1, 0)`;
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-3000) }]);
    await backfillUsageActivityRollup(db);
    expect((await drift()).total).toBe(0);
  });

  it('a historical midnight with a non-quarter-hour offset answers from the raw rows', async () => {
    // Africa/Monrovia was UTC-0:44:30 until 1972-01-07: local midnight falls inside a 15-minute cell
    expect(Date.UTC(1971, 11, 31)).toBeLessThan(ROLLUP_MIN_MS);
    const t = (m: number) => new Date(Date.UTC(1971, 11, 31, 0, 44, 0) + m * 1000);
    await insert([{ userId: alice.id, memoryId: memX, createdAt: t(0) }, { userId: alice.id, memoryId: memX, createdAt: t(40) }, { userId: alice.id, memoryId: memX, createdAt: t(70) }]);
    for (const bucket of ['DAY', 'WEEK', 'MONTH'] as const) {
      const scope = { from: new Date(Date.UTC(1971, 11, 1)), to: new Date(Date.UTC(1972, 0, 3)), bucket, timeZone: 'Africa/Monrovia', userId: alice.id };
      expect(await getUsageActivity(db, scope)).toEqual(await oracle(scope));
    }
  });

  it('backfill fills history, is idempotent, repairs a planted bad cell, and flips complete', async () => {
    await setState(false, at(1)); // a deploy at T0+1min: later events are maintained, earlier history waits for the backfill
    await seedMixed();
    await db.$executeRaw`INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes) VALUES ('user', ${alice.id}, ${naive(new Date(Math.floor(T0 / 900_000) * 900_000 - 86_400_000))}::timestamp, -3, 9)
      ON CONFLICT (scope_kind, scope_id, cell) DO UPDATE SET reads = -3, writes = 9`;
    const first = await backfillUsageActivityRollup(db, { chunkCells: 7 });
    expect(first.alreadyComplete).toBe(false);
    expect(first.chunks).toBeGreaterThan(5);
    expect((await drift()).total).toBe(0);
    const [state] = await db.$queryRaw<Array<{ complete: boolean }>>`SELECT complete FROM usage_activity_rollup_state WHERE id = 1`;
    expect(state.complete).toBe(true);
    expect(await backfillUsageActivityRollup(db)).toEqual({ alreadyComplete: true, chunks: 0, cellsWritten: 0 });
    const scope = { from: at(-46 * 1440), to: at(1), bucket: 'MONTH' as const, timeZone: 'America/Los_Angeles', userId: bob.id };
    expect(await getUsageActivity(db, scope)).toEqual(await oracle(scope));
  });

  it('the drift check reports a corrupted cell and a missing cell, and repairs nothing', async () => {
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5000) }, { userId: alice.id, memoryId: memX, createdAt: at(-9000) }]);
    await db.$executeRaw`UPDATE usage_activity_cells SET reads = reads + 5 WHERE scope_kind = 'user'`;
    await db.$executeRaw`DELETE FROM usage_activity_cells WHERE scope_kind = 'memory' AND cell = (SELECT MIN(cell) FROM usage_activity_cells)`;
    const found = await drift();
    expect(found.total).toBe(3);
    expect(found.rows.map((r) => `${r.scopeKind}:${r.rollup.reads}/${r.recount.reads}`).sort()).toEqual(['memory:0/1', 'user:6/1', 'user:6/1']);
    expect((await drift()).total).toBe(3);
  });

  it('with no state row nothing is maintained and the reader uses the raw rows', async () => {
    await db.$executeRaw`DELETE FROM usage_activity_rollup_state`;
    await insert([{ userId: alice.id, memoryId: memX, createdAt: at(-5000) }]);
    expect(await cellCount()).toBe(0);
    const scope = { from: at(-7000), to: at(0), bucket: 'DAY' as const, timeZone: 'UTC', userId: alice.id };
    expect(await getUsageActivity(db, scope)).toEqual(await oracle(scope));
    expect((await getUsageActivity(db, scope))[0].reads).toBe(1);
    void ROLLUP_CELL_MS;
  });
});

describe('#2719 deployment shape', () => {
  it('the migration carries the invariants file byte for byte, and post-push includes it', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    const invariants = read('prisma/usage-activity-rollup-invariants.sql');
    expect(read('prisma/migrations/20261117300000_usage_activity_rollup/migration.sql')).toContain(invariants);
    expect(read('prisma/post-push.sql')).toContain('\\ir usage-activity-rollup-invariants.sql');
  });

  it('the migration creates the state row without scanning usage_events', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../../prisma/migrations/20261117300000_usage_activity_rollup/migration.sql', import.meta.url), 'utf8');
    const outsideFunctions = sql.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;\n/g, '');
    expect(outsideFunctions).not.toMatch(/FROM usage_events|UPDATE usage_events|INSERT INTO usage_activity_cells/);
  });
});
