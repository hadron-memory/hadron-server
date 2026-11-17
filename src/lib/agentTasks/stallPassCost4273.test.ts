/**
 * #4273 — the stall pass does not re-decide an episode whose alarm is already raised.
 *
 * `evaluateStalls` used to open a Serializable transaction and reload the task's inputs for EVERY due candidate on
 * every pass, to find the unique key (task, type, episode start) taken. On the #4271 seed that was 842 re-evaluations a
 * minute (35-41 s). A candidate is now skipped only where an alarm event with its own key exists; a candidate whose
 * episode is new (a reassignment, a restart, another rule) is still decided in its own transaction. The alarms raised
 * are the ones raised before (cor:agt:050:12-:20); only the work for the already-raised ones is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { evaluateStalls, loadStallInputs, raiseStallAlarm, stallCandidates, STALL_WINDOW_DEFAULTS } from './stall.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const at = (hhmm: string): Date => new Date(`2026-10-09T${hhmm}:00Z`);

let appId: string;
let ada: string;
let anne: string;
let liam: string;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Pass', urn: `pass-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 600_000 + n, githubUsername: `pass-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `pass-${n}.example:team` }, select: { id: true } })).id;
  const worker = async (name: string) => (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase() }, select: { id: true } })).id;
  ada = await worker('Ada');
  anne = await worker('Anne');
  liam = await worker('Liam');
});

const pending = (assignedAt: string, assignee = anne) =>
  db.agentTask.create({ data: { appId, title: 'T', createdAt: at('09:00'), ownerWorkerId: ada, assigneeWorkerId: assignee, assignedAt: at(assignedAt) }, select: { id: true } });

/** How many raising transactions (`raiseStallAlarm` opens one per candidate it decides) a pass opened. */
async function decisions(now: Date): Promise<{ raised: number; transactions: number }> {
  const spy = vi.spyOn(db, '$transaction');
  try {
    const raised = (await evaluateStalls(db, now)).length;
    return { raised, transactions: spy.mock.calls.filter((c) => (c[1] as { isolationLevel?: string } | undefined)?.isolationLevel === 'Serializable').length };
  } finally {
    spy.mockRestore();
  }
}

describe('#4273 — an already-raised episode is not decided again', () => {
  it('the first pass decides and raises the candidate; the next passes open no raising transaction and raise nothing', async () => {
    await pending('10:00');
    expect(await decisions(at('10:15'))).toEqual({ raised: 1, transactions: 1 });
    expect(await decisions(at('10:16'))).toEqual({ raised: 0, transactions: 0 });
    expect(await decisions(at('11:30'))).toEqual({ raised: 0, transactions: 0 });
    expect(await db.agentTeamEvent.count({ where: { type: 'stall.not-started' } })).toBe(1);
  });

  it('a reassignment is a NEW episode of the same rule: it is decided and raised, the old one stays', async () => {
    const t = await pending('10:00');
    await decisions(at('10:15'));
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: liam, assignedAt: at('11:05') } });
    expect(await decisions(at('11:19'))).toEqual({ raised: 0, transactions: 0 }); // the new window has not passed
    expect(await decisions(at('11:20'))).toEqual({ raised: 1, transactions: 1 });
    const rows = await db.agentTeamEvent.findMany({ where: { taskId: t.id, type: 'stall.not-started' }, orderBy: { createdAt: 'asc' }, select: { episodeStart: true, subjectWorkerId: true } });
    expect(rows).toEqual([{ episodeStart: at('10:00'), subjectWorkerId: anne }, { episodeStart: at('11:05'), subjectWorkerId: liam }]);
  });

  it('another RULE on the same task is decided even though the task has an alarm of a different type', async () => {
    const t = await pending('10:00');
    await decisions(at('10:15')); // not-started raised
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await db.session.create({ data: { id: generateId(), appId, workerId: anne, startedAt: at('10:20'), updatedAt: at('10:20') } });
    expect(await decisions(at('11:21'))).toEqual({ raised: 1, transactions: 1 });
    expect((await db.agentTeamEvent.findMany({ where: { taskId: t.id }, select: { type: true }, orderBy: { type: 'asc' } })).map((e) => e.type)).toEqual(['stall.no-progress', 'stall.not-started']);
  });

  it('an episode that ended and began again with the same start is the same key: still one alarm, never two', async () => {
    const t = await pending('10:00');
    await decisions(at('10:15'));
    // Same assignment instant restated (a no-op edit): the key is unchanged.
    await db.agentTask.update({ where: { id: t.id }, data: { assignedAt: at('10:00') } });
    expect(await decisions(at('10:40'))).toEqual({ raised: 0, transactions: 0 });
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id } })).toBe(1);
  });

  it('scale: with twelve alarms already raised, a settled pass opens no raising transaction (the cost does not follow the alarm count)', async () => {
    for (let i = 0; i < 12; i++) await pending('10:00', i % 2 ? anne : liam);
    expect(await decisions(at('10:15'))).toEqual({ raised: 12, transactions: 12 });
    expect(await decisions(at('10:16'))).toEqual({ raised: 0, transactions: 0 });
  });

  it('a whole tick (the tick itself) on a settled App reads, and writes, no new alarm', async () => {
    await pending('10:00');
    await taskStallTick(db, at('10:15'));
    const before = await db.agentTeamEvent.count();
    await taskStallTick(db, at('10:16'));
    expect(await db.agentTeamEvent.count()).toBe(before);
  });
});

