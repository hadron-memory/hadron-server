import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1709 (T6 slice 3) — cor:agt:050:10: finishing or cancelling a task with
 * closeSessionWhenDone asks its worker assignee to end its session; after the
 * App's grace (default 10 minutes) the platform ends that same session through
 * a live host, or does nothing more without one. cor:agt:020:10: worker.end
 * fails only if the session did not end. cor:agt:070:06: no worktree moves.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { resolveSessionEndRequest, sweepSessionEndRequests } from './sessionEnd.js';
import { pendingTaskWakes } from '../agentTasks/taskWakes.js';
import { loadWorkerWorkStates } from '../agentTasks/matcher.js';
import { writeSessionHandoff } from '../../api/graphql/schema/resolvers.mutation.session.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const F = resolvers as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let app: { id: string };
let agentId: string;
let manager: { id: string };
let holder: { id: string };
let kit: { id: string };
let ada: { id: string };
let orca1: { id: string };
let session: { id: string };

const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;
const MIN = 60_000;

async function bind(w: { id: string }, userId: string, startedAt = new Date()) {
  return db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId, userId, startedAt, updatedAt: startedAt }, select: { id: true } });
}
async function startedTask(close = true) {
  return db.agentTask.create({
    data: {
      appId: app.id, title: 'Review #1709', ownerUserId: manager.id, assigneeWorkerId: kit.id, status: 'started',
      assignedAt: new Date(), startedAt: new Date(), closeSessionWhenDone: close,
    },
    select: { id: true },
  });
}
const finish = (taskId: string) =>
  asWorker(kit, () => M.finishAgentTask({}, { taskId, result: { outcome: 'succeeded' } }, ctx(holder.id)));
