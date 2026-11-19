/**
 * #4492 — the first-activity fold of `endedAlarmEpisodeInstants` (the roster's "has this woken alarm's episode ended"
 * read) takes the EARLIEST activity of the holder inside an episode window. It must find it with one index probe per
 * (window, session), not by reading every counted usage event after the window's start and taking min() of them: a
 * current holder's window runs to FOREVER, so on a long, dense session each window read the session's whole history
 * (measured on the harness: 300 windows, 30 s; the plan sorted 1.5 GB on disk).
 *
 * The scale pin counts the usage_events rows the read touches (pg_stat_xact_*, the transaction's own counters), not
 * wall time. The equivalence pins hold the answers the probe must keep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { endedAlarmEpisodeInstants } from './stall.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIN = 60_000;
let now: Date;
const ago = (min: number): Date => new Date(now.getTime() - min * MIN);

let appId: string;
let workerId: string;
let ownerId: string;
let userId: string;

async function task(opts: { assignedAt: Date; finishedAt: Date }): Promise<string> {
  return (await db.agentTask.create({
    data: { appId, title: 'T', ownerWorkerId: ownerId, assigneeWorkerId: workerId, assignedAt: opts.assignedAt, startedAt: opts.assignedAt, status: 'finished', resultOutcome: 'succeeded', finishedAt: opts.finishedAt, closeSessionWhenDone: false },
    select: { id: true },
  })).id;
}
async function session(s: { startedAt: Date; updatedAt: Date | null; endedAt?: Date | null; autoExpiredAt?: Date | null }): Promise<string> {
  const id = generateId();
  await db.$executeRaw`INSERT INTO sessions (id, app_id, worker_id, user_id, started_at, updated_at, ended_at, auto_expired_at)
    VALUES (${id}, ${appId}, ${workerId}, ${userId}, ${toNaiveUtc(s.startedAt)}::timestamp, ${s.updatedAt ? toNaiveUtc(s.updatedAt) : null}::timestamp,
            ${s.endedAt ? toNaiveUtc(s.endedAt) : null}::timestamp, ${s.autoExpiredAt ? toNaiveUtc(s.autoExpiredAt) : null}::timestamp)`;
  return id;
}
/** `count` counted usage events, one second apart, the FIRST at `first`. */
async function usage(sessionId: string, count: number, first: Date, opts: { newestFirst?: boolean } = {}) {
  // `newestFirst` writes the newest event first, so the heap order is NOT time order and a LIMIT 1 with no ORDER BY returns the wrong row.
  await db.$executeRaw`INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT md5(${sessionId} || g), 'llm.call', ${sessionId}, true, ${toNaiveUtc(first)}::timestamp + (g || ' seconds')::interval
    FROM generate_series(${opts.newestFirst ? count - 1 : 0}, ${opts.newestFirst ? 0 : count - 1}, ${opts.newestFirst ? -1 : 1}) g`;
}
const alarm = (taskId: string, episodeStart: Date) => ({ appId, taskId, type: 'stall.no-progress', episodeStart });

beforeEach(async () => {
  await cleanDb(db);
  now = new Date();
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Fold', urn: `fold-4492-${n}.example` }, select: { id: true, urn: true } });
  const person = await db.user.create({ data: { githubId: 44_920_000 + (n % 100_000), githubUsername: `fold-${n}`, roles: ['READER'] }, select: { id: true } });
  userId = person.id;
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team Agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' } });
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } })).id;
  const mk = async (name: string) => (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name, slug: name.toLowerCase() }, select: { id: true } })).id;
  ownerId = await mk('Lead');
  workerId = await mk('Dev');
});