describe('#4273 — the liveness aggregate runs with JIT off, locally to its transaction', () => {
  it('a read on the shared client turns JIT off inside its own transaction and leaks nothing to the pool', async () => {
    const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
    const spy = vi.spyOn(db, '$transaction');
    try {
      await loadWorkersActivity({ db } as unknown as Context, [anne], at('10:00'));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const [{ jit }] = await db.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
    expect(jit).toBe('on');
  });

  it('inside a caller\'s transaction it sets the flag for that transaction and opens no nested one', async () => {
    const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
    await db.$transaction(async (tx) => {
      await loadWorkersActivity({ db: tx } as unknown as Context, [anne], at('10:00'));
      const [{ jit }] = await tx.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
      expect(jit).toBe('off');
    });
  });
});

describe('#4273 — known limit: a pass that raises N new alarms is linear in N, with a bounded cost per raise', () => {
  it('each raise is one re-decision in its own transaction: at most 40 statements, however many tasks and alarms exist', async () => {
    // A first pass after downtime raises every due episode, one Serializable re-decision each (the stop fence is why raises are
    // not batched). Pinned: the statements per raise stay bounded (about 20 on the #4271 seed), so N raises cost ~N x 10 ms.
    for (let i = 0; i < 20; i++) await pending('10:00', i % 2 ? anne : liam);
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    let statements = 0;
    (logged as any).$on('query', () => { statements++; });
    try {
      const raised = (await evaluateStalls(logged as any, at('10:15'))).length;
      expect(raised).toBe(20);
      // The page's own reads are a constant (not per raise); allow 30 of them.
      expect(statements).toBeLessThanOrEqual(20 * 40 + 30);
    } finally {
      await logged.$disconnect();
    }
  });
});

describe('#4273 — acceptance 4(c): the rows a settled pass reads do not follow lifetime history', () => {
  /** Rows of `table` the transaction has read so far (its own counters; pg_stat_xact_*). */
  async function rowsRead(tx: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] }, table: string): Promise<number> {
    const [t] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0) AS n FROM pg_stat_xact_user_tables WHERE relname = '${table}'`);
    return Number(t?.n ?? 0);
  }

  async function seedHistory(from: number, finished: number) {
    const to = from + finished - 1;
    // Finished tasks of Liam, each with 20 progress events, and a long-ended session with usage events: all history.
    await db.$executeRaw`INSERT INTO agent_tasks (id, app_id, title, owner_worker_id, assignee_worker_id, assigned_at, started_at, finished_at, status, result_outcome, close_session_when_done, task_number, handle, updated_at, created_at)
      SELECT md5('h' || g), ${appId}, 'H', ${ada}, ${liam}, now() - interval '30 days', now() - interval '30 days', now() - interval '29 days', 'finished', 'succeeded', false, 100000 + g, 'AT' || (100000 + g), now() - interval '29 days', now() - interval '30 days'
      FROM generate_series(${from}, ${to}) g`;
    await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, task_id, actor_worker_id, payload, created_at)
      SELECT md5('he' || g || '.' || k), ${appId}, 'task.progress', md5('h' || g), ${liam}, '{}'::jsonb, now() - interval '29 days'
      FROM generate_series(${from}, ${to}) g, generate_series(1, 20) k`;
    // Each finished task also had a stall alarm in its day: history of the very type the raised-keys read looks for.
    await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
      SELECT md5('ha' || g), ${appId}, 'stall.not-started', md5('h' || g), ${liam}, 'alarm', '[]'::jsonb, '{}'::jsonb, now() - interval '30 days', now() - interval '30 days'
      FROM generate_series(${from}, ${to}) g`;
    const sid = generateId();
    await db.$executeRaw`INSERT INTO sessions (id, app_id, worker_id, started_at, updated_at, ended_at) VALUES (${sid}, ${appId}, ${liam}, now() - interval '20 days', now() - interval '20 days' + interval '1 hour', now() - interval '20 days' + interval '1 hour')`;
    await db.$executeRaw`INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
      SELECT md5('u' || ${sid} || g), 'llm.call', ${sid}, true, now() - interval '20 days' + (g || ' seconds')::interval FROM generate_series(1, ${finished * 5}) g`;
    await db.$executeRaw`ANALYZE agent_tasks`;
    await db.$executeRaw`ANALYZE agent_team_events`;
    await db.$executeRaw`ANALYZE usage_events`;
  }

  async function settledPassReads(): Promise<{ events: number; usage: number; tasks: number }> {
    return db.$transaction(async (tx) => {
      // Index-only scans are switched off so every row an index path visits is a counted heap fetch (else the counters would
      // read 0 for a covering index and the pin could not fail).
      await tx.$executeRaw`SET LOCAL enable_indexonlyscan = off`;
      expect(await evaluateStalls(tx as unknown as PrismaClient, new Date())).toEqual([]); // a settled pass raises nothing
      return { events: await rowsRead(tx, 'agent_team_events'), usage: await rowsRead(tx, 'usage_events'), tasks: await rowsRead(tx, 'agent_tasks') };
    });
  }

  it('a settled pass reads the same rows with 50 finished tasks of history as with 1,500 (bounded by the open work, not the history)', async () => {
    for (let i = 0; i < 6; i++) await pending('10:00', i % 2 ? anne : liam);
    await evaluateStalls(db, new Date());
    await seedHistory(1, 50);
    const small = await settledPassReads();
    await seedHistory(51, 1_450); // 1,500 finished tasks in all
    const large = await settledPassReads();
    // Never more than the small history read (the counters of a tiny table move with the plan chosen, so not equality), and
    // far below the history's own size (7,500 usage events, 30,000 task events).
    expect(large.usage).toBeLessThanOrEqual(small.usage + 10);
    expect(large.events).toBeLessThanOrEqual(small.events + 10);
    expect(large.usage).toBeLessThan(100);
    // The tasks table is read through the open-status index: history adds a bounded number of rows, never one per finished task.
    expect(large.tasks).toBeLessThan(small.tasks + 100);
    expect(large.events).toBeLessThan(200);
  }, 120_000);

  it('a task with 1,500 earlier alarm episodes costs a settled pass the same rows as a task with none (the read is the candidate\'s own key)', async () => {
    const t = await pending('10:00');
    await evaluateStalls(db, new Date()); // the current episode's alarm is raised
    const small = await settledPassReads();
    await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
      SELECT md5('old' || g), ${appId}, 'stall.not-started', ${t.id}, ${anne}, 'alarm', '[]'::jsonb, '{}'::jsonb, now() - interval '40 days', now() - interval '40 days' - (g || ' minutes')::interval
      FROM generate_series(1, 1500) g`;
    await db.$executeRaw`ANALYZE agent_team_events`;
    const large = await settledPassReads();
    expect(large.events).toBeLessThanOrEqual(small.events + 10);
  }, 60_000);
});

