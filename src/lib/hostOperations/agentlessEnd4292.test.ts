/**
 * #4292 (S15 of the Team on Orca epic, #4229) — the host ends an open SHORT_LIVED session after proving no agent runs.
 *
 * Test run AT0.7687 (orca1, 2026-11-16): a short-lived agent finished its task and exited without ending its session;
 * the platform's `worker.end` came on time and the host reported it FAILED (no agent to ask), so under cor:agt:020:10
 * the session stayed open with no agent, indefinitely, and the worker could never be started again.
 *
 * The rule (Proposed amendment to cor:agt:050:10, a third explicit end; cross-referenced from 070:05): the host that
 * runs a SHORT_LIVED worker, which is the assignee of no PENDING or STARTED task, ends its open session on the closed
 * proof AGENT_ABSENT. Two entry points run ONE function: a `worker.end` reported FAILED with that reason, and the
 * host's own `endAgentlessSession`. The end is recorded `endReason: agent_absent`, without a handoff, so the next bind
 * reads continuity MISSING. Lock order: the per-worker assignment lock, then the session row, then the checks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { setUpResetFixture, code, ctx, type ResetFixture } from '../../test/contextResetFixture.js';
import { generateId } from '../id.js';
import { sweepSessionEndRequests } from './sessionEnd.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { HANDOFFS_PARENT_LOC, HANDOFF_SESSION_KEY } from '../workerHandoff.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const F = resolvers as any;

let f: ResetFixture;

const setLifecycle = (lifecycle: 'LONG_LIVED' | 'SHORT_LIVED') => db.agent.update({ where: { id: f.agentId }, data: { lifecycle } });
const sessionOf = (id: string = f.session.id) => db.session.findUniqueOrThrow({ where: { id }, select: { endedAt: true, endReason: true } });
const opOf = (id: string) => db.hostOperation.findUniqueOrThrow({ where: { id } });

/** A `worker.end` of Kit's session issued to `hostId` and collected by it. */
async function collectedEnd(hostId = 'orca1', key: { id: string } = f.orca1, sessionId = f.session.id): Promise<string> {
  const id = generateId();
  await db.hostOperation.create({
    data: { id, appId: f.app.id, hostId, type: 'worker.end', args: { workerId: f.kit.id, sessionId }, workerId: f.kit.id, issuedBy: 'platform' },
  });
  await M.collectHostOperations({}, { appRef: f.app.id }, f.keyCtx(key));
  expect((await opOf(id)).status).toBe('collected');
  return id;
}
const reportFailed = (id: string, failureReason = 'AGENT_ABSENT', key: { id: string } = f.orca1) =>
  M.reportHostOperation({}, { input: { appRef: f.app.id, id, outcome: 'FAILED', failureReason } }, f.keyCtx(key));
const endAgentless = (input: Record<string, unknown> = {}, key: { id: string } = f.orca1) =>
  M.endAgentlessSession({}, { input: { appRef: f.app.id, workerRef: f.kit.id, sessionId: f.session.id, reason: 'AGENT_ABSENT', ...input } }, f.keyCtx(key));
/** A task assigned to Kit in `status`, written directly (no launch, no wake). */
const taskOfKit = (status: 'pending' | 'started' | 'finished', parentId?: string) =>
  db.agentTask.create({
    data: {
      appId: f.app.id, title: `Kit ${status}`, ownerUserId: f.manager.id, assigneeWorkerId: f.kit.id, status, assignedAt: new Date(),
      closeSessionWhenDone: false, ...(status !== 'pending' ? { startedAt: new Date() } : {}), ...(status === 'finished' ? { finishedAt: new Date(), resultOutcome: 'succeeded' } : {}),
      ...(parentId ? { parentTaskId: parentId } : {}),
    },
    select: { id: true },
  });

beforeEach(async () => {
  f = await setUpResetFixture();
  await setLifecycle('SHORT_LIVED');
  // No context reset in the way: the finish asks only for the session end.
  await db.agent.update({ where: { id: f.agentId }, data: { resetContextAfterTask: false } });
});