const requestOf = (taskId: string) => db.taskSessionEndRequest.findUnique({ where: { taskId } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'End', urn: `sessend-${n}.example` } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `se-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(91, 'manager');
  holder = await u(92, 'holder');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: holder.id }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id, reportsToWorkerId: ada.id }, select: { id: true } });
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  // A 10-minute check-in, so the registration is still live when the 10-minute grace runs out (it lapses after 30).
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] } }, keyCtx(orca1));
  session = await bind(kit, holder.id);
});

describe('the ask (cor:agt:050:10)', () => {
  it('S1: finishing with closeSessionWhenDone asks Kit to end the session it has, due after the default 10 minutes', async () => {
    const t = await startedTask();
    const before = Date.now();
    const finished = await finish(t.id);
    const r = await requestOf(t.id);
    expect(r).toMatchObject({ workerId: kit.id, sessionId: session.id, requestedByWorkerId: kit.id, resolution: null });
    expect(r!.dueAt.getTime() - r!.requestedAt.getTime()).toBe(10 * MIN);
    expect(r!.requestedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const [e] = await db.agentTeamEvent.findMany({ where: { type: 'task.session-end-requested' } });
    expect(e).toMatchObject({ id: r!.eventId, taskId: t.id, subjectWorkerId: kit.id, actorWorkerId: kit.id });
    expect(e!.payload).toMatchObject({ sessionId: session.id, graceMinutes: 10 });
    // The finisher reads it on the task it finished, not as a wake.
    const shown = await F.AgentTask.sessionEndRequest(finished, {}, ctx(holder.id));
    expect(shown).toMatchObject({ sessionId: session.id, resolution: null });
    const wakes = await pendingTaskWakes(db, [kit.id], new Date());
    expect((wakes.get(kit.id) ?? []).filter((w) => w.event === 'END_SESSION')).toEqual([]);
  });

  it('S2: with closeSessionWhenDone no, nothing is asked and nothing is queued', async () => {
    const t = await startedTask(false);
    await finish(t.id);
    expect(await requestOf(t.id)).toBeNull();
    expect(await sweepSessionEndRequests(db, new Date(Date.now() + 60 * MIN))).toBe(0);
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('a worker with no open session is simply free: nothing is asked (050:10 edge case, Proposed)', async () => {
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const t = await startedTask();
    await finish(t.id);
    expect(await requestOf(t.id)).toBeNull();
  });

  it('cancelling asks too, and wakes Kit (END_SESSION) while that session is open', async () => {
    const t = await db.agentTask.create({
      data: { appId: app.id, title: 'Cancel me', ownerUserId: manager.id, assigneeWorkerId: kit.id, status: 'pending', assignedAt: new Date(), closeSessionWhenDone: true },
      select: { id: true },
    });
    await M.cancelAgentTask({}, { taskId: t.id }, ctx(manager.id));
    const r = await requestOf(t.id);
    expect(r).toMatchObject({ sessionId: session.id, requestedByWorkerId: null });
    const due = (await pendingTaskWakes(db, [kit.id], new Date())).get(kit.id) ?? [];
    expect(due.map((w) => [w.event, w.eventId, w.taskId])).toEqual([['END_SESSION', r!.eventId, t.id]]);
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    expect((await pendingTaskWakes(db, [kit.id], new Date())).get(kit.id) ?? []).toEqual([]);
  });
});

describe('the fallback after the grace (cor:agt:050:10 S4, cor:agt:070:05)', () => {
  it('S4: still open at the grace, the platform issues worker.end for that exact session to Kit\'s live host; not a moment before', async () => {
    const t = await startedTask();
    await finish(t.id);
    const r = (await requestOf(t.id))!;
    expect(await resolveSessionEndRequest(db, r.id, new Date(r.dueAt.getTime() - 1))).toBeNull();
    expect(await db.hostOperation.count()).toBe(0);
    expect(await resolveSessionEndRequest(db, r.id, r.dueAt)).toBe('end-issued');
    const [op] = await db.hostOperation.findMany();
    expect(op).toMatchObject({ type: 'worker.end', hostId: 'orca1', workerId: kit.id, issuedBy: 'platform', issuedByUserId: null, status: 'issued' });
    expect(op!.args).toEqual({ workerId: kit.id, sessionId: session.id });
    expect(await requestOf(t.id)).toMatchObject({ resolution: 'end-issued', operationId: op!.id });
    // Resolved once: a second pass changes nothing.
    expect(await sweepSessionEndRequests(db, new Date(r.dueAt.getTime() + MIN))).toBe(0);
    expect(await db.hostOperation.count()).toBe(1);
    // cor:agt:070:06: no worktree operation, ever.
    expect(await db.hostOperation.count({ where: { type: { startsWith: 'worktree.' } } })).toBe(0);
  });

  it('a session that ended within the grace issues nothing; a replacement session is never touched', async () => {
    const t = await startedTask();
    await finish(t.id);
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const replacement = await bind(kit, holder.id);
    expect(await sweepSessionEndRequests(db, new Date(Date.now() + 11 * MIN))).toBe(1);
    expect(await requestOf(t.id)).toMatchObject({ resolution: 'ended', operationId: null });
    expect(await db.hostOperation.count()).toBe(0);
    expect((await db.session.findUniqueOrThrow({ where: { id: replacement.id } })).endedAt).toBeNull();
  });

  it('with no live host, nothing more happens', async () => {
    const t = await startedTask();
    await finish(t.id);
    // The registration lapses: three missed check-ins of 10 minutes.
    await db.hostRegistration.updateMany({ data: { refreshedAt: new Date(Date.now() - 120 * MIN) } });
    expect(await sweepSessionEndRequests(db, new Date(Date.now() + 11 * MIN))).toBe(1);
    expect(await requestOf(t.id)).toMatchObject({ resolution: 'no-live-host' });
    expect(await db.hostOperation.count()).toBe(0);
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).endedAt).toBeNull();
  });

  it('an App-adjusted grace: 3 minutes; out-of-range values are refused', async () => {
    const view = await M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { sessionEndGraceMinutes: 3 } }, ctx(manager.id));
    expect(view.sessionEndGraceMinutes).toBe(3);
    expect(await code(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { sessionEndGraceMinutes: 0 } }, ctx(manager.id)))).toBe('BAD_USER_INPUT');
    expect(await code(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { sessionEndGraceMinutes: 1441 } }, ctx(manager.id)))).toBe('BAD_USER_INPUT');
    expect(await code(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { sessionEndGraceMinutes: 5 } }, ctx(holder.id)))).toBe('APP_MANAGER_REQUIRED');
    const t = await startedTask();
    await finish(t.id);
    const r = (await requestOf(t.id))!;
    expect(r.dueAt.getTime() - r.requestedAt.getTime()).toBe(3 * MIN);
    await M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { sessionEndGraceMinutes: null } }, ctx(manager.id));
    expect((await M.setAgentTaskStallSchedule({}, { appRef: app.id, input: {} }, ctx(manager.id))).sessionEndGraceMinutes).toBe(10);
  });

  it('the matcher hands no new work to a worker waiting on a session end', async () => {
    const t = await startedTask();
    await finish(t.id);
    const state = (await loadWorkerWorkStates(db, app.id, new Date())).find((w) => w.id === kit.id)!;
    expect(state.endingSession).toBe(true);
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const after = (await loadWorkerWorkStates(db, app.id, new Date())).find((w) => w.id === kit.id)!;
    expect(after.endingSession).toBe(false);
  });
});

describe('the fallback is fenced through the insert (#1877 review, Colin P2-1, Greta P3)', () => {
  /** Run `work` in a transaction held open until released; resolves `locked` once `work` is done. */
  function holdOpen(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const done = db.$transaction(async (tx) => { await work(tx); ready(); await gate; });
    return { locked, release, done };
  }
  async function dueRequest() {
    const t = await startedTask();
    await finish(t.id);
    return (await requestOf(t.id))!;
  }
  async function resolveAgainst(hold: ReturnType<typeof holdOpen>, r: { id: string; dueAt: Date }) {
    await hold.locked;
    let settled = false;
    const p = resolveSessionEndRequest(db, r.id, r.dueAt).finally(() => { settled = true; });
    try {
      await new Promise((res) => setTimeout(res, 400));
      expect(settled).toBe(false);
    } finally {
      // Colin P3 (#10860): release and drain the holder even when the assertion fails, so a red run never leaves a
      // transaction (and its locks) open behind it for the next test.
      hold.release();
      await hold.done;
      await p.catch(() => undefined);
    }
    return p;
  }

  it('a refresh dropping the worker, in flight, is waited for: the request resolves no-live-host and nothing is issued', async () => {
    const r = await dueRequest();
    const hold = holdOpen(async (tx) => {
      const [reg] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM host_registrations WHERE app_id = ${app.id} AND host_id = 'orca1' FOR UPDATE`;
      await tx.hostRegistrationWorker.deleteMany({ where: { registrationId: reg!.id } });
    });
    expect(await resolveAgainst(hold, r)).toBe('no-live-host');
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('a lapse count lowered in flight is waited for: the host it lapses gets nothing', async () => {
    // Refreshed 15 minutes before the request: at the grace (25 minutes on) it is live under 3 check-ins of 10, lapsed under 2.
    await db.hostRegistration.updateMany({ data: { refreshedAt: new Date(Date.now() - 15 * MIN) } });
    const r = await dueRequest();
    const hold = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'host-lapse:' + app.id}))`;
      await tx.agentTaskStallSchedule.upsert({ where: { appId: app.id }, create: { appId: app.id, hostLapseCheckIns: 2 }, update: { hostLapseCheckIns: 2 } });
    });
    expect(await resolveAgainst(hold, r)).toBe('no-live-host');
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('an uninstall in flight is waited for: nothing is issued to a dead App\'s hosts', async () => {
    const r = await dueRequest();
    const org = await db.app.findUniqueOrThrow({ where: { id: app.id }, select: { organizationId: true } });
    const hold = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'authorization:app'}), hashtext(${app.id}))`;
      if (org.organizationId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'authorization:org'}), hashtext(${org.organizationId}))`;
      await tx.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    });
    expect(await resolveAgainst(hold, r)).toBe('no-live-host');
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('control: nothing in flight, a live registered host gets exactly one worker.end', async () => {
    const r = await dueRequest();
    expect(await resolveSessionEndRequest(db, r.id, r.dueAt)).toBe('end-issued');
    expect(await resolveSessionEndRequest(db, r.id, r.dueAt)).toBeNull();
    expect(await db.hostOperation.count({ where: { type: 'worker.end' } })).toBe(1);
  });

  it('Colin P3: after end-issued, the original ends and a replacement binds: the replacement may take work, and the old report touches only the original', async () => {
    const r = await dueRequest();
    await resolveSessionEndRequest(db, r.id, r.dueAt);
    const [op] = await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1));
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const replacement = await bind(kit, holder.id);
    // The outstanding operation names an ended session: it no longer holds the worker back from matching.
    expect((await loadWorkerWorkStates(db, app.id, new Date())).find((w) => w.id === kit.id)!.endingSession).toBe(false);
    expect(await M.reportHostOperation({}, { input: { appRef: app.id, id: op.id, outcome: 'SUCCEEDED' } }, keyCtx(orca1)))
      .toMatchObject({ status: 'succeeded', args: { sessionId: session.id } });
    expect((await db.session.findUniqueOrThrow({ where: { id: replacement.id } })).endedAt).toBeNull();
  });
});

describe('worker.end at the host (cor:agt:020:10: it fails only if the session did not end)', () => {
  async function issued() {
    const t = await startedTask();
    await finish(t.id);
    const r = (await requestOf(t.id))!;
    await resolveSessionEndRequest(db, r.id, r.dueAt);
    const [op] = await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1));
    return op as { id: string };
  }
  const report = (id: string, input: Record<string, unknown>) =>
    M.reportHostOperation({}, { input: { appRef: app.id, id, ...input } }, keyCtx(orca1));

  it('a success ends the session the worker left open, recorded without a handoff', async () => {
    const op = await issued();
    const done = await report(op.id, { outcome: 'SUCCEEDED' });
    expect(done).toMatchObject({ status: 'succeeded', result: { handoff: false } });
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).endedAt).not.toBeNull();
    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ endReason: 'ended' });
  });

  it('a worker that wrote its handoff and ended is recorded as such', async () => {
    const op = await issued();
    await writeSessionHandoff(ctx(holder.id), session.id, kit.id, 'Handing off: review done.');
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    expect(await report(op.id, { outcome: 'SUCCEEDED' })).toMatchObject({ status: 'succeeded', result: { handoff: true } });
  });

  it('a failure stands only while the session is open; a "failure" on an ended session is the success it is', async () => {
    const op = await issued();
    expect(await report(op.id, { outcome: 'FAILED', failureReason: 'terminal not found' })).toMatchObject({ status: 'failed', failureReason: 'terminal not found' });
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).endedAt).toBeNull();
  });

  it('a reported failure after the session ended is recorded succeeded', async () => {
    const op = await issued();
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    expect(await report(op.id, { outcome: 'FAILED', failureReason: 'already gone' })).toMatchObject({ status: 'succeeded', failureReason: null, result: { handoff: false } });
    const [e] = await db.agentTeamEvent.findMany({ where: { type: { startsWith: 'host.operation.' } } });
    expect(e!.type).toBe('host.operation.succeeded');
  });
});

describe('a manager ends a worker by hand (cor:agt:070:05)', () => {
  const end = (c: Context, sessionId = session.id) =>
    M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worker.end', args: { sessionId } } }, c);

  it('whoever manages the App issues worker.end for an open session of the worker', async () => {
    expect(await end(ctx(manager.id))).toMatchObject({ type: 'worker.end', issuedBy: 'user', args: { workerId: kit.id, sessionId: session.id } });
  });

  it('S4: the holder and the worker Kit reports to may not; an ended or foreign session is refused', async () => {
    expect(await code(end(ctx(holder.id)))).toBe('HOST_OPERATION_NOT_PERMITTED');
    expect(await code(asWorker(ada, () => end(ctx(holder.id))))).toBe('HOST_OPERATION_NOT_PERMITTED');
    const other = await bind(ada, holder.id);
    expect(await code(end(ctx(manager.id), other.id))).toBe('BAD_HOST_OPERATION_ARGS');
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    expect(await code(end(ctx(manager.id)))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await db.hostOperation.count()).toBe(0);
  });
});
