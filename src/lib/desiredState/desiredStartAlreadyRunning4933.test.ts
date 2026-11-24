/**
 * #4933 — the platform issues no `worker.start` for a worker whose Agent its host already runs (cor:agt:070:08 rev 21,
 * cor:agt:070:01). Pilot hadron-cli#2058 finding 10: clearing the leave-alone marker made the platform start the
 * worker every minute, and every start FAILED host-side ("an agent this host launched is still running").
 *
 * The host's report decides: the worker's stored terminal report names THIS host, is fresh, and shows an agent. The
 * "fake host" here fails every start it is issued, as the real one did, so a start issued on a pass shows as a failed
 * start before the next.
 *
 * Cast as in desiredStart4231.test.ts (Kit, LONG_LIVED, held by Bo, registered on orca1 with a worktree; sweep APPLY).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { declareAllStopLanes } from '../../test/stopLanes.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { AGENT_PRESENT_STATUSES, TERMINAL_REASONS, TERMINAL_STATUSES } from '../workerTerminal.js';
import { loadHostDesiredState } from './desiredState.js';
import { agentRunsOnAnyHost, LONG_HOLD_LOG_MS, pruneRunningLog, runningLogSize, TERMINAL_FUTURE_TOLERANCE_MS, resetDesiredStartStateLog, startDesiredWorker, startDesiredWorkers, START_FAILING_EVENT_TYPE, TERMINAL_FRESH_MS, terminalFreshMs } from './desiredStart.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// A pass-through wrapper, so a test can make one read fail (the "could not read every host" pins).
vi.mock('./desiredState.js', async (orig) => {
  const m = await orig<typeof import('./desiredState.js')>();
  return { ...m, loadHostDesiredState: vi.fn(m.loadHostDesiredState) };
});
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;

let org: { id: string; urn: string };
let admin: { id: string };
let bo: { id: string };
let app: { id: string };
let ada: { id: string };
let kit: { id: string };
let orca1: { id: string };

/** A second host, orca2, registering Kit in its own worktree. */
async function registerOrca2() {
  const k = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'efgh', label: 'orca2' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: k.id, scope: 'host:operate', hostId: 'orca2' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [
    { worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit2'] },
  ] } }, keyCtx(k));
}

const starts = (workerId = kit.id) => db.hostOperation.findMany({ where: { workerId, type: 'worker.start' }, orderBy: { issuedAt: 'asc' } });
const tick = (now = new Date()) => startDesiredWorkers(db, now);
const sweep = (mode: 'OFF' | 'OBSERVE' | 'APPLY') => M.setAppSweepMode({}, { appRef: app.id, mode }, ctx(admin.id));
const alarms = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: START_FAILING_EVENT_TYPE }, orderBy: { createdAt: 'asc' } });

/** A platform start of Kit that its host reported failed `minutesAgo` minutes ago. */
async function failedStart(minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.hostOperation.create({
    data: {
      id: generateId(), appId: app.id, hostId: 'orca1', type: 'worker.start', workerId: kit.id,
      args: { workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude' },
      status: 'failed', issuedBy: 'platform', issuedAt: at, collectedAt: at, finishedAt: at, failureReason: 'launcher exited 1',
      holdUserId: bo.id,
    },
  });
}

beforeEach(async () => {
  resetDesiredStartStateLog();
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'S-4933', urn: `s-4933-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 49_330_000 + k * 1000 + (n % 1000), githubUsername: `s-4933-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  bo = await u(2, 'bo');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const longAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: bo.id, role: 'member' } });
  const w = (agentId: string, name: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), ...extra }, select: { id: true } });
  ada = await w(longAgent, 'Ada');
  kit = await w(longAgent, 'Kit', { heldByUserId: bo.id, heldAt: new Date(), reportsToWorkerId: ada.id });
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [
    { worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] },
  ] } }, keyCtx(orca1));
  await declareAllStopLanes(db, app.id);
  await sweep('APPLY');
});

