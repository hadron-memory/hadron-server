/**
 * #4271 — teamRoster's reads of usage history must not grow with every session a worker ever had.
 *
 * Measured cause (issue comment 6904529225): the worker-liveness aggregate (`workerActivitySql`) and the windowed
 * activity read in `endedAlarmEpisodeInstants` read every counted usage event of every session of the roster's
 * workers, several times per roster, so the roster's cost grew with the App's whole usage history until a burst of
 * them crossed the 20 s transaction budget. The fix reads usage events only where they can change an answer: an open
 * session, an ended session whose own stamps do not already cap its activity, and, for an alarm episode, the events
 * inside its window.
 *
 * The scale pin counts the usage_events rows ONE roster read touches (pg_stat_xact_*, the transaction's own
 * counters), not wall time, so it cannot flake on a busy machine. The equivalence pins hold every row class whose
 * usage events must still be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { workerActivitySql } from '../../api/graphql/schema/resolvers.worker.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { withRosterAppRead } from '../../api/graphql/schema/resolvers.agentTaskMatching.js';
import { loadTeamRoster } from './roster.js';
import { loadStallInputs } from './stall.js';
import { toNaiveUtc } from '../sessionActivity.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let app: { id: string };
let person: { id: string };
let agentId: string;
let now: Date;

const worker = async (name: string, extra: Record<string, unknown> = {}) =>
  (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), ...extra }, select: { id: true } })).id;

/** A session written straight to the table, so its stamps are exactly the test's. */
async function session(workerId: string, s: { startedAt: Date; updatedAt: Date | null; endedAt?: Date | null; autoExpiredAt?: Date | null }) {
  const id = generateId();
  await db.$executeRaw`INSERT INTO sessions (id, app_id, worker_id, user_id, started_at, updated_at, ended_at, auto_expired_at)
    VALUES (${id}, ${app.id}, ${workerId}, ${person.id}, ${toNaiveUtc(s.startedAt)}::timestamp, ${s.updatedAt ? toNaiveUtc(s.updatedAt) : null}::timestamp,
            ${s.endedAt ? toNaiveUtc(s.endedAt) : null}::timestamp, ${s.autoExpiredAt ? toNaiveUtc(s.autoExpiredAt) : null}::timestamp)`;
  return id;
}
/** `count` counted usage events of the session, the last at `last`, one second apart going back. */
async function usage(sessionId: string, count: number, last: Date) {
  await db.$executeRaw`INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT md5(${sessionId} || g), 'llm.call', ${sessionId}, true, ${toNaiveUtc(last)}::timestamp - (g || ' seconds')::interval
    FROM generate_series(0, ${count - 1}) g`;
}

/**
 * The usage_events rows the current transaction has read so far (its own counters). Index-only scans are switched
 * off for the measured read, so every row an index path visits is a counted heap fetch.
 */
async function usageRowsRead(tx: Prisma.TransactionClient): Promise<number> {
  const [t] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0) AS n FROM pg_stat_xact_user_tables WHERE relname = 'usage_events'`;
  return Number(t?.n ?? 0);
}

beforeEach(async () => {
  await cleanDb(db);
  now = new Date();
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Scale', urn: `scale-4271-${n}.example` }, select: { id: true, urn: true } });
  person = await db.user.create({ data: { githubId: 42_710_000 + (n % 100_000), githubUsername: `scale-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: person.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team' }, ctx(person.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
});