describe('entry 1: worker.end reported FAILED with AGENT_ABSENT (cor:agt:020:10, 050:10 Proposed)', () => {
  it('run 2\'s shape: task finished, the platform\'s worker.end after the grace, reported FAILED AGENT_ABSENT: the session ends, the op SUCCEEDED, handoff false', async () => {
    const t = await f.startedTask();
    await f.finish(t.id);
    const [req] = await db.taskSessionEndRequest.findMany({ where: { taskId: t.id } });
    expect(await sweepSessionEndRequests(db, req!.dueAt)).toBe(1);
    const [op] = await db.hostOperation.findMany({ where: { type: 'worker.end' } });
    await M.collectHostOperations({}, { appRef: f.app.id }, f.keyCtx());
    const reported = await reportFailed(op!.id, 'AGENT_ABSENT: no agent process found in the worktree');
    expect(reported, 'a proven agentless worker.end must read SUCCEEDED').toMatchObject({ status: 'succeeded', result: { handoff: false }, failureReason: null });
    const s = await sessionOf();
    expect(s.endedAt, 'the session stayed open after a proven agentless worker.end').not.toBeNull();
    expect(s.endReason).toBe('agent_absent');
    expect(await db.agentTeamEvent.count({ where: { type: 'host.operation.succeeded' } })).toBe(1);
  });

  it('the exact code with nothing after it is the proof too', async () => {
    const op = await collectedEnd();
    expect(await reportFailed(op)).toMatchObject({ status: 'succeeded', result: { handoff: false } });
    expect((await sessionOf()).endReason).toBe('agent_absent');
  });

  it('with an open STARTED task: the session stays open and the op FAILED (today\'s behaviour)', async () => {
    await f.startedTask();
    const op = await collectedEnd();
    expect(await reportFailed(op)).toMatchObject({ status: 'failed', failureReason: 'AGENT_ABSENT' });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('with an open PENDING task: the session stays open and the op FAILED', async () => {
    await taskOfKit('pending');
    const op = await collectedEnd();
    expect(await reportFailed(op)).toMatchObject({ status: 'failed' });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a STARTED task waiting on its open children (050:10 G7): the session stays open', async () => {
    const parent = await taskOfKit('started');
    await db.agentTask.create({ data: { appId: f.app.id, title: 'Child', ownerUserId: f.manager.id, parentTaskId: parent.id, status: 'pending', closeSessionWhenDone: false } });
    const op = await collectedEnd();
    expect(await reportFailed(op)).toMatchObject({ status: 'failed' });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a LONG_LIVED worker: the session stays open and the op FAILED', async () => {
    await setLifecycle('LONG_LIVED');
    const op = await collectedEnd();
    expect(await reportFailed(op)).toMatchObject({ status: 'failed' });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a host that no longer registers the worker: the session stays open and the op FAILED', async () => {
    const op = await collectedEnd();
    await f.register(f.orca1, { workers: [f.ada.id] });
    expect(await reportFailed(op)).toMatchObject({ status: 'failed' });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a free-text failure reason, or a code that only starts like it: today\'s behaviour (FAILED, stays open)', async () => {
    for (const reason of ['not asked to end; no end prompt configured; no agent process found', 'AGENT_ABSENTEE', 'agent_absent']) {
      const op = await collectedEnd();
      expect(await reportFailed(op, reason)).toMatchObject({ status: 'failed', failureReason: reason });
      expect((await sessionOf()).endedAt).toBeNull();
    }
  });

  it('a reported failure on a session that already ended still reads SUCCEEDED and changes nothing (unchanged)', async () => {
    const op = await collectedEnd();
    const endedAt = new Date(Date.now() - 1000);
    await db.session.update({ where: { id: f.session.id }, data: { endedAt, endReason: 'ended' } });
    expect(await reportFailed(op)).toMatchObject({ status: 'succeeded' });
    expect(await sessionOf()).toEqual({ endedAt, endReason: 'ended' });
  });
});

describe('entry 2: endAgentlessSession, the host\'s own end', () => {
  it('under the conditions: ends the session, agent_absent, handoff false; the use is recorded', async () => {
    const t = await f.startedTask();
    await f.finish(t.id);
    expect(await endAgentless()).toEqual({ sessionId: f.session.id, ended: true, handoff: false });
    expect((await sessionOf()).endReason).toBe('agent_absent');
    expect(await db.hostKeyUse.count({ where: { appKeyId: f.orca1.id, action: 'session', refusedCode: null } })).toBe(1);
  });

  it('a session that already ended answers ended: false and writes nothing', async () => {
    const endedAt = new Date(Date.now() - 1000);
    await db.session.update({ where: { id: f.session.id }, data: { endedAt, endReason: 'ended' } });
    expect(await endAgentless()).toEqual({ sessionId: f.session.id, ended: false, handoff: false });
    expect(await sessionOf()).toEqual({ endedAt, endReason: 'ended' });
  });

  it('a second call after the end answers ended: false', async () => {
    await endAgentless();
    const first = await sessionOf();
    expect(await endAgentless()).toMatchObject({ ended: false });
    expect(await sessionOf()).toEqual(first);
  });

  it('an open STARTED task: WORKER_HAS_OPEN_TASK naming it; the session stays open', async () => {
    const t = await f.startedTask();
    await expect(endAgentless()).rejects.toMatchObject({ extensions: { code: 'WORKER_HAS_OPEN_TASK', taskId: t.id } });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a STARTED task waiting on its open children (050:10 G7): WORKER_HAS_OPEN_TASK', async () => {
    const parent = await taskOfKit('started');
    await db.agentTask.create({ data: { appId: f.app.id, title: 'Child', ownerUserId: f.manager.id, parentTaskId: parent.id, status: 'pending', closeSessionWhenDone: false } });
    expect(await code(endAgentless())).toBe('WORKER_HAS_OPEN_TASK');
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a finished task does not hold the session', async () => {
    await taskOfKit('finished');
    expect(await endAgentless()).toMatchObject({ ended: true });
  });

  it('a LONG_LIVED worker: WORKER_NOT_SHORT_LIVED', async () => {
    await setLifecycle('LONG_LIVED');
    expect(await code(endAgentless())).toBe('WORKER_NOT_SHORT_LIVED');
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a host that does not run the worker: HOST_DOES_NOT_RUN_WORKER, the session stays open, the refusal is recorded', async () => {
    const orca2 = await f.hostKey('orca2');
    await f.register(orca2, { workers: [f.ada.id] });
    expect(await code(endAgentless({}, orca2))).toBe('HOST_DOES_NOT_RUN_WORKER');
    // orca2 registers nothing at all: the same refusal.
    const orca3 = await f.hostKey('orca3');
    expect(await code(endAgentless({}, orca3))).toBe('HOST_DOES_NOT_RUN_WORKER');
    expect((await sessionOf()).endedAt).toBeNull();
    expect(await db.hostKeyUse.count({ where: { appKeyId: orca2.id, refusedCode: 'HOST_DOES_NOT_RUN_WORKER' } })).toBe(1);
  });

  it('a server-held setup (#4222): only the host the worker is assigned to, with its workdir confirmed, runs it', async () => {
    await db.hostRegistrationWorker.updateMany({ where: { workerId: f.kit.id }, data: { worktrees: ['kit'] } });
    await db.app.update({ where: { id: f.app.id }, data: { hostSetupSource: 'server' } });
    const assign = (hostId: string) => db.hostWorkerAssignment.create({
      data: { id: generateId(), appId: f.app.id, hostId, workerId: f.kit.id, workdir: 'kit', family: 'claude', createdByUserId: f.manager.id },
    });
    // orca1's registration lists Kit, but the platform assigned Kit to orca2.
    const elsewhere = await assign('orca2');
    expect(await code(endAgentless())).toBe('HOST_DOES_NOT_RUN_WORKER');
    expect((await sessionOf()).endedAt).toBeNull();
    // Assigned to orca1 instead: it runs Kit.
    await db.hostWorkerAssignment.delete({ where: { id: elsewhere.id } });
    await assign('orca1');
    expect(await endAgentless()).toMatchObject({ ended: true });
  });

  it('a worker of no App or another App reads HOST_DOES_NOT_RUN_WORKER (no oracle)', async () => {
    expect(await code(endAgentless({ workerRef: generateId() }))).toBe('HOST_DOES_NOT_RUN_WORKER');
  });

  it('a session that is not the worker\'s (another worker\'s, or none): SESSION_NOT_WORKERS', async () => {
    const adaSession = await f.bind(f.ada);
    await f.register(f.orca1, { workers: [f.kit.id, f.ada.id] });
    expect(await code(endAgentless({ sessionId: adaSession.id }))).toBe('SESSION_NOT_WORKERS');
    expect(await code(endAgentless({ sessionId: generateId() }))).toBe('SESSION_NOT_WORKERS');
    expect((await sessionOf(adaSession.id)).endedAt).toBeNull();
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('an unknown reason is invalid input', async () => {
    expect(await code(endAgentless({ reason: 'GONE' }))).toBe('BAD_USER_INPUT');
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('only a host key: a person is refused HOST_KEY_REQUIRED', async () => {
    const p = M.endAgentlessSession({}, { input: { appRef: f.app.id, workerRef: f.kit.id, sessionId: f.session.id, reason: 'AGENT_ABSENT' } }, ctx(f.manager.id));
    expect(await code(p)).toBe('HOST_KEY_REQUIRED');
    expect((await sessionOf()).endedAt).toBeNull();
  });
});

describe('the session must run on the calling host (#4294 §10, Rook P2-1)', () => {
  /** orca2 registers Kit too, so both hosts pass the registration check. */
  /** Record Kit's session as launched on `hostId` by a worker.start issued there (chk_sessions_launch's three columns). */
  const launchedOn = async (hostId: string) => {
    const opId = generateId();
    await db.hostOperation.create({
      data: { id: opId, appId: f.app.id, hostId, type: 'worker.start', args: { workerId: f.kit.id, worktree: 'kit', family: 'claude' }, workerId: f.kit.id, issuedBy: 'platform', holdUserId: f.holder.id },
    });
    await db.session.update({ where: { id: f.session.id }, data: { launchHostId: hostId, launchOperationId: opId, launchIssuedBy: 'platform' } });
  };
  const secondHost = async () => {
    const orca2 = await f.hostKey('orca2');
    await f.register(orca2, { workers: [f.kit.id] });
    return orca2;
  };

  it('a session launched on orca1: orca2, which also registers Kit, is refused and the session stays open; orca1 ends it', async () => {
    const orca2 = await secondHost();
    await launchedOn('orca1');
    expect(await code(endAgentless({}, orca2)), 'another host ended a session launched on orca1').toBe('HOST_DOES_NOT_RUN_WORKER');
    expect((await sessionOf()).endedAt).toBeNull();
    expect(await endAgentless()).toMatchObject({ ended: true });
  });

  it('entry 1: a worker.end that reached orca2 for a session launched on orca1, reported AGENT_ABSENT, stays FAILED and open', async () => {
    const orca2 = await secondHost();
    await launchedOn('orca1');
    const op = await collectedEnd('orca2', orca2);
    expect(await reportFailed(op, 'AGENT_ABSENT', orca2), 'orca2\'s proof ended a session running on orca1').toMatchObject({ status: 'failed' });
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a hand-started session with two registering hosts: neither ends it, unless its client reported the host', async () => {
    const orca2 = await secondHost();
    expect(await code(endAgentless({}, orca2))).toBe('HOST_DOES_NOT_RUN_WORKER');
    expect(await code(endAgentless())).toBe('HOST_DOES_NOT_RUN_WORKER');
    expect((await sessionOf()).endedAt).toBeNull();
    await db.session.update({ where: { id: f.session.id }, data: { host: 'orca1' } });
    expect(await code(endAgentless({}, orca2))).toBe('HOST_DOES_NOT_RUN_WORKER');
    expect(await endAgentless()).toMatchObject({ ended: true });
  });

  it('a hand-started session whose only other registering host is lost: the remaining host is the sole one and ends it', async () => {
    await secondHost();
    await db.hostRegistration.updateMany({ where: { appId: f.app.id, hostId: 'orca2' }, data: { lostAt: new Date() } });
    expect(await endAgentless()).toMatchObject({ ended: true });
  });
});

describe('the remaining guards (#4294 §10 P3s; blind P3 F1)', () => {
  it('a soft-deleted session is not the worker\'s: SESSION_NOT_WORKERS, nothing ends', async () => {
    await db.session.update({ where: { id: f.session.id }, data: { deletedAt: new Date() } });
    expect(await code(endAgentless())).toBe('SESSION_NOT_WORKERS');
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a host scope revoked while the call waits for the App anchor: refused APP_KEY_SCOPE_REQUIRED, the session stays open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    // A revoker holds the App's anchor exclusively and revokes orca1's scope; the end's re-check runs after it commits.
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: f.app.id }], 'exclusive');
      await tx.appKeyScope.updateMany({ where: { appKeyId: f.orca1.id, scope: 'host:operate' }, data: { revokedAt: new Date(), revokedByUserId: f.manager.id } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await holding;
    const end = endAgentless().then(() => undefined, (e: { extensions?: { code?: string } }) => e.extensions?.code);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await revoker;
    expect(await end, 'the revocation fence did not re-check the key').toBe('APP_KEY_SCOPE_REQUIRED');
    expect((await sessionOf()).endedAt).toBeNull();
  });

  it('a handoff the worker wrote before it exited is reported (handoff: true); the end itself writes none', async () => {
    const before = await db.node.count({ where: { memoryId: f.kitMemory.id } });
    await db.node.create({
      data: { id: generateId(), memoryId: f.kitMemory.id, loc: `${HANDOFFS_PARENT_LOC}:0001`, name: 'Handoff', content: 'state', data: { [HANDOFF_SESSION_KEY]: f.session.id } },
    });
    expect(await endAgentless()).toEqual({ sessionId: f.session.id, ended: true, handoff: true });
    expect(await db.node.count({ where: { memoryId: f.kitMemory.id } })).toBe(before + 1);
  });
});

describe('after an agentless end (020:10: no handoff was recorded)', () => {
  it('the ended session reads endReason agent_absent; the next bind reads continuity MISSING, never an empty handoff', async () => {
    await endAgentless();
    expect(await F.Session.endReason({ endedAt: (await sessionOf()).endedAt, endReason: 'agent_absent' })).toBe('agent_absent');
    await f.bind(f.kit);
    const worker = await db.worker.findUniqueOrThrow({ where: { id: f.kit.id }, select: { id: true, appId: true, memoryId: true } });
    const c = await F.Worker.continuity(worker, {}, ctx(f.manager.id));
    expect(c).toMatchObject({ status: 'MISSING', handoff: null, previousSession: { id: f.session.id } });
  });
});

describe('the race: an assignment to the worker in flight while the host ends its session', () => {
  /**
   * An assignment that has taken Kit's per-worker lock, written a pending task for Kit and not committed yet (it read
   * Kit's session open, so it would reach Kit through it and start nothing). The end, started then, must wait for it
   * and see the task; deciding on its own earlier read would end the session the assignment counts on.
   */
  async function raceWith(end: () => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let written!: () => void;
    const ready = new Promise<void>((r) => { written = r; });
    const assignment = db.$transaction(async (tx) => {
      await lockWorkersForAssignment(tx, [f.kit.id]);
      await tx.agentTask.create({
        data: { appId: f.app.id, title: 'Assigned now', ownerUserId: f.manager.id, assigneeWorkerId: f.kit.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: false },
      });
      written();
      await gate;
    }, { timeout: 20_000 });
    await ready;
    let settled = false;
    const outcome = end().then((v) => ({ v, e: undefined as unknown }), (e: unknown) => ({ v: undefined, e })).finally(() => { settled = true; });
    // Let the end reach the lock (or, without it, finish).
    for (let i = 0; i < 150 && !settled; i++) {
      const [{ n }] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
        WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await assignment;
    return outcome;
  }

  it('entry 2: the end waits for the assignment, sees its task and is refused; the session stays open', async () => {
    const { e } = await raceWith(() => endAgentless());
    expect((e as { extensions?: { code?: string } } | undefined)?.extensions?.code, 'the end decided before the in-flight assignment committed').toBe('WORKER_HAS_OPEN_TASK');
    expect((await sessionOf()).endedAt, 'the session the assignment counts on was ended').toBeNull();
  });

  it('entry 1: the report waits for the assignment, sees its task, and the op FAILED; the session stays open', async () => {
    const op = await collectedEnd();
    const { v } = await raceWith(() => reportFailed(op));
    expect(v, 'the report decided before the in-flight assignment committed').toMatchObject({ status: 'failed' });
    expect((await sessionOf()).endedAt, 'the session the assignment counts on was ended').toBeNull();
  });
});