describe('#4492: the first activity inside a window is found by a probe, not a range scan', () => {
  it('a dense open session adds a handful of usage rows per window, not its whole history', async () => {
    // One open session, 3,000 counted events from 95 minutes ago, one a second: all of them after every window start.
    const s = await session({ startedAt: ago(300), updatedAt: ago(1) });
    await usage(s, 3000, ago(95));
    // Three finished tasks the worker held, each an ended episode: three windows, each to FOREVER (the current holder).
    const ids: string[] = [];
    for (const m of [200, 150, 100]) ids.push(await task({ assignedAt: ago(m), finishedAt: ago(10) }));
    await db.$executeRaw`ANALYZE usage_events`;
    const alarms = ids.map((id, i) => alarm(id, ago([200, 150, 100][i]!)));
    const { read, ends } = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off');
      const [b] = await tx.$queryRaw<{ n: bigint }[]>`SELECT COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0) AS n FROM pg_stat_xact_user_tables WHERE relname = 'usage_events'`;
      const ends = await endedAlarmEpisodeInstants(tx as never, alarms, now);
      const [a] = await tx.$queryRaw<{ n: bigint }[]>`SELECT COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0) AS n FROM pg_stat_xact_user_tables WHERE relname = 'usage_events'`;
      return { read: Number(a?.n ?? 0) - Number(b?.n ?? 0), ends };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    // The first qualifying event of each window is one row; the old fold read all 3,000 per window (9,000).
    expect(read, `the fold touched ${read} usage_events rows for 3 windows`).toBeLessThanOrEqual(30);
    expect(ends.size).toBe(3);
  });
});

describe('#4492: the probe keeps every answer the fold gave', () => {
  it('the answer is the earliest of the session start, its heartbeat and its first in-window usage event', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    // Started and last driven BEFORE the window; its first event inside the window is the earliest in-window instant.
    const s = await session({ startedAt: ago(400), updatedAt: ago(150) });
    await usage(s, 50, ago(120));
    const ends = await endedAlarmEpisodeInstants(db, [alarm(t, ago(200))], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(150).getTime()]); // the heartbeat, inside (lo, hi]
  });

  it('a usage event after the session ended does not count, and a later in-bound event is not shadowed by it', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    // Ended 100 min ago with updated_at BEFORE the window; its only events are 60 min ago (past its end: ignored).
    const s = await session({ startedAt: ago(400), updatedAt: ago(250), endedAt: ago(100) });
    await usage(s, 5, ago(60));
    // A second, open session whose first in-window event is 30 min ago.
    const s2 = await session({ startedAt: ago(500), updatedAt: ago(240) });
    await usage(s2, 5, ago(30));
    const ends = await endedAlarmEpisodeInstants(db, [alarm(t, ago(200))], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(30).getTime()]);
  });

  it('events at or before the window start are not activity', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    const s = await session({ startedAt: ago(500), updatedAt: ago(400) });
    await usage(s, 10, ago(260)); // all before the window's lo (200 min ago)
    const ends = await endedAlarmEpisodeInstants(db, [alarm(t, ago(200))], now);
    // Nothing of the holder's counts in the window, so the episode ends at the task's own finish.
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(10).getTime()]);
  });
});

describe('#4492: more shapes the fold must keep', () => {
  it('the earliest event wins although the heap holds the newest first (the ORDER BY is load-bearing)', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    const s = await session({ startedAt: ago(400), updatedAt: ago(300) });
    await usage(s, 200, ago(120), { newestFirst: true });
    const ends = await endedAlarmEpisodeInstants(db, [alarm(t, ago(200))], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(120).getTime()]);
  });

  it('the ORDER BY holds without the index: with index paths off the heap order is the only order, so a missing ORDER BY returns a later event', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    const s = await session({ startedAt: ago(400), updatedAt: ago(300) });
    await usage(s, 200, ago(120), { newestFirst: true });
    const ends = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
      return endedAlarmEpisodeInstants(tx as never, [alarm(t, ago(200))], now);
    });
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(120).getTime()]);
  });

  it('an auto-expired session: its updated_at is not activity, so its first in-window event is', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    const s = await session({ startedAt: ago(400), updatedAt: ago(150), autoExpiredAt: ago(140) });
    await usage(s, 5, ago(90));
    const ends = await endedAlarmEpisodeInstants(db, [alarm(t, ago(200))], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(90).getTime()]);
  });

  it('a session with no activity in the window falls back to nothing: the episode ends at the task finish', async () => {
    const t = await task({ assignedAt: ago(200), finishedAt: ago(10) });
    await session({ startedAt: ago(400), updatedAt: ago(300) });
    const ends = await endedAlarmEpisodeInstants(db, [alarm(t, ago(200))], now);
    expect([...ends.values()].map((d) => d.getTime())).toEqual([ago(10).getTime()]);
  });
});