describe('#4273 — acceptance 4(c) on the WHOLE tick: session rows read do not follow ended-session history', () => {
  async function measureTickOnce(): Promise<number> {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', '-c enable_indexonlyscan=off -c enable_seqscan=off'); // every row an index path visits is a counted fetch; a test table is too small for the planner to prefer an index
    const read = async () => {
      const [r] = await db.$queryRaw<{ n: bigint }[]>`SELECT COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0) AS n FROM pg_stat_user_tables WHERE relname = 'sessions'`;
      return Number(r?.n ?? 0);
    };
    // Backend counters reach the shared view when a backend flushes them (on idle, or on exit), so wait until the figure
    // stops moving (two equal reads 600 ms apart) instead of trusting one fixed sleep: a loaded machine flushes late.
    const counted = async () => {
      let last = await read();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 600));
        const now = await read();
        if (now === last) return now;
        last = now;
      }
      return last;
    };
    const client = new PrismaClient({ datasourceUrl: url.toString() });
    await client.$connect();
    const before = await counted();
    await taskStallTick(client as any, new Date());
    await client.$disconnect(); // a backend's counters are flushed when it exits
    return (await counted()) - before;
  }

  /**
   * #4285: the smallest of three measurements of the same settled tick. The table counters are per table, so ANY other
   * statement on this database inside the window (a late counter flush from the pool, autovacuum, a fire-and-forget run left
   * by an earlier step) is added to the figure; noise only ever adds. A settled tick is idempotent, so its true cost is the
   * minimum, and a real regression (the whole history read) is in every measurement, so it still fails. Main run 43859882551
   * read 1484 once on a loaded shard while the same pin passed on every other run.
   */
  async function tickSessionRows(): Promise<number> {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) runs.push(await measureTickOnce());
    return Math.min(...runs);
  }

  async function endedSessions(from: number, count: number) {
    await db.$executeRaw`INSERT INTO sessions (id, app_id, worker_id, started_at, updated_at, ended_at)
      SELECT md5('es' || w || k), ${appId}, w, now() - ((100 + k) || ' days')::interval, now() - ((100 + k) || ' days')::interval + interval '1 hour', now() - ((100 + k) || ' days')::interval + interval '1 hour'
      FROM unnest(ARRAY[${anne}, ${liam}, ${ada}]::text[]) w, generate_series(${from}, ${from + count - 1}) k`;
    await db.$executeRaw`ANALYZE sessions`;
  }

  it('a settled whole tick reads the same session rows with 10 ended sessions per worker as with 400', async () => {
    for (let i = 0; i < 4; i++) await pending('10:00', i % 2 ? anne : liam);
    // Open sessions for the assignees: the rows that DO matter.
    for (const w of [anne, liam]) await db.session.create({ data: { id: generateId(), appId, workerId: w, startedAt: new Date(Date.now() - 3_600_000), updatedAt: new Date() } });
    await endedSessions(1, 10);
    await taskStallTick(db, new Date()); // settle: the first pass raises and records
    const small = await tickSessionRows();
    await endedSessions(11, 390);
    const large = await tickSessionRows();
    expect(large).toBeLessThanOrEqual(small + 20);
    expect(large).toBeLessThan(200); // 400 ended sessions x 3 workers = 1,200 rows of history per liveness read before
  }, 120_000);
});