describe('#4271: one roster read touches usage history only where it can change an answer', () => {
  it('long-ended sessions with large histories add no usage rows to the read', async () => {
    const lead = await worker('Lead');
    const crew = [await worker('Ana', { reportsToWorkerId: lead }), await worker('Ben', { reportsToWorkerId: lead }), await worker('Cy', { reportsToWorkerId: lead })];
    // History: per worker, 10 sessions that ended days ago, each closed by its own end (updated_at = ended_at), with
    // 200 counted events each: 6,000 rows that cannot change any answer.
    for (const w of crew) {
      for (let d = 3; d < 13; d++) {
        const end = new Date(now.getTime() - d * DAY);
        await usage(await session(w, { startedAt: new Date(end.getTime() - HOUR), updatedAt: end, endedAt: end }), 200, new Date(end.getTime() - 60_000));
      }
    }
    // Ana is live now: one open session with 5 recent events.
    await usage(await session(crew[0]!, { startedAt: new Date(now.getTime() - HOUR), updatedAt: new Date(now.getTime() - 10 * 60_000) }), 5, new Date(now.getTime() - 60_000));
    // She holds a started task, so every liveness read of the roster (work states, availability, both stall-input
    // passes) asks about her.
    await db.agentTask.create({ data: { appId: app.id, title: 'A', ownerWorkerId: lead, assigneeWorkerId: crew[0]!, assignedAt: new Date(now.getTime() - HOUR), startedAt: new Date(now.getTime() - HOUR), status: 'started', closeSessionWhenDone: false } });
    // Ben's not-started alarm ended when he started the task an hour ago: the roster classifies it from his activity
    // in the episode's window (endedAlarmEpisodeInstants), which none of the old sessions overlaps.
    const at = new Date(now.getTime() - 3 * HOUR);
    const task = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerWorkerId: lead, assigneeWorkerId: crew[1]!, assignedAt: at, startedAt: new Date(now.getTime() - HOUR), status: 'started', closeSessionWhenDone: false }, select: { id: true } });
    const ev = generateId();
    await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
      VALUES (${ev}, ${app.id}, 'stall.not-started', ${task.id}, ${crew[1]!}, 'alarm', ${JSON.stringify([{ workerId: lead }])}::jsonb, '{}'::jsonb, ${toNaiveUtc(at)}::timestamp, ${toNaiveUtc(at)}::timestamp)`;
    await db.$executeRaw`INSERT INTO agent_team_alarm_schedule (event_id, chain_index, due_at, woken_at) VALUES (${ev}, 0, ${toNaiveUtc(at)}::timestamp, ${toNaiveUtc(at)}::timestamp)`;
    await db.$executeRaw`ANALYZE usage_events`;

    const { read, roster } = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off');
      const before = await usageRowsRead(tx);
      const roster = await loadTeamRoster(tx as any, app.id, now);
      return { read: (await usageRowsRead(tx)) - before, roster };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    // Ana's 5 open-session rows, read ONCE (one shared fold for the whole read; four separate folds would read 20),
    // and nothing from the 6,000-row history. Measured: 5.
    expect(read, `one roster read touched ${read} usage_events rows for 5 that can matter`).toBeLessThanOrEqual(10);
    const ana = roster.find((r) => r.name === 'Ana')!;
    expect(ana.liveSession).toBe(true);
    // The answer is the history's: Ben's last activity is the end of his newest ended session.
    expect(roster.find((r) => r.name === 'Ben')!.lastActiveAt?.getTime()).toBe(new Date(now.getTime() - 3 * DAY).getTime());
  });
});

describe('#4271: the liveness aggregate keeps every answer that depends on usage events', () => {
  const fold = async (workerId: string) =>
    (await db.$queryRaw<{ workerId: string; live: boolean; lastActiveAt: Date | null }[]>(workerActivitySql(Prisma.sql`w.id = ${workerId}`, now)))[0]!;

  it('an ended session not closed by its own stamps (updated_at before ended_at): a usage event inside it counts', async () => {
    const w = await worker('Dee');
    const end = new Date(now.getTime() - 2 * DAY);
    const s = await session(w, { startedAt: new Date(end.getTime() - 5 * HOUR), updatedAt: new Date(end.getTime() - 4 * HOUR), endedAt: end });
    await usage(s, 1, new Date(end.getTime() - HOUR));
    expect((await fold(w)).lastActiveAt?.getTime()).toBe(end.getTime() - HOUR);
  });

  it('an ended session with no updated_at (#4272 QA P2): a usage event inside it counts', async () => {
    const w = await worker('Ivy');
    const end = new Date(now.getTime() - 2 * DAY);
    const s = await session(w, { startedAt: new Date(end.getTime() - 5 * HOUR), updatedAt: null, endedAt: end });
    await usage(s, 1, new Date(end.getTime() - HOUR));
    expect((await fold(w)).lastActiveAt?.getTime(), 'a NULL updated_at made the guard skip a session it cannot prove closed').toBe(end.getTime() - HOUR);
  });

  it('an auto-expired session: its updated_at is not activity, so a usage event inside it counts', async () => {
    const w = await worker('Eve');
    const end = new Date(now.getTime() - 2 * DAY);
    const s = await session(w, { startedAt: new Date(end.getTime() - 5 * HOUR), updatedAt: end, endedAt: end, autoExpiredAt: end });
    await usage(s, 1, new Date(end.getTime() - 2 * HOUR));
    expect((await fold(w)).lastActiveAt?.getTime()).toBe(end.getTime() - 2 * HOUR);
  });

  it('an ended session closed by its own stamps: a late usage event is capped at the end, as before', async () => {
    const w = await worker('Fay');
    const end = new Date(now.getTime() - 2 * DAY);
    const s = await session(w, { startedAt: new Date(end.getTime() - 5 * HOUR), updatedAt: end, endedAt: end });
    await usage(s, 1, new Date(end.getTime() + HOUR));
    expect((await fold(w)).lastActiveAt?.getTime()).toBe(end.getTime());
  });

  it('an open session: its newest usage event is its activity and makes it live', async () => {
    const w = await worker('Gus');
    const s = await session(w, { startedAt: new Date(now.getTime() - 30 * DAY), updatedAt: new Date(now.getTime() - 30 * DAY) });
    await usage(s, 3, new Date(now.getTime() - 60_000));
    const r = await fold(w);
    expect(r.live).toBe(true);
    expect(r.lastActiveAt?.getTime()).toBe(now.getTime() - 60_000);
  });
});

describe('#4271 (gate acceptance 7): a person\'s activity counts only in its own App', () => {
  it('a call in App B does not count as the owner\'s reaction to a child ended in App A; a call in App A does', async () => {
    const b = await db.app.create({ data: { organizationId: (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId, name: 'B', urn: `b-${generateId()}.example:b` }, select: { id: true } });
    const w = await worker('Hal');
    const ended = new Date(now.getTime() - 2 * HOUR);
    const parent = await db.agentTask.create({ data: { appId: app.id, title: 'P', ownerUserId: person.id, assigneeWorkerId: w, assignedAt: ended, startedAt: ended, status: 'started', closeSessionWhenDone: false }, select: { id: true } });
    await db.agentTask.create({ data: { appId: app.id, title: 'C', ownerUserId: person.id, parentTaskId: parent.id, assigneeWorkerId: w, assignedAt: ended, startedAt: ended, finishedAt: ended, status: 'finished', resultOutcome: 'succeeded', closeSessionWhenDone: false } });
    const callIn = async (appId: string, at: Date) => {
      const t = await db.agentTask.create({ data: { appId, title: 'X', ownerUserId: person.id, closeSessionWhenDone: false }, select: { id: true } });
      await db.$executeRaw`INSERT INTO agent_team_events (id, app_id, type, task_id, actor_user_id, payload, created_at)
        VALUES (${generateId()}, ${appId}, 'task.progress', ${t.id}, ${person.id}, '{}'::jsonb, ${toNaiveUtc(at)}::timestamp)`;
    };
    const ownerActivity = async () => {
      const [i] = await loadStallInputs(db as any, { id: parent.id }, now);
      return i!.endedChildren[0]!.ownerActivityAt;
    };
    await callIn(b.id, new Date(now.getTime() - HOUR));
    expect(await ownerActivity(), 'a call in another App counted as the owner\'s reaction').toBeNull();
    await callIn(app.id, new Date(now.getTime() - 30 * 60_000));
    expect((await ownerActivity())?.getTime()).toBe(now.getTime() - 30 * 60_000);
  });
});

describe('#4271: the roster read runs without JIT', () => {
  it('inside withRosterAppRead the transaction has jit off; the next statement on the same pooled connection sees the default', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: person.id, role: 'member' } });
    // One connection, so the statement after the roster read runs on the very connection the read used.
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    const one = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const jit = async () => (await one.$queryRaw<{ jit: string; pid: number }[]>`SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid`)[0]!;
      const before = await jit();
      const inside = await withRosterAppRead({ db: one, userId: person.id, roles: ['READER'] } as unknown as Context, app.id, async (readCtx) =>
        (await readCtx.db.$queryRaw<{ jit: string; pid: number }[]>`SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid`)[0]!);
      const after = await jit();
      expect(inside.jit, 'the roster read JIT-compiles its aggregates').toBe('off');
      expect(new Set([before.pid, inside.pid, after.pid]).size, 'the three statements did not share one connection').toBe(1);
      expect(after.jit, 'jit=off outlived the roster read on its pooled connection').toBe(before.jit);
    } finally {
      await one.$disconnect();
    }
  });
});