describe('#4492: differential against the statement as it was on main', () => {
  /** main's statement (e72841362), verbatim apart from the window list: one window per task, to FOREVER. */
  async function oracle(windows: { k: string; worker: string; lo: Date }[]): Promise<Map<string, number>> {
    const rows = await db.$queryRaw<{ k: string; t: Date }[]>`
      SELECT p.k AS "k", min(x.t) AS "t"
      FROM unnest(${windows.map((w) => w.k)}::text[], ${windows.map((w) => w.worker)}::text[],
                  ${windows.map((w) => toNaiveUtc(w.lo))}::timestamp[], ${windows.map(() => '9999-12-31T00:00:00.000')}::timestamp[]) AS p(k, worker_id, lo, hi)
      JOIN sessions s ON s.worker_id = p.worker_id AND s.deleted_at IS NULL
        AND (s.ended_at IS NULL OR s.ended_at > p.lo)
      CROSS JOIN LATERAL (
        SELECT s.started_at AS t
        UNION ALL SELECT s.updated_at WHERE s.auto_expired_at IS NULL
        UNION ALL SELECT e.created_at FROM usage_events e WHERE e.session_id = s.id AND e.counts_as_activity
          AND e.created_at > p.lo AND e.created_at <= p.hi
      ) x
      WHERE x.t > p.lo AND x.t <= p.hi AND (s.ended_at IS NULL OR x.t <= s.ended_at)
      GROUP BY p.k`;
    return new Map(rows.map((r) => [r.k, new Date(r.t).getTime()]));
  }

  it('matches main on a seeded random world: open, ended inside the window, auto-expired, quiet and dense sessions', async () => {
    let seed = 4492;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    // 14 sessions of random shape for the worker, minutes before now in [20, 600].
    for (let i = 0; i < 14; i++) {
      const start = 300 + rnd(300);
      const upd = start - rnd(start - 5);
      const ended = rnd(3) === 0 ? upd - rnd(Math.max(1, upd - 2)) : null; // 1 in 3 ended (at or after its last stamp when possible)
      const s = await session({
        startedAt: ago(start), updatedAt: rnd(5) === 0 ? null : ago(upd),
        endedAt: ended === null ? null : ago(Math.max(1, Math.min(ended, upd))), autoExpiredAt: rnd(4) === 0 ? ago(Math.max(1, upd - 1)) : null,
      });
      if (rnd(3) !== 0) await usage(s, 1 + rnd(40), ago(start - rnd(start - 2)), { newestFirst: rnd(2) === 0 });
    }
    const alarms: ReturnType<typeof alarm>[] = [];
    const windows: { k: string; worker: string; lo: Date }[] = [];
    const finishes = new Map<string, Date>();
    for (let i = 0; i < 12; i++) {
      const lo = ago(40 + rnd(500));
      const finishedAt = new Date(Math.min(lo.getTime() + (1 + rnd(240)) * MIN, now.getTime() - MIN));
      const id = await task({ assignedAt: lo, finishedAt });
      alarms.push(alarm(id, lo));
      windows.push({ k: id, worker: workerId, lo });
      finishes.set(id, finishedAt);
    }
    const want = await oracle(windows.map((w) => ({ ...w })).map((w) => ({ k: `${w.k}|${w.lo.getTime()}`, worker: w.worker, lo: w.lo })));
    const got = await endedAlarmEpisodeInstants(db, alarms, now);
    let compared = 0;
    let byActivity = 0;
    for (const a of alarms) {
      const first = want.get(`${a.taskId}|${a.episodeStart.getTime()}`);
      const expected = Math.min(first ?? Infinity, finishes.get(a.taskId)!.getTime());
      const actual = [...got.entries()].find(([k]) => k.includes(a.taskId))![1].getTime();
      expect(actual, `window lo=${a.episodeStart.toISOString()}`).toBe(expected);
      if (expected !== finishes.get(a.taskId)!.getTime()) byActivity++;
      compared++;
    }
    expect(compared).toBe(12);
    expect(byActivity, 'the world must have windows ended by activity and ones ended by the finish').toBeGreaterThan(0);
    expect(byActivity).toBeLessThan(12);
  });
});