/** The terminal report a host stores for Kit (the stored shape; chk_workers_terminal_shape allows exactly these keys). */
async function report(o: { host?: string; status?: 'busy' | 'idle' | 'locked' | 'dark'; reason?: string | null; ageMs?: number } = {}) {
  const status = o.status ?? 'idle';
  const checkedAt = new Date(Date.now() - (o.ageMs ?? 30_000)).toISOString();
  const reason = o.reason !== undefined ? o.reason : status === 'locked' || status === 'dark' ? 'unrecognized' : null;
  await db.worker.update({
    where: { id: kit.id },
    data: { terminal: { host: { id: o.host ?? 'orca1', label: 'Orca 1' }, status, prompt: 'empty', reason, lastTurnAt: null, checkedAt, reportedAt: checkedAt } },
  });
}

/** The fake host: it fails every start it was issued, saying what the real host said. */
async function hostFailsIssuedStarts() {
  await db.hostOperation.updateMany({
    where: { workerId: kit.id, type: 'worker.start', status: 'issued' },
    data: { status: 'failed', finishedAt: new Date(), failureReason: 'an agent this host launched is still running' },
  });
}

describe('#4933: a cleared-marker worker whose agent the host already runs is not started every minute', () => {
  it('leave-alone cleared, agent running, no open session: five passes, no start, no failed start, no alarm', async () => {
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: true } }, ctx(admin.id));
    await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: false } }, ctx(admin.id));
    await report({ status: 'idle' });
    for (let i = 0; i < 5; i++) {
      await tick();
      await hostFailsIssuedStarts();
    }
    expect(await starts(), 'the platform issued a start for a worker whose agent its host already runs').toHaveLength(0);
    expect(await alarms()).toHaveLength(0);
  });

  it('the pass reports `running` for it, and counts no start', async () => {
    await report({ status: 'busy' });
    expect(await tick()).toBe(0);
    expect(await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, new Date())).toBe('running');
  });

  it('already running with three failed starts on record: still no start, and no failure alarm (it does not trip)', async () => {
    for (const m of [10, 20, 30]) await failedStart(m);
    await report({ status: 'idle' });
    await tick();
    expect(await starts()).toHaveLength(3);
    expect(await alarms(), 'an already-running worker was alarmed as a failing start').toHaveLength(0);
  });

  it.each(['rate_limited', 'unrecognized'])('a locked agent (reason %s) is still an agent the host runs: no start', async (reason) => {
    await report({ status: 'locked', reason });
    await tick();
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4933: when the host does not run the agent, the worker is started as before', () => {
  const startsWith = async () => {
    await tick();
    return (await starts()).length;
  };
  it('no terminal report yet', async () => {
    expect(await startsWith()).toBe(1);
  });
  it('dark', async () => {
    await report({ status: 'dark', reason: 'no_terminal' });
    expect(await startsWith()).toBe(1);
  });
  it.each(['no_terminal', 'bare_shell', 'no_agent'])('locked with the agent-absent reason %s', async (reason) => {
    await report({ status: 'locked', reason });
    expect(await startsWith()).toBe(1);
  });
  // The window is the reporting host's poll interval x the App's lapse check-ins (#4970 item 6): the test host polls
  // every 600 s and the default is 3 check-ins, so 30 minutes. It ages the REPORT (reportedAt), not the registration.
  const WINDOW = 600 * 3 * 1000;
  it('a report older than the derived window decides nothing', async () => {
    await report({ status: 'idle', ageMs: WINDOW + 60_000 });
    expect(await startsWith()).toBe(1);
  });
  it('a report older than the old 5-minute constant but inside the derived window still holds the worker', async () => {
    await report({ status: 'idle', ageMs: TERMINAL_FRESH_MS + 60_000 });
    expect(await startsWith()).toBe(0);
  });
  it('three failed starts still trip a worker the host does not run (the trip is unchanged)', async () => {
    for (const m of [10, 20, 30]) await failedStart(m);
    await tick();
    expect(await alarms()).toHaveLength(1);
  });
});