describe('#4273 — the pruned session read answers exactly what the full read answered', () => {
  it('lastActiveAt, live, open and binding fields over open, overlapping, tied, deleted, auto-expired and out-of-order sessions', async () => {
    const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
    const now = at('12:00');
    const day = (d: number, h = 0) => new Date(at('12:00').getTime() - d * 86_400_000 + h * 3_600_000);
    const mk = (workerId: string, o: Record<string, unknown>) => db.session.create({ data: { id: generateId(), appId, workerId, ...o } as any });
    // anne: a long-lived ended session that overlaps the latest start, older ended ones, a tie, a deleted one, an auto-expired one.
    await mk(anne, { startedAt: day(40), updatedAt: day(30), endedAt: day(1) }); // overlaps the latest start: kept
    await mk(anne, { startedAt: day(20), updatedAt: day(19), endedAt: day(19) }); // ended before the latest start: pruned, beaten
    await mk(anne, { startedAt: day(3), updatedAt: day(3, 5), endedAt: day(2) });
    await mk(anne, { startedAt: day(3), updatedAt: day(3, 6), endedAt: day(2) }); // same end as the one above
    await mk(anne, { startedAt: day(0, -2), updatedAt: day(0, -1), deletedAt: day(0) }); // deleted: counts for nothing
    await mk(anne, { startedAt: day(1, 2), updatedAt: day(1, 3), autoExpiredAt: day(1, 4), endedAt: day(1, 5) });
    await mk(anne, { startedAt: day(5), updatedAt: day(5) }); // open but quiet for days: bound, holds a binding, not live
    await mk(liam, { startedAt: day(0, -1), updatedAt: day(0, -1) }); // open and recent: live (the gate's row class)
    // liam: only ended sessions, the newest not the longest.
    await mk(liam, { startedAt: day(10), updatedAt: day(9), endedAt: day(8) });
    await mk(liam, { startedAt: day(5), updatedAt: day(5), endedAt: day(4) });
    await mk(liam, { startedAt: day(30), updatedAt: day(2), endedAt: day(2) }); // started long ago, ended last
    // ada: an open session and old ended ones.
    await mk(ada, { startedAt: day(0, -1), updatedAt: day(0, -1), family: 'claude', llmModel: 'm' });
    await mk(ada, { startedAt: day(9), updatedAt: day(9), endedAt: day(8) });
    const got = await loadWorkersActivity({ db } as unknown as Context, [anne, liam, ada], now);
    // The full read: every undeleted session, LEAST(GREATEST(started, updated unless auto-expired, usage), ended).
    const all = await db.session.findMany({ where: { workerId: { in: [anne, liam, ada] }, deletedAt: null } });
    for (const w of [anne, liam, ada]) {
      const times = all.filter((x) => x.workerId === w).map((x) => {
        const v = Math.max(x.startedAt.getTime(), x.autoExpiredAt || !x.updatedAt ? 0 : x.updatedAt.getTime());
        return x.endedAt ? Math.min(v, x.endedAt.getTime()) : v;
      });
      expect(got.get(w)?.lastActiveAt?.getTime()).toBe(Math.max(...times));
    }
    // The gate side (cor:agt:020:11) judges the SAME open rows with isSessionLive over the rows in hand; the SQL aggregate must
    // agree for every worker, whatever ended history surrounds the open sessions.
    const { isSessionLive } = await import('../sessionActivity.js');
    const openRows = await db.session.findMany({ where: { workerId: { in: [anne, liam, ada] }, endedAt: null, deletedAt: null } });
    for (const w of [anne, liam, ada]) {
      const mine = openRows.filter((x) => x.workerId === w);
      expect(got.get(w)?.hasLiveSession).toBe(mine.some((x) => isSessionLive(x as any, null, now)));
      expect(got.get(w)?.bound).toBe(mine.length > 0);
      expect(got.get(w)?.holdsOpenSession).toBe(mine.length > 0);
    }
    expect(got.get(anne)?.hasLiveSession).toBe(false);
    expect(got.get(liam)?.hasLiveSession).toBe(true);
    expect(got.get(ada)?.bound).toBe(true);
    expect(got.get(ada)?.bindingFamily).toBe('claude');
  });
});

