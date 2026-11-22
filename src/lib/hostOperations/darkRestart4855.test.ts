/**
 * #4855 (cor:agt:070:08 S4a, Holger 2026-11-22; cor:acl:140:02): an assignment to a worker whose open session is DARK must not fail
 * silently. The worker dedicated to manage agents ends the dark session and starts the worker again, with no person in the loop, under a
 * `worker.session.restart` grant a person who manages the App signed (the grant names its workers, no wildcard): `restartWorkerSession`.
 * A QUIET open session is not dark: an assignment never ends it (S4, #1114, ruling 0265 V16-V19). No role is named anywhere and no table
 * designates anyone: the signed grant is the whole of the authority. Grants are really activated (triggerGrantFixtures3483.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { serveEveryAgent } from '../../test/servedBootPrompt.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { cleanDb } from '../../test/helpers.js';
import { dbNowPlus } from '../grants/grantFixtures3668.js';
import { seedTriggerWorld, triggerGrant, useCount, useEvents, workerOf, type TriggerWorld } from '../grants/triggerGrantFixtures3483.js';
import { createPendingGrant } from '../grants/create.js';
import { restartDarkSession } from './darkRestart.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { valueCovers, coverableAction } from '../grants/cover.js';
import { renderGrantSummary } from '../grants/summary.js';
import { PLATFORM_ACTIONS } from '../grants/actions.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ACTION = 'worker.session.restart';
const REFUSED = 'RESTART_GRANT_REQUIRED';

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let w: TriggerWorld;
let kit: string;
let third: string;
let orca1: { id: string };

const keyCtx = (k: { id: string }): Context => ({ db, appId: w.appId, appKeyId: k.id, organizationId: w.orgId, roles: [] }) as Context;
const lifecycle = <T>(fn: () => Promise<T>, workerId = w.workerId): Promise<T> => runAsActor({ workerId, agentId: w.agentId }, fn);

beforeEach(async () => {
  await cleanDb(db);
  w = await seedTriggerWorld();
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: w.appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, w.person);
  kit = (await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'Kit', slug: 'kit', heldByUserId: w.user2Id, heldAt: new Date() }, select: { id: true },
  })).id;
  third = await workerOf(w);
  await M.registerHost({}, {
    input: { appRef: w.appId, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit, family: 'claude', worktrees: ['hadron-server/kit'] }] },
  }, keyCtx(orca1));
  await serveEveryAgent(db);
});

const grant = (names: string | string[] = kit, over: Record<string, unknown> = {}, extra: { holder?: { kind: 'worker' | 'agent'; id: string }; activate?: boolean } = {}) =>
  triggerGrant(w, { action: ACTION, ...extra, over: { action_values: { worker: names }, max_uses: null, ...over } });
const restart = (worker: string = kit, reason = 'no answer to two wakes and the terminal is gone', c: Context = w.workerCtx as Context, appRef = w.appId) =>
  lifecycle(() => M.restartWorkerSession({}, { input: { appRef, worker, reason } }, c));
const starts = () => db.hostOperation.findMany({ where: { type: 'worker.start' }, orderBy: { issuedAt: 'asc' } });
const task = (assigneeWorkerId: string | null = kit) =>
  db.agentTask.create({ data: { appId: w.appId, title: 'Do it', ownerUserId: w.userId, assigneeWorkerId, assignedAt: assigneeWorkerId ? new Date() : null, closeSessionWhenDone: false }, select: { id: true } });
const kitSession = async (quiet = true) => {
  const at = quiet ? new Date(Date.now() - 60 * 86_400_000) : new Date();
  return db.session.create({ data: { id: generateId(), appId: w.appId, workerId: kit, userId: w.user2Id, startedAt: at, updatedAt: at, family: 'claude' }, select: { id: true } });
};
const sessionOf = (id: string) => db.session.findUniqueOrThrow({ where: { id }, select: { endedAt: true, endReason: true } });
const failInFlightStarts = () => db.hostOperation.updateMany({ where: { type: 'worker.start' }, data: { status: 'failed', finishedAt: new Date(), failureReason: 'host gone' } });

describe('#4855 the quiet control (S4) and the unchanged start', () => {
  it('S4: assigning Kit over a QUIET open session starts nothing and ends nothing', async () => {
    const s = await kitSession();
    const t = await task(null);
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit } }, w.person);
    expect(await starts()).toHaveLength(0);
    expect((await sessionOf(s.id)).endedAt).toBeNull();
  });

  it('S4 with a restart grant on file: still nothing started or ended by an assignment, and no use spent', async () => {
    const g = await grant();
    const s = await kitSession();
    const t = await task(null);
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit } }, w.person);
    expect(await starts()).toHaveLength(0);
    expect((await sessionOf(s.id)).endedAt).toBeNull();
    expect(await useCount(g)).toBe(0);
  });

  it('an assignment to a worker with no open session starts as before', async () => {
    const t = await task(null);
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit } }, w.person);
    expect((await starts()).map((o) => [o.issuedBy, (o.args as { taskId?: string }).taskId])).toEqual([['platform', t.id]]);
  });
});

describe('#4855 the grant holder ends a dark session and starts the worker again', () => {
  it('ends the open session and issues exactly one start for the oldest open task, issued by that worker; one use is spent and recorded', async () => {
    const g = await grant();
    const s = await kitSession();
    const older = await task();
    await task();
    const out = await restart();
    expect(await sessionOf(s.id)).toMatchObject({ endReason: 'ended' });
    expect((await sessionOf(s.id)).endedAt).not.toBeNull();
    const ops = await starts();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ hostId: 'orca1', workerId: kit, issuedBy: 'worker', issuedByWorkerId: w.workerId });
    expect(ops[0]!.args).toMatchObject({ workerId: kit, worktree: 'hadron-server/kit', family: 'claude', taskId: older.id });
    expect(out).toMatchObject({ operationId: ops[0]!.id, hostId: 'orca1', taskId: older.id, endedSessionIds: [s.id] });
    expect(await useCount(g)).toBe(1);
    const events = await useEvents(g);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workerId: w.workerId, sessionId: w.sessionId });
  });

  it('with no open task the start carries none', async () => {
    await grant();
    await kitSession();
    expect(((await restart()) as { taskId: string | null }).taskId).toBeNull();
    expect((await starts())[0]!.args).not.toHaveProperty('taskId');
  });

  it('the grant repeats: a second dark session is restarted under the same grant (use count 2)', async () => {
    const g = await grant();
    await kitSession();
    await restart();
    await failInFlightStarts();
    await kitSession();
    await restart();
    expect(await useCount(g)).toBe(2);
    expect(await starts()).toHaveLength(2);
  });

  it('a grant naming a list covers each member, and only the members', async () => {
    const g = await grant([third, kit]);
    await kitSession();
    await restart();
    expect(await useCount(g)).toBe(1);
  });

  it('no double start: a restart in flight refuses a second restart and keeps a fresh assignment from starting again', async () => {
    const g = await grant();
    await kitSession();
    await restart();
    expect(await code(restart())).toBe('WORKER_START_PENDING');
    const t = await task(null);
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit } }, w.person);
    expect(await starts()).toHaveLength(1);
    expect(await useCount(g)).toBe(1);
  });
});

describe('#4855 who may: a signed grant held by that worker, naming the target, and nobody else', () => {
  const untouched = async (sessionId: string, g?: string) => {
    expect((await sessionOf(sessionId)).endedAt).toBeNull();
    expect(await starts()).toHaveLength(0);
    if (g) expect(await useCount(g)).toBe(0);
  };

  it('no grant at all: the one refusal, nothing ended, nothing started', async () => {
    const s = await kitSession();
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id);
  });

  it('a person who manages the App is refused by this door (the authority is the worker\'s signed grant)', async () => {
    const g = await grant();
    const s = await kitSession();
    expect(await code(M.restartWorkerSession({}, { input: { appRef: w.appId, worker: kit, reason: 'r' } }, w.person))).toBe(REFUSED);
    await untouched(s.id, g);
  });

  it('an App key is refused (no worker, no session)', async () => {
    await grant();
    const s = await kitSession();
    const out = await code(M.restartWorkerSession({}, { input: { appRef: w.appId, worker: kit, reason: 'r' } }, keyCtx(orca1)));
    expect(out).toBeDefined();
    await untouched(s.id);
  });

  it('another worker\'s grant does not cover this worker', async () => {
    const g = await grant(kit, {}, { holder: { kind: 'worker', id: third } });
    const s = await kitSession();
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id, g);
  });

  it('a grant its role agent holds is not the worker\'s (reach: the worker itself)', async () => {
    const g = await grant(kit, {}, { holder: { kind: 'agent', id: w.agentId } });
    const s = await kitSession();
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id, g);
  });

  it('a grant naming another worker does not cover the target', async () => {
    const g = await grant(third);
    const s = await kitSession();
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id, g);
  });

  it('a stored wildcard covers nothing: the action refuses it', async () => {
    const g = await grant('*');
    const s = await kitSession();
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id, g);
  });

  it('a pending (unsigned), an expired and a revoked grant each allow nothing', async () => {
    const s = await kitSession();
    const pending = await grant(kit, {}, { activate: false });
    const expiring = await grant(kit, { expires_at: dbNowPlus('1 second') });
    const revoked = await grant();
    await db.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, revoked, w.userId);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id);
    for (const g of [pending, expiring, revoked]) expect(await useCount(g)).toBe(0);
  });

  it('a grant of another App covers nothing in this one', async () => {
    const s = await kitSession();
    await grant(kit, { app_id: w.app2Id });
    expect(await code(restart())).toBe(REFUSED);
    await untouched(s.id);
  });

  it('the worker never restarts itself, even when a grant names it', async () => {
    const g = await grant(w.workerId);
    expect(await code(restart(w.workerId))).toBe(REFUSED);
    expect(await useCount(g)).toBe(0);
  });

  it('authority is judged first: with no grant the caller learns nothing of the target (live, no session, unknown name all read the same)', async () => {
    await kitSession(false);
    expect(await code(restart())).toBe(REFUSED);
    await db.session.updateMany({ where: { workerId: kit }, data: { endedAt: new Date() } });
    expect(await code(restart())).toBe(REFUSED);
    expect(await code(restart('no-such-worker'))).toBe(REFUSED);
  });

  it('the one refusal has fixed text that names nothing', async () => {
    const e = await restart().catch((x) => x as GraphQLError);
    expect((e as GraphQLError).message).toBe('A worker needs a signed grant from a person who manages the App to restart another worker\'s session.');
  });
});

describe('#4855 the fences: a refused start leaves the session open and spends nothing', () => {
  const fenced = async (expected: string, g: string, s: string) => {
    expect(await code(restart())).toBe(expected);
    expect((await sessionOf(s)).endedAt).toBeNull();
    expect(await starts()).toHaveLength(0);
    expect(await useCount(g)).toBe(0);
    expect(await useEvents(g)).toHaveLength(0);
  };

  it('a LIVE session is never dark: WORKER_LIVE', async () => {
    const g = await grant();
    const s = await kitSession(false);
    await fenced('WORKER_LIVE', g, s.id);
  });

  it('no open session: NO_OPEN_SESSION', async () => {
    const g = await grant();
    expect(await code(restart())).toBe('NO_OPEN_SESSION');
    expect(await useCount(g)).toBe(0);
  });

  it('no live host lists the worker: NO_LIVE_HOST, the session is not ended', async () => {
    const g = await grant();
    const s = await kitSession();
    await db.hostRegistration.deleteMany({});
    await fenced('NO_LIVE_HOST', g, s.id);
  });

  it('nobody holds the worker: WORKER_NOT_HELD', async () => {
    const g = await grant();
    const s = await kitSession();
    await db.worker.update({ where: { id: kit }, data: { heldByUserId: null, heldAt: null } });
    await fenced('WORKER_NOT_HELD', g, s.id);
  });

  it('the team is paused: TEAM_PAUSED', async () => {
    const g = await grant();
    const s = await kitSession();
    await db.app.update({ where: { id: w.appId }, data: { teamPausedAt: new Date() } });
    await fenced('TEAM_PAUSED', g, s.id);
  });

  it('reason is required and at most 500 characters', async () => {
    const g = await grant();
    await kitSession();
    expect(await code(restart(kit, '   '))).toBe('BAD_USER_INPUT');
    expect(await code(restart(kit, 'x'.repeat(501)))).toBe('BAD_USER_INPUT');
    expect(await useCount(g)).toBe(0);
  });
});

describe('#4855 the not-started alarm interplay (QA F1): the restart neither hides the stall nor raises a second one', () => {
  const alarms = () => db.agentTeamEvent.findMany({ where: { type: 'stall.not-started' }, orderBy: { createdAt: 'asc' } });
  const overdue = async () => {
    const t = await task();
    await db.agentTask.update({ where: { id: t.id }, data: { assignedAt: new Date(Date.now() - 3 * 3_600_000) } });
    return t;
  };

  it('a not-started alarm raised for the task over the dark session stays open and untouched by the restart; the task row is unchanged and no second alarm follows', async () => {
    await grant();
    await kitSession();
    const t = await overdue();
    expect((await taskStallTick(db, new Date())).raised).toBeGreaterThan(0);
    const before = await alarms();
    expect(before).toHaveLength(1);
    const taskBefore = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    await restart();
    // The restart carries the task in its start; it does not start, reassign, release or re-time the task, and ends no alarm.
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({
      status: taskBefore.status, assigneeWorkerId: kit, assignedAt: taskBefore.assignedAt, startedAt: null,
    });
    expect((await starts())[0]!.args).toMatchObject({ taskId: t.id });
    expect((await alarms()).map((e) => e.id)).toEqual(before.map((e) => e.id));
    await taskStallTick(db, new Date());
    expect(await alarms()).toHaveLength(1);
  });

  it('once the restarted worker starts the task, the tick that sees it started raises nothing new', async () => {
    await grant();
    await kitSession();
    const t = await overdue();
    await taskStallTick(db, new Date());
    await restart();
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: new Date() } });
    const tick = await taskStallTick(db, new Date());
    expect(tick.raised).toBe(0);
    expect(await alarms()).toHaveLength(1);
  });

  it('the restart is no assignment: it does not open a new not-started episode for a task that was never overdue', async () => {
    await grant();
    await kitSession();
    await task();
    await restart();
    await taskStallTick(db, new Date());
    expect(await alarms()).toHaveLength(0);
  });
});

describe('#4855 the library re-judges the actor under the transaction (a retirement that lands after the door resolved it)', () => {
  const direct = (actorId: string, over: Record<string, unknown> = {}) => db.$transaction((tx) => restartDarkSession(tx, {
    appId: w.appId, workerId: kit, now: new Date(),
    actor: { workerId: actorId, sessionId: null, hostLaunched: false, userId: w.userId, agentId: w.agentId, ...over },
  }));

  it('a retired actor with a still-live grant is refused, and nothing is ended, started or spent', async () => {
    const g = await grant();
    const s = await kitSession();
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    expect(await code(direct(w.workerId))).toBe(REFUSED);
    expect((await sessionOf(s.id)).endedAt).toBeNull();
    expect(await starts()).toHaveLength(0);
    expect(await useCount(g)).toBe(0);
  });

  it('an actor of another App holding a grant of that App is refused here', async () => {
    const foreign = await workerOf(w, w.agentId, w.app2Id);
    const g = await triggerGrant(w, { holder: { kind: 'worker', id: foreign }, action: ACTION, over: { action_values: { worker: kit }, max_uses: null, app_id: w.app2Id } });
    await kitSession();
    expect(await code(direct(foreign))).toBe(REFUSED);
    expect(await useCount(g)).toBe(0);
  });

  it('control: the same call by the live holder succeeds', async () => {
    await grant();
    await kitSession();
    expect((await direct(w.workerId)).endedSessionIds).toHaveLength(1);
  });
});

describe('#4855 the grant itself: worker-ref terms, no wildcard, no designation table', () => {
  const create = (values: unknown, holder = w.workerId) => db.$transaction((tx) => createPendingGrant(tx, {
    appId: w.appId, requester: { userId: w.userId, workerId: null, sessionId: null }, holder: { kind: 'worker', id: holder },
    action: ACTION, values: values as never, reason: 'r', canReadMemory: async () => true,
  }));
  const refusal = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  it('takes one worker, or a list of workers of this App', async () => {
    expect(await refusal(create({ worker: kit }))).toBe('OK');
    expect(await refusal(create({ worker: [kit, third] }))).toBe('OK');
  });

  it('refuses a wildcard, an empty list, a URN, another App\'s worker, a retired worker and an unknown id (one refusal, no oracle)', async () => {
    const other = await workerOf(w, w.agentId, w.app2Id);
    const retired = await workerOf(w);
    await db.worker.update({ where: { id: retired }, data: { retiredAt: new Date() } });
    for (const v of ['*', ['*'], [], 'hrn:worker:x:y:z', other, retired, 'a'.repeat(24), [kit, other]]) {
      expect(await refusal(create({ worker: v })), JSON.stringify(v)).toBe('GRANT_VALUES_INVALID');
    }
  });

  it('refuses a second key, a missing key and a node-ref in its place', async () => {
    for (const v of [{}, { worker: kit, entryNode: kit }, { entryNode: kit }]) expect(await refusal(create(v))).toBe('GRANT_VALUES_INVALID');
  });

  it('the action is declared without a count, takes a list, never the wildcard, and is held by the worker itself', () => {
    const a = PLATFORM_ACTIONS.find((x) => x.name === ACTION)!;
    expect(a).toMatchObject({ reach: 'WORKER', listParameters: ['worker'], issuerRule: 'APP_MANAGER', enforcement: 'SERVER' });
    expect(a.maxUses).toBeUndefined();
    expect(a.parameters).toEqual([{ name: 'worker', type: 'worker-ref', refusesWildcard: true }]);
  });

  it('valueCovers: the id or a list holding it covers; the wildcard, another id and a non-string do not', () => {
    const a = coverableAction(ACTION);
    expect(valueCovers(a, 'worker', kit, kit)).toBe(true);
    expect(valueCovers(a, 'worker', [third, kit], kit)).toBe(true);
    expect(valueCovers(a, 'worker', '*', kit)).toBe(false);
    expect(valueCovers(a, 'worker', third, kit)).toBe(false);
    expect(valueCovers(a, 'worker', [third], kit)).toBe(false);
    expect(valueCovers(a, 'worker', 7, kit)).toBe(false);
  });

  it('the signer reads the workers as canonical worker URNs; a wildcard or a non-worker URN writes nothing', () => {
    const app = { urn: 'hrn:app:r.test:team' };
    const refs = { a: { urn: 'hrn:worker:r.test:team:kit' }, b: { urn: 'hrn:worker:r.test:team:ada' } };
    const action = PLATFORM_ACTIONS.find((x) => x.name === ACTION)!;
    expect(renderGrantSummary({ action, app, values: { worker: ['a', 'b'] }, refs })).toBe(
      'End a dark open session of the workers hrn:worker:r.test:team:kit, hrn:worker:r.test:team:ada in hrn:app:r.test:team and start them again');
    expect(() => renderGrantSummary({ action, app, values: { worker: '*' }, refs })).toThrow();
    expect(() => renderGrantSummary({ action, app, values: { worker: 'a' }, refs: { a: { urn: 'hrn:node:r.test:m:loc' } } })).toThrow();
  });

  it('no table or column designates a lifecycle worker (the grant is the authority): no session_lifecycle column, no restart end reason', async () => {
    const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'workers' AND column_name ILIKE '%lifecycle%'`);
    expect(cols).toEqual([]);
    const reasons = await db.$queryRawUnsafe<Array<{ enumlabel: string }>>(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'SessionEndReason'`);
    expect(reasons.map((r) => r.enumlabel).sort()).toEqual(['agent_absent', 'ended', 'expired', 'superseded']);
  });
});