describe('#4970 item 6: the freshness window is derived from the reporting host\'s registration', () => {
  const win = async (terminal: Parameters<typeof terminalFreshMs>[2]) => terminalFreshMs(db, app.id, terminal);
  it('poll interval x the default 3 check-ins (600 s -> 30 minutes)', async () => {
    expect(await win({ host: { id: 'orca1' } })).toBe(30 * 60_000);
  });
  it('the App\'s own lapse check-ins count (2 -> 20 minutes)', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, hostLapseCheckIns: 2 } });
    expect(await win({ host: { id: 'orca1' } })).toBe(20 * 60_000);
  });
  it('the poll interval counts (a host that polls every 60 s -> 3 minutes)', async () => {
    await db.$executeRaw`UPDATE host_registrations SET poll_interval_seconds = 60 WHERE app_id = ${app.id} AND host_id = 'orca1'`;
    expect(await win({ host: { id: 'orca1' } })).toBe(3 * 60_000);
  });
  it('a report naming no host, or a host with no registration here, falls back to the constant', async () => {
    expect(await win({})).toBe(TERMINAL_FRESH_MS);
    expect(await win(null)).toBe(TERMINAL_FRESH_MS);
    expect(await win({ host: { id: 'orca7' } })).toBe(TERMINAL_FRESH_MS);
  });
  it('another App\'s registration of the same host id does not widen it', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
    expect(await terminalFreshMs(db, other.id, { host: { id: 'orca1' } })).toBe(TERMINAL_FRESH_MS);
  });
  it('the guard ages the report, not the registration: a registration refreshed just now does not keep a stale report fresh', async () => {
    await db.$executeRaw`UPDATE host_registrations SET refreshed_at = now() WHERE app_id = ${app.id} AND host_id = 'orca1'`;
    await report({ status: 'idle', ageMs: 31 * 60_000 });
    await tick();
    expect(await starts()).toHaveLength(1);
  });
  it('the window the App states decides the guard (2 check-ins: a 25-minute-old report no longer holds the worker)', async () => {
    await db.agentTaskStallSchedule.create({ data: { appId: app.id, hostLapseCheckIns: 2 } });
    await report({ status: 'idle', ageMs: 25 * 60_000 });
    await tick();
    expect(await starts()).toHaveLength(1);
  });
});

describe('#4933: agentRunsOnAnyHost, directly', () => {
  it('takes the window as an argument: the same report is fresh inside it and stale outside', () => {
    const now = new Date('2026-11-23T00:00:00Z');
    const rep = { host: { id: 'h' }, status: 'idle', reason: null, reportedAt: new Date(now.getTime() - 10 * 60_000).toISOString() };
    expect(agentRunsOnAnyHost(rep, now, 10 * 60_000)).toBe(true);
    expect(agentRunsOnAnyHost(rep, now, 10 * 60_000 - 1)).toBe(false);
    expect(agentRunsOnAnyHost(rep, now)).toBe(false);
  });
  const now = new Date('2026-11-23T00:00:00Z');
  const t = (o: Record<string, unknown>) => ({ host: { id: 'h' }, status: 'idle', reason: null, reportedAt: new Date(now.getTime() - 1000).toISOString(), ...o });
  it('says yes for a fresh busy, idle or locked report, from this host or any other', () => {
    for (const status of ['busy', 'idle', 'locked']) expect(agentRunsOnAnyHost(t({ status }), now)).toBe(true);
    expect(agentRunsOnAnyHost(t({ host: { id: 'anywhere-else' } }), now)).toBe(true);
  });
  it('says no for null, dark, an unknown status, a missing, junk, stale or future reportedAt', () => {
    expect(agentRunsOnAnyHost(null, now)).toBe(false);
    expect(agentRunsOnAnyHost(t({ status: 'dark' }), now)).toBe(false);
    expect(agentRunsOnAnyHost(t({ status: 'asleep' }), now)).toBe(false);
    expect(agentRunsOnAnyHost(t({ reportedAt: undefined }), now)).toBe(false);
    expect(agentRunsOnAnyHost(t({ reportedAt: 'junk' }), now)).toBe(false);
    expect(agentRunsOnAnyHost(t({ reportedAt: new Date(now.getTime() - TERMINAL_FRESH_MS - 1).toISOString() }), now)).toBe(false);
    expect(agentRunsOnAnyHost(t({ reportedAt: new Date(now.getTime() + 10 * 60_000).toISOString() }), now)).toBe(false);
  });
  it('the future tolerance is inclusive too', () => {
    expect(agentRunsOnAnyHost(t({ reportedAt: new Date(now.getTime() + TERMINAL_FUTURE_TOLERANCE_MS).toISOString() }), now)).toBe(true);
    expect(agentRunsOnAnyHost(t({ reportedAt: new Date(now.getTime() + TERMINAL_FUTURE_TOLERANCE_MS + 1).toISOString() }), now)).toBe(false);
  });
  it('the freshness boundary is inclusive', () => {
    expect(agentRunsOnAnyHost(t({ reportedAt: new Date(now.getTime() - TERMINAL_FRESH_MS).toISOString() }), now)).toBe(true);
  });
});