describe('#4273 — what the skip replaces: a raise for an already-taken key refuses and writes nothing', () => {
  const writes = async () => ({
    events: await db.agentTeamEvent.count(),
    schedule: await db.agentTeamAlarmSchedule.count(),
    availability: await db.workerAvailability.count(),
  });

  async function candidateFor(taskId: string, now: Date) {
    const [inputs] = await loadStallInputs(db, { id: taskId }, now);
    return stallCandidates(inputs!, STALL_WINDOW_DEFAULTS, now).find((c) => c.rule === 'not-started')!;
  }

  for (const state of ['live', 'acknowledged', 'escalation ended'] as const) {
    it(`${state}: the old path (raiseStallAlarm) returns null and writes nothing, and the pass, which now skips it, writes nothing either`, async () => {
      const t = await pending('10:00');
      const now = at('10:15');
      const c = await candidateFor(t.id, now);
      expect(await raiseStallAlarm(db, c, now)).not.toBeNull(); // raised once
      const [alarm] = await db.agentTeamEvent.findMany({ where: { taskId: t.id } });
      if (state === 'acknowledged') await db.agentTeamEvent.update({ where: { id: alarm!.id }, data: { acknowledgedAt: at('10:20'), acknowledgedByWorkerId: ada } });
      if (state === 'escalation ended') await db.alarmEscalationEnd.create({ data: { eventId: alarm!.id, endedAt: at('10:30') } });
      const before = await writes();
      expect(await raiseStallAlarm(db, c, at('10:40'))).toBeNull(); // the refusal the skip replaces: the key is taken, in every state
      expect(await writes()).toEqual(before);
      expect(await evaluateStalls(db, at('10:40'))).toEqual([]);
      expect(await writes()).toEqual(before);
    });
  }
});
