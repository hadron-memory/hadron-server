import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import * as sessionActivity from '../../lib/sessionActivity.js';

/**
 * #4406: `loadLastEventBySession` costs one index descent per session id, not a GroupAggregate over every counted
 * event of those sessions (same class as #4397). The answer must not change (cor:agt:020:11 rules 1 and 3).
 * Plan and buffers are pinned under skewed, ANALYZEd statistics in a transaction that always rolls back.
 */
const HEAVY_ROWS = 60_000;

type Tx = Prisma.TransactionClient;
class RolledBack extends Error {}

async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: { value: T } | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        out = { value: await fn(tx) };
        throw new RolledBack();
      },
      { timeout: 120_000 },
    );
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  return out!.value;
}

async function seed(tx: Tx, heavy: number): Promise<void> {
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT 'ue4406-h-' || g, 'tool_call', 's4406-heavy', true, timestamp '2026-11-01 00:00:01' + g * interval '10 seconds'
    FROM generate_series(1, ${heavy}) g`);
  // Many small sessions, so the statistics are skewed like production's.
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT 'ue4406-s-' || g, 'tool_call', 's4406-small-' || (g % 400), true, timestamp '2026-10-01' + g * interval '1 second'
    FROM generate_series(1, 4000) g`);
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at) VALUES
      -- one counted row
      ('ue4406-one', 'tool_call', 's4406-one', true, '2026-11-12 08:00:00.123'),
      -- newest row is NOT counted: the newest COUNTED row wins (cor:agt:020:11 rule 3)
      ('ue4406-m1', 'tool_call', 's4406-mixed', true,  '2026-11-12 08:00:00'),
      ('ue4406-m2', 'tool_call', 's4406-mixed', false, '2026-11-16 08:00:00'),
      ('ue4406-m3', 'tool_call', 's4406-mixed', true,  '2026-11-10 08:00:00'),
      -- only uncounted rows: no entry, same as no rows
      ('ue4406-u1', 'tool_call', 's4406-uncounted', false, '2026-11-16 09:00:00'),
      -- a NULL session id is never an entry
      ('ue4406-n1', 'tool_call', NULL, true, '2026-11-16 09:00:00')`);
  await tx.$executeRawUnsafe('ANALYZE usage_events');
}

/** The groupBy the function ran before #4406: the reference answer. */
async function groupByAnswer(tx: Tx, ids: string[]): Promise<Map<string, Date | null>> {
  const rows = await tx.usageEvent.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: ids }, countsAsActivity: true },
    _max: { createdAt: true },
  });
  return new Map(rows.filter((r) => !!r.sessionId).map((r) => [r.sessionId as string, r._max.createdAt]));
}

interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Shared Hit Blocks': number; 'Shared Read Blocks': number; Plans?: PlanNode[] }
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];

async function analyze(tx: Tx, sql: Prisma.Sql): Promise<{ buffers: number; indexes: string[]; text: string }> {
  const rows = await tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  const root = rows[0]['QUERY PLAN'][0].Plan;
  const indexes = walk(root).flatMap((n) => (n['Index Name'] ? [n['Index Name']] : []));
  return { buffers: root['Shared Hit Blocks'] + root['Shared Read Blocks'], indexes, text: JSON.stringify(root) };
}

/** The pre-#4406 statement, for the control. */
const groupBySql = (ids: string[]): Prisma.Sql => Prisma.sql`
  SELECT session_id AS "sessionId", max(created_at) AS at FROM usage_events
  WHERE session_id IN (${Prisma.join(ids)}) AND counts_as_activity GROUP BY session_id`;

const IDS = ['s4406-heavy', 's4406-one', 's4406-mixed', 's4406-uncounted', 's4406-none', 's4406-small-3'];

describe('#4406 loadLastEventBySession: one index probe per session', () => {
  it('reads a bounded number of buffers however many counted rows a session holds', async () => {
    const r = await rolledBack(async (tx) => {
      await seed(tx, HEAVY_ROWS);
      await tx.$executeRaw`SELECT set_config('enable_incremental_sort', 'off', true)`;
      const fix = await analyze(tx, sessionActivity.lastEventBySessionSql(IDS));
      return { fix, groupBy: await analyze(tx, groupBySql(IDS)) };
    });
    expect(r.fix.indexes, r.fix.text).toContain('usage_events_session_activity_idx');
    // A probe's cost, not a scan's: the heavy session's 60k counted rows would be hundreds of pages.
    expect(r.fix.buffers, r.fix.text).toBeLessThan(150);
    // Not vacuous: the groupBy it replaces reads far more under the same skew.
    expect(r.groupBy.buffers).toBeGreaterThan(r.fix.buffers * 10);
  });

  it('the probe keys the session by a RANGE: without the session-keyed indexes it never walks created_at_idx, where an equality would', async () => {
    // With "= s.id" the planner treats session_id as a constant and drops it from ORDER BY, so "ORDER BY created_at DESC
    // LIMIT 1" can be served by walking usage_events_created_at_idx backwards (the 2026-10-14 outage). The range keeps
    // session_id in the sort. With both session-keyed indexes gone the equality shape has exactly one index path left.
    const WALK = 'usage_events_created_at_idx';
    const equality = (sql: Prisma.Sql): Prisma.Sql => {
      const from = 'x.session_id >= s.id AND x.session_id <= s.id';
      // Absent when the shipped text is already an equality: then the control below is the shipped plan itself.
      const strings = sql.strings.map((t) => t.replace(from, 'x.session_id = s.id'));
      return Prisma.sql(Object.assign(strings, { raw: strings }) as TemplateStringsArray, ...sql.values);
    };
    const plans = await rolledBack(async (tx) => {
      await seed(tx, 20_000);
      await tx.$executeRawUnsafe('DROP INDEX usage_events_session_activity_idx');
      await tx.$executeRawUnsafe('DROP INDEX usage_events_session_id_idx');
      return {
        shipped: await analyze(tx, sessionActivity.lastEventBySessionSql(IDS)),
        equality: await analyze(tx, equality(sessionActivity.lastEventBySessionSql(IDS))),
      };
    });
    expect(plans.equality.indexes, plans.equality.text).toContain(WALK);
    expect(plans.shipped.indexes, plans.shipped.text).not.toContain(WALK);
  });

  it('answers exactly what the groupBy answered: 0, 1 and many events, mixed counted rows, ids with none (cor:agt:020:11)', async () => {
    const r = await rolledBack(async (tx) => {
      await seed(tx, 300);
      return { got: await sessionActivity.loadLastEventBySession(tx as never, IDS), want: await groupByAnswer(tx, IDS) };
    });
    expect([...r.got.entries()].sort()).toEqual([...r.want.entries()].sort());
    // The shapes the answer turns on, stated rather than only compared:
    expect(r.got.get('s4406-one')?.toISOString()).toBe('2026-11-12T08:00:00.123Z');
    expect(r.got.get('s4406-mixed')?.toISOString()).toBe('2026-11-12T08:00:00.000Z');
    expect(r.got.has('s4406-uncounted')).toBe(false);
    expect(r.got.has('s4406-none')).toBe(false);
    expect(r.got.has('s4406-heavy')).toBe(true);
  });

  it('an empty id list issues no query and returns an empty map', async () => {
    expect((await sessionActivity.loadLastEventBySession(db as never, [])).size).toBe(0);
  });

  it('on the shared client it runs in ONE short transaction of its own: the plan setting never reaches the pool', async () => {
    const show = async (): Promise<string> => (await db.$queryRaw<{ s: string }[]>`SELECT current_setting('enable_incremental_sort') AS s`)[0].s;
    const before = await show();
    await sessionActivity.loadLastEventBySession(db as never, IDS);
    const seen = await Promise.all(Array.from({ length: 40 }, () => show()));
    for (const s of seen) expect(s).toBe(before);
  });

  it('on the shared client the whole read is one transaction, however many ids it asks about', async () => {
    const tx = vi.spyOn(db, '$transaction');
    try {
      await sessionActivity.loadLastEventBySession(db as never, IDS);
      expect(tx).toHaveBeenCalledTimes(1);
    } finally {
      tx.mockRestore();
    }
  });

  it('on a caller transaction client it opens no nested transaction and the setting stays local to that caller transaction', async () => {
    const inside = await rolledBack(async (tx) => {
      await seed(tx, 10);
      await sessionActivity.loadLastEventBySession(tx as never, IDS);
      return (await tx.$queryRaw<{ s: string }[]>`SELECT current_setting('enable_incremental_sort') AS s`)[0].s;
    });
    expect(inside).toBe('off');
    const after = (await db.$queryRaw<{ s: string }[]>`SELECT current_setting('enable_incremental_sort') AS s`)[0].s;
    expect(after).toBe('on');
  });
});