describe('#4933: the state is logged once when first seen and again when it changes', () => {
  const lines = (info: { mock: { calls: unknown[][] } }) => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[desired-start]'));
  it('three passes while it runs: one `already running` line; the agent goes away: one `starting` line; then nothing more', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await report({ status: 'idle' });
      await tick();
      await tick();
      await tick();
      expect(lines(info)).toHaveLength(1);
      expect(lines(info)[0]).toContain('(already running)');
      await report({ status: 'dark', reason: 'bare_shell' });
      await tick();
      await hostFailsIssuedStarts();
      await tick();
      expect(lines(info)).toHaveLength(2);
      expect(lines(info)[1]).toContain('(starting)');
      expect(await starts()).toHaveLength(2);
    } finally {
      info.mockRestore();
    }
  });

  it('an ordinary first start logs nothing; once its agent runs and the start fails, running is logged', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await tick();
      expect(lines(info)).toHaveLength(0);
      await hostFailsIssuedStarts();
      await report({ status: 'busy' });
      await tick();
      expect(lines(info)).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it('a pass that leaves `running` by any other outcome forgets it: running again is logged again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await report({ status: 'idle' });
      await tick();
      expect(lines(info)).toHaveLength(1);
      // Leave-alone makes the worker unstartable under the locks: the one worker's pass answers `skipped`, not `running`.
      await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: true } }, ctx(admin.id));
      expect(await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, new Date())).toBe('skipped');
      await M.setWorkerLeaveAlone({}, { input: { worker: kit.id, leaveAlone: false } }, ctx(admin.id));
      await tick();
      expect(lines(info), 'a state that was left and re-entered was not logged again').toHaveLength(2);
    } finally {
      info.mockRestore();
    }
  });

  it('a decision whose transaction then fails is not logged (the real transaction runs, then the commit is made to throw)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await report({ status: 'idle' });
      // The decision is made inside the real transaction, then the commit "fails": the caller must not have logged.
      const real = db.$transaction.bind(db) as (fn: unknown, opts?: unknown) => Promise<unknown>;
      const tx = vi.spyOn(db, '$transaction').mockImplementationOnce((async (fn: unknown, opts?: unknown) => {
        await real(fn, opts);
        throw new Error('commit failed');
      }) as never);
      expect(await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, new Date())).toBe('skipped');
      tx.mockRestore();
      expect(lines(info)).toHaveLength(0);
      await tick();
      expect(lines(info)).toHaveLength(1);
    } finally {
      info.mockRestore();
      err.mockRestore();
    }
  });
});

describe('#4933: a worker registered on two hosts, one of which runs its agent', () => {
  // The loop tries a worker's hosts in id order, so orca1 comes first whichever host reported.
  it.each(['orca1', 'orca2'])('the agent is on %s: no start on either host (no second agent)', async (host) => {
    await registerOrca2();
    await report({ status: 'idle', host });
    await tick();
    expect(await starts(), 'a second agent was started on the other host').toHaveLength(0);
  });

  it('the report is from a host the worker is not registered on: still no start (the agent is up somewhere)', async () => {
    await report({ status: 'idle', host: 'orca7' });
    await tick();
    expect(await starts()).toHaveLength(0);
  });

  it('the agent is gone (dark report): it starts, on the first host', async () => {
    await registerOrca2();
    await report({ status: 'dark', reason: 'no_terminal', host: 'orca2' });
    await tick();
    expect((await starts()).map((o) => o.hostId)).toEqual(['orca1']);
  });
});

describe('#4933: every terminal reason has a decided meaning, so a new one cannot slip in silently', () => {
  // When hadron-cli adds a reason, TERMINAL_REASONS gains it and the key check below fails until this table decides it.
  const table: Record<(typeof TERMINAL_REASONS)[number], boolean> = {
    model_at_capacity: false, token_budget_exhausted: false, rate_limited: false, guardrail_triggered: false, menu_or_question: false,
    shed_staged_not_relaunched: false, unrecognized: false, no_turn_for_due_ticker: false, no_terminal: true, bare_shell: true, no_agent: true,
    no_screen: false, multiple_terminals: false,
  };
  const absent = new Set(Object.entries(table).filter(([, v]) => v).map(([k]) => k));
  it('the table has exactly the reasons that exist', () => {
    expect(Object.keys(table).sort()).toEqual([...TERMINAL_REASONS].sort());
  });
  const now = new Date('2026-11-23T00:00:00Z');
  const t = (reason: string) => ({ host: { id: 'h' }, status: 'locked', reason, reportedAt: now.toISOString() });
  it.each([...TERMINAL_REASONS])('locked with %s', (reason) => {
    expect(agentRunsOnAnyHost(t(reason), now)).toBe(!absent.has(reason));
  });
  it('the table names only reasons that exist', () => {
    for (const r of absent) expect(TERMINAL_REASONS).toContain(r);
  });
});

describe('#4941: every terminal STATUS has a decided meaning (cor:agt:070:01), so a new one cannot slip in silently', () => {
  // When hadron-cli adds a status, TERMINAL_STATUSES gains it, the typed table below stops compiling and the key check
  // fails, until the new status is decided here (an unlisted status would otherwise read as "no agent" silently).
  const table: Record<(typeof TERMINAL_STATUSES)[number], boolean> = { busy: true, idle: true, locked: true, dark: false };
  const present = new Set(Object.entries(table).filter(([, v]) => v).map(([k]) => k));
  it('the table has exactly the statuses that exist', () => {
    expect(Object.keys(table).sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
  const now = new Date('2026-11-23T00:00:00Z');
  it.each([...TERMINAL_STATUSES])('status %s', (status) => {
    expect(agentRunsOnAnyHost({ host: { id: 'h' }, status, reason: null, reportedAt: now.toISOString() }, now)).toBe(present.has(status));
    expect(AGENT_PRESENT_STATUSES.has(status)).toBe(present.has(status));
  });
  it('the shared list names only statuses that exist', () => {
    for (const s of AGENT_PRESENT_STATUSES) expect(TERMINAL_STATUSES).toContain(s);
  });
});

describe('#4941: freshness is judged on reportedAt (the server\'s clock), not the host\'s checkedAt', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  const t = (checkedAt: Date, reportedAt: Date) => ({ host: { id: 'h' }, status: 'idle', reason: null, checkedAt: checkedAt.toISOString(), reportedAt: reportedAt.toISOString() });
  it('a host clock an hour slow (checkedAt old, reportedAt just now) still counts as running', () => {
    expect(agentRunsOnAnyHost(t(new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 1000)), now)).toBe(true);
  });
  it('a host clock an hour fast (checkedAt in the future, reportedAt just now) still counts as running', () => {
    expect(agentRunsOnAnyHost(t(new Date(now.getTime() + 3_600_000), new Date(now.getTime() - 1000)), now)).toBe(true);
  });
  it('a legacy row with a fresh checkedAt and no reportedAt decides nothing: the guard is off for it until its next report', () => {
    expect(agentRunsOnAnyHost({ host: { id: 'h' }, status: 'idle', reason: null, checkedAt: now.toISOString() } as never, now)).toBe(false);
  });
  it('a report the server stored long ago is stale even when its checkedAt looks fresh', () => {
    expect(agentRunsOnAnyHost(t(new Date(now.getTime() - 1000), new Date(now.getTime() - TERMINAL_FRESH_MS - 1)), now)).toBe(false);
  });
});

describe('#4941: the guard judges at the moment of the decision, not at the pass\'s start', () => {
  it('a report stored while the pass waited (reportedAt later than the pass `now` by more than the tolerance) still counts as running', async () => {
    await report({ status: 'idle', ageMs: 30_000 });
    // A pass whose `now` was taken ten minutes before its decision (the anchor says ten minutes of waits).
    const passNow = new Date(Date.now() - 10 * 60_000);
    const out = await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, passNow, performance.now() - 10 * 60_000);
    expect(out).toBe('running');
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4970 item 1: the pass passes its anchor to every worker it decides', () => {
  it('a slow pass (its `now` ten minutes before the decision) still reads a report stored mid-pass as running', async () => {
    await report({ status: 'idle', ageMs: 30_000 });
    // startDesiredWorkers, not startDesiredWorker: were the pass not to hand its anchor on, each worker would judge at
    // its own default anchor (about the pass's `now`), the report would read ten minutes in the future and a start would be issued.
    const passNow = new Date(Date.now() - 10 * 60_000);
    expect(await startDesiredWorkers(db, passNow, performance.now() - 10 * 60_000)).toBe(0);
    expect(await starts()).toHaveLength(0);
  });
});

describe('#4970 item 3: the failure count is judged at the moment of the decision too', () => {
  it('three failed starts finished while a slow pass waited (after its `now`, before its decision) trip the worker', async () => {
    for (const m of [1, 2, 3]) await failedStart(m);
    const passNow = new Date(Date.now() - 10 * 60_000);
    expect(await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, passNow, performance.now() - 10 * 60_000)).toBe('tripped');
  });
});

describe('#4941: a pass that could not read every host keeps the log', () => {
  const held = async () => {
    await report({ status: 'idle' });
    await tick();
    expect(runningLogSize()).toBe(1);
  };
  it('listing an App\'s hosts fails: the held worker stays in the log', async () => {
    let q: { mockRestore: () => void } | undefined;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await held();
      // Reject only the host list (the one query naming host_registrations UNION host_worker_assignments), so the injected
      // failure is the one the test names; every other raw query runs.
      const real = db.$queryRaw.bind(db) as (...a: unknown[]) => Promise<unknown>;
      let consumed = 0;
      q = vi.spyOn(db, '$queryRaw').mockImplementation(((...a: unknown[]) => {
        const text = Array.isArray(a[0]) ? (a[0] as string[]).join('?') : String((a[0] as { sql?: string })?.sql ?? '');
        if (consumed === 0 && text.includes('host_worker_assignments') && text.includes('UNION')) {
          consumed++;
          return Promise.reject(new Error('hosts list failed'));
        }
        return real(...a);
      }) as never);
      await tick();
      expect(consumed, 'the injected failure was never reached').toBe(1);
      expect(err.mock.calls.some((c) => String(c[0]).includes('listing an App\'s hosts failed') && (c[1] as { appId?: string })?.appId === app.id)).toBe(true);
      expect(runningLogSize()).toBe(1);
    } finally {
      q?.mockRestore();
      err.mockRestore();
      info.mockRestore();
    }
  });
  it('reading one host\'s desired state fails: the held worker stays in the log', async () => {
    const realLoad = vi.mocked(loadHostDesiredState).getMockImplementation()!;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await held();
      let consumed = 0;
      vi.mocked(loadHostDesiredState).mockImplementation(async (...a) => {
        if (consumed === 0) {
          consumed++;
          throw new Error('read failed');
        }
        return realLoad(...a);
      });
      await tick();
      expect(consumed, 'the injected failure was never reached').toBe(1);
      expect(err.mock.calls.some((c) => String(c[0]).includes('reading a host\'s desired state failed') && (c[1] as { appId?: string; hostId?: string })?.hostId === 'orca1')).toBe(true);
      expect(runningLogSize()).toBe(1);
    } finally {
      vi.mocked(loadHostDesiredState).mockImplementation(realLoad);
      err.mockRestore();
      info.mockRestore();
    }
  });
});

describe('#4941: the log of what was seen', () => {
  const lines = (info: { mock: { calls: unknown[][] } }) => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[desired-start]'));
  const reportAt = (at: Date, status: 'idle' | 'dark' = 'idle', host = 'orca1') =>
    db.worker.update({
      where: { id: kit.id },
      data: { terminal: { host: { id: host, label: host }, status, prompt: 'empty', reason: status === 'dark' ? 'no_terminal' : null, lastTurnAt: null, checkedAt: at.toISOString(), reportedAt: at.toISOString() } },
    });

  it('`starting` is logged when an earlier host answers no-host and a later host takes the start (it was forgotten silently)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await registerOrca2();
      await report({ status: 'idle', host: 'orca2' });
      await tick();
      expect(lines(info)).toHaveLength(1);
      // orca1 stops refreshing (its registration lapses); the agent goes away: orca1 answers no-host, orca2 takes the start.
      await db.$executeRaw`UPDATE host_registrations SET refreshed_at = now() - interval '2 days' WHERE app_id = ${app.id} AND host_id = 'orca1'`;
      await report({ status: 'dark', reason: 'no_terminal', host: 'orca2' });
      await tick();
      expect((await starts()).map((o) => o.hostId)).toEqual(['orca2']);
      expect(lines(info).map((l) => l.match(/\((already running|starting)\)/)?.[1])).toEqual(['already running', 'starting']);
    } finally {
      info.mockRestore();
    }
  });

  it('a worker held for a long time gets ONE long-hold line, and is still never started', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const t0 = new Date();
      for (const at of [t0, new Date(t0.getTime() + LONG_HOLD_LOG_MS - 60_000), new Date(t0.getTime() + LONG_HOLD_LOG_MS), new Date(t0.getTime() + LONG_HOLD_LOG_MS + 60 * 60_000)]) {
        await reportAt(new Date(at.getTime() - 1000));
        // Each pass must answer `running` itself: were the guard off, the lapsed registration would answer `no-host` and
        // an empty starts() would prove nothing.
        expect(await startDesiredWorker(db, { appId: app.id, workerId: kit.id, hostId: 'orca1' }, at)).toBe('running');
        await startDesiredWorkers(db, at);
      }
      expect(lines(info).map((l) => l.match(/\(([a-z ]+)\)$/)?.[1])).toEqual(['already running', 'held a long time']);
      expect(await starts(), 'a long hold must never start the worker').toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('a worker no longer startable (sweep OFF stands in for deleted or retired) is pruned from the log by the next pass', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await report({ status: 'idle' });
      await tick();
      expect(runningLogSize()).toBe(1);
      await sweep('OFF');
      await tick();
      expect(runningLogSize()).toBe(0);
    } finally {
      info.mockRestore();
    }
  });

  it('pruneRunningLog removes exactly the workers it is not told to keep', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await report({ status: 'idle' });
      await tick();
      pruneRunningLog(new Set([kit.id]));
      expect(runningLogSize()).toBe(1);
      pruneRunningLog(new Set(['someone-else']));
      expect(runningLogSize()).toBe(0);
    } finally {
      info.mockRestore();
    }
  });
});
