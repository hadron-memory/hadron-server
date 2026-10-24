/**
 * #2162 (cor:agt:050:27) — the platform's half of a worker's context reset: a shed, never a session end.
 *
 * ISSUE. When a task the worker had started finishes or is cancelled, its Agent has `resetContextAfterTask` on, the
 * worker holds no other started task, the App is not under a team pause, and no session end was asked for the same
 * task (R119: ending the session wins), the finishing transaction records one `ContextReset` and one
 * `worker.reset-context` host operation for a live host that registers the worker AND declared the capability
 * (cor:agt:070:01, Proposed). With no such host the reset is recorded failed `HOST_UNSUPPORTED`, with an event for the
 * coordinator, and nothing is issued: a host that never declared the type never receives it.
 *
 * PROTOCOL. The host collects the operation (cor:agt:070:02, unchanged) and then, with the same host key:
 *   claim → registerRecovery → authorizeStop → agentStopped → relaunched (or relaunchFailed),
 * and finally reports the operation through the ordinary 070:02 report. Every step names the reset's `epoch`; any
 * cancellation moves it, so a stale step is refused STALE_EPOCH. Every step is idempotent: a replay returns the
 * recorded answer, and a stop is granted at most once per claim, so a replay never opens a new window.
 *
 * THE FENCE. The claim, under the per-worker lock (src/lib/agentTasks/workerLock.ts), re-reads that the session is
 * still the worker's only open one, that no task is assigned to it, and that no other availability record is in
 * effect, and then marks it unavailable `resetting`. Every assignment path refuses or skips a worker under that mark
 * (cor:agt:050:27 §4). The mark carries an `until` that encodes the protocol's lease, so it lapses by itself:
 *   claimed      → claimedAt + CLAIM_LEASE_MS
 *   stop-granted → stopLeaseEnd(stopGrantedAt) (the §2.2 bound: no valid stop remains at the host after it)
 *   agent-stopped→ the operation's 070:02 report deadline; the relaunched agent's first activity ends it before that.
 * A cancellation while a stop is granted and not yet reported never shortens the mark below the lease end.
 *
 * Never reads or writes the task's outcome, never ends, starts or rebinds a session, never falls back to worker.end.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendAvailabilityEvent, PLATFORM_ACTOR, type EventActor } from '../agentTasks/events.js';
import { loadAvailabilityByFamily, recordInEffect } from '../agentTasks/availability.js';
import { HOST_LAPSE_CHECK_INS_DEFAULT } from '../agentTasks/hosts.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';
import { resolveNodeRef } from '../entityRef/nodeRef.js';
import { hostReportTimeoutMinutes } from '../hostOperations/settle.js';
import {
  CANCELLABLE_PHASES,
  CLAIM_LEASE_MS,
  CLAIMED_PHASES,
  HOST_REPORTED_REASONS,
  isRefusal,
  PROCESS_START_TIME_PATTERN,
  RELAUNCH_FAILED_REASONS,
  STOP_LEASE_MS,
  stopLeaseEnd,
  type ContextResetFailure,
  type ContextResetReason,
  type ContextResetRefusal,
  type ObservedProcess,
} from './types.js';

type Db = PrismaClient | Prisma.TransactionClient;
export type ContextResetRow = Prisma.ContextResetGetPayload<Record<string, never>>;

export const CONTEXT_RESET_REQUESTED_EVENT = 'task.context-reset-requested';
// Task-scoped, like the request: chk_agent_team_events_shape allows no hyphen in an event type's first segment.
export const CONTEXT_RESET_FAILED_EVENT = 'task.context-reset-failed';
export const CONTEXT_RESET_DONE_EVENT = 'task.context-reset-done';

/** A host step refused for a reason that changes nothing (a wrong id, a stale epoch, a step out of order). */
export class ContextResetError extends Error {
  constructor(
    readonly code:
      | 'CONTEXT_RESET_NOT_FOUND'
      | 'STALE_EPOCH'
      | 'CONTEXT_RESET_WRONG_PHASE'
      | 'RECOVERY_REF_INVALID'
      | 'HOST_OPERATION_NOT_COLLECTED'
      | 'BAD_CONTEXT_RESET_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ContextResetError';
  }
}

/** What a host step answered: the reset as it now is, and whether this step was refused (the reset then ended). */
export type ContextResetStep = { reset: ContextResetRow; refused: ContextResetReason | null; replayed: boolean };

/** Test seam: runs inside the issue step, after its eligibility reads and before its first insert. */
export const __contextResetTesting: { beforeIssueInsert?: (tx: Prisma.TransactionClient) => Promise<void> } = {};

// ── Reads ─────────────────────────────────────────────────────────────────

/** The worker's last activity (the roster's derivation, src/api/graphql/schema/resolvers.worker.ts). */
async function lastActivity(tx: Db, workerId: string, now: Date): Promise<Date | null> {
  const a = await loadWorkersActivity({ db: tx } as unknown as Context, [workerId], now);
  return a.get(workerId)?.lastActiveAt ?? null;
}

/**
 * Is the worker under a `resetting` mark in effect right now (cor:agt:050:27 §4)? The ONE predicate every assignment
 * path asks, through the same `recordInEffect` as the matcher, so the paths cannot drift apart.
 */
export async function isWorkerResetting(tx: Db, workerId: string, appId: string, now: Date): Promise<boolean> {
  const view = (await loadAvailabilityByFamily(tx, [{ id: workerId, appId, families: [] }], now)).get(workerId);
  return Boolean(view?.ownInEffect && view.own?.reason === 'resetting');
}

/** The stop lease still outstanding on a reset: granted, not yet reported acted on, and not yet closed at `now`. */
export function outstandingLeaseEnd(r: Pick<ContextResetRow, 'stopGrantedAt' | 'stopLeaseMs' | 'agentStoppedAt'>, now: Date): Date | null {
  if (!r.stopGrantedAt || !r.stopLeaseMs || r.agentStoppedAt) return null;
  const end = stopLeaseEnd(r.stopGrantedAt, r.stopLeaseMs);
  return end.getTime() > now.getTime() ? end : null;
}

/**
 * The latest stop lease still outstanding on ANY of the worker's resets, ended ones included (#2255 review, Diego):
 * the obligation belongs to the grant the host holds, not to the reset's phase or to whichever record is current.
 * A reset that ended after its grant moved its epoch, so the host's "stopped" report is refused and the grant counts
 * as outstanding until its lease ends. Every writer that could expose the worker floors at this.
 */
export async function outstandingStopLease(tx: Db, workerId: string, now: Date): Promise<{ resetId: string; leaseEnd: Date } | null> {
  const rows = await tx.contextReset.findMany({
    where: {
      workerId, stopGrantedAt: { not: null, gt: new Date(now.getTime() - 60 * 60_000) }, agentStoppedAt: null,
    },
    select: { id: true, stopGrantedAt: true, stopLeaseMs: true, agentStoppedAt: true },
  });
  let best: { resetId: string; leaseEnd: Date } | null = null;
  for (const r of rows) {
    const end = outstandingLeaseEnd(r, now);
    if (end && (!best || end > best.leaseEnd)) best = { resetId: r.id, leaseEnd: end };
  }
  return best;
}

// ── Events ────────────────────────────────────────────────────────────────

async function appendResetEvent(
  tx: Prisma.TransactionClient,
  a: { appId: string; taskId: string; workerId: string; type: string; payload: Prisma.InputJsonObject; actor?: EventActor; now: Date },
): Promise<string> {
  const id = generateId();
  const actor = a.actor ?? PLATFORM_ACTOR;
  await tx.agentTeamEvent.create({
    data: {
      id,
      appId: a.appId,
      taskId: a.taskId,
      type: a.type,
      actorUserId: actor.userId,
      actorWorkerId: actor.workerId,
      actorAgentId: actor.agentId,
      actorRunId: actor.runId ?? null,
      subjectWorkerId: a.workerId,
      payload: a.payload,
      createdAt: a.now,
    },
  });
  return id;
}

// ── Issue (in the finishing transaction) ─────────────────────────────────

/**
 * In a task's finish or cancel transaction, with the task row and the assignee's per-worker lock held: record a reset
 * if cor:agt:050:27 §2 holds. Returns the reset's id and whether an operation was issued, or null when none is
 * requested. Throws only on a database error; the caller runs it inside a savepoint so the finish never depends on it.
 */
export async function requestContextReset(
  tx: Prisma.TransactionClient,
  a: {
    appId: string;
    task: { id: string; assigneeWorkerId: string | null };
    /** The task was `started` when it finished or was cancelled. */
    wasStarted: boolean;
    /** requestSessionEnd asked for a session end for this task (R119: that wins). */
    sessionEndRequested: boolean;
    actor: EventActor;
    now: Date;
  },
): Promise<{ resetId: string; issued: boolean } | null> {
  const workerId = a.task.assigneeWorkerId;
  if (!workerId || !a.wasStarted || a.sessionEndRequested) return null;
  // R117: the worker itself started it. A start is the assignee's only (cor:agt:050:08), so a started task reassigned
  // since then carries a `task.started` by someone else.
  const started = await tx.agentTeamEvent.findFirst({
    where: { taskId: a.task.id, type: 'task.started', actorWorkerId: workerId },
    select: { id: true },
  });
  if (!started) return null;
  // R115/R116: the Agent's setting, held like the matcher holds usesTasks.
  const [agent] = await tx.$queryRaw<{ on: boolean }[]>`
    SELECT a.reset_context_after_task AS "on" FROM agents a
    JOIN workers w ON w.agent_id = a.id WHERE w.id = ${workerId} FOR SHARE OF a`;
  if (!agent?.on) return null;
  const otherStarted = await tx.agentTask.count({ where: { assigneeWorkerId: workerId, status: 'started', id: { not: a.task.id } } });
  if (otherStarted > 0) return null;
  // R120: a team pause suppresses it. The App's anchors are held by the task write, and the pause writer takes them
  // exclusively, so this read is the pause in force.
  const app = await tx.app.findUnique({ where: { id: a.appId }, select: { teamPausedAt: true } });
  if (!app || app.teamPausedAt) return null;
  // The session, chosen under the per-worker lock (a bind takes it too, so no new session can appear meanwhile).
  const [session] = await tx.$queryRaw<{ id: string; host: string | null }[]>`
    SELECT id, host FROM sessions
    WHERE worker_id = ${workerId} AND ended_at IS NULL AND deleted_at IS NULL
    ORDER BY started_at DESC, id DESC LIMIT 1`;
  if (!session) return null;
  // A live host that registers the worker and declared the capability. registerHost takes the App's stop fence
  // exclusively and every task write holds it shared, so the registrations read here cannot change before commit.
  const hosts = await tx.$queryRaw<{ hostId: string }[]>`
    SELECT r.host_id AS "hostId"
    FROM host_registrations r
    JOIN host_registration_workers w ON w.registration_id = r.id AND w.worker_id = ${workerId}
    LEFT JOIN agent_task_stall_schedule s ON s.app_id = r.app_id
    WHERE r.app_id = ${a.appId} AND r.lost_at IS NULL
      AND 'worker.reset-context' = ANY (r.capabilities)
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * COALESCE(s.host_lapse_check_ins, ${HOST_LAPSE_CHECK_INS_DEFAULT}))
          >= ${toNaiveUtc(a.now)}::timestamp
    ORDER BY r.host_id`;
  const hostId = hosts.find((h) => h.hostId === session.host)?.hostId ?? hosts[0]?.hostId ?? null;
  await __contextResetTesting.beforeIssueInsert?.(tx);

  const resetId = generateId();
  const operationId = hostId ? generateId() : null;
  // Once per finish (§5): a task ends once, and taskId is unique; a duplicate inserts nothing and requests nothing.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO context_resets (id, app_id, worker_id, session_id, task_id, host_id, host_operation_id, phase, reason,
                                requested_at, ended_at)
    VALUES (${resetId}, ${a.appId}, ${workerId}, ${session.id}, ${a.task.id}, ${hostId}, ${operationId},
            ${hostId ? 'requested' : 'failed'}, ${hostId ? null : 'HOST_UNSUPPORTED'},
            ${toNaiveUtc(a.now)}::timestamp, ${hostId ? null : toNaiveUtc(a.now)}::timestamp)
    ON CONFLICT (task_id) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) return null;
  if (hostId && operationId) {
    await tx.hostOperation.create({
      data: {
        id: operationId,
        appId: a.appId,
        hostId,
        type: 'worker.reset-context',
        args: { workerId, sessionId: session.id, taskId: a.task.id, resetId },
        workerId,
        issuedBy: 'platform',
      },
    });
  }
  await appendResetEvent(tx, {
    appId: a.appId, taskId: a.task.id, workerId, type: CONTEXT_RESET_REQUESTED_EVENT, actor: a.actor, now: a.now,
    payload: { resetId, sessionId: session.id, issued: hostId !== null, operationId, hostId, reason: hostId ? null : 'HOST_UNSUPPORTED' },
  });
  if (!hostId) {
    await appendResetEvent(tx, {
      appId: a.appId, taskId: a.task.id, workerId, type: CONTEXT_RESET_FAILED_EVENT, now: a.now,
      payload: { resetId, phase: 'failed', reason: 'HOST_UNSUPPORTED' },
    });
  }
  return { resetId, issued: hostId !== null };
}

/**
 * The issue step, isolated in a SAVEPOINT (the #2162 gate's fault boundary): an error inside it rolls back to the
 * savepoint, so the finishing transaction is never left aborted and still commits its outcome, with no reset. Only a
 * failure to roll back to the savepoint propagates, and that fails the finish, never hides inside it.
 */
export async function requestContextResetSafely(
  tx: Prisma.TransactionClient,
  a: Parameters<typeof requestContextReset>[1],
): Promise<{ resetId: string; issued: boolean } | null> {
  await tx.$executeRawUnsafe('SAVEPOINT context_reset_issue');
  try {
    const out = await requestContextReset(tx, a);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT context_reset_issue');
    return out;
  } catch (err) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT context_reset_issue');
    console.error('[context-reset] the reset request failed; the task ends without one:', a.task.id, err);
    return null;
  }
}

// ── The mark ──────────────────────────────────────────────────────────────

type MarkRow = {
  state: string; reason: string | null; until: Date | null; setAt: Date; setBy: string; clearsOnActivityAfter: Date | null;
  contextResetId: string | null;
};

async function lockMark(tx: Prisma.TransactionClient, workerId: string): Promise<MarkRow | null> {
  const [row] = await tx.$queryRaw<MarkRow[]>`
    SELECT state, reason, until, set_at AS "setAt", set_by AS "setBy", clears_on_activity_after AS "clearsOnActivityAfter",
           context_reset_id AS "contextResetId"
    FROM worker_availability WHERE worker_id = ${workerId} FOR UPDATE`;
  return row ?? null;
}

const isResettingMark = (m: MarkRow | null): m is MarkRow =>
  m !== null && m.state === 'unavailable' && m.reason === 'resetting' && m.setBy === 'context-reset';

/** The mark is this reset's own (#2255 review, Glen): an older reset never moves or releases a newer one's. */
const ownsMark = (m: MarkRow | null, r: Pick<ContextResetRow, 'id'>): m is MarkRow => isResettingMark(m) && m.contextResetId === r.id;

const PLAIN_SETTER = { setByUserId: null, setByWorkerId: null, setByAgentId: null, setByHostId: null };

/** Set the worker's `resetting` mark, owned by the reset `r`, with an availability event. */
async function setMark(tx: Prisma.TransactionClient, r: Pick<ContextResetRow, 'id' | 'appId' | 'workerId'>, until: Date, now: Date): Promise<void> {
  const data = {
    state: 'unavailable', reason: 'resetting', until, setAt: now, setBy: 'context-reset', clearsOnActivityAfter: null,
    contextResetId: r.id, ...PLAIN_SETTER,
  };
  await tx.workerAvailability.upsert({ where: { workerId: r.workerId }, create: { workerId: r.workerId, ...data }, update: data });
  await appendAvailabilityEvent(tx, {
    appId: r.appId, actor: PLATFORM_ACTOR, createdAt: now,
    event: { kind: 'worker', workerId: r.workerId, state: 'unavailable', reason: 'resetting', until, setBy: 'context-reset', resetId: r.id },
  });
}

/** Move a live `resetting` mark's lapse (and, after the stop, the instant activity must postdate). No event: same mark. */
async function moveMark(tx: Prisma.TransactionClient, workerId: string, data: { until: Date; clearsOnActivityAfter?: Date }): Promise<void> {
  await tx.workerAvailability.update({ where: { workerId }, data });
}

/**
 * A writer was about to make the worker available while a stop grant is outstanding (§2.2): keep it unavailable until
 * the lease ends instead. A record still in effect lapses at the lease end; otherwise the `resetting` mark of the reset
 * holding the grant is raised again until then. Either way it lifts by itself, through the lapse sweep. The caller
 * holds the per-worker lock and the availability row.
 */
export async function holdForStopLease(
  tx: Prisma.TransactionClient, w: { workerId: string; appId: string }, lease: { resetId: string; leaseEnd: Date }, now: Date,
): Promise<void> {
  const mark = await lockMark(tx, w.workerId);
  if (mark && recordInEffect(mark, now)) {
    await moveMark(tx, w.workerId, { until: lease.leaseEnd });
    return;
  }
  await setMark(tx, { id: lease.resetId, appId: w.appId, workerId: w.workerId }, lease.leaseEnd, now);
}

/**
 * Release the reset's mark under the §2 rule. With a stop granted and not reported acted on, the mark is NOT lifted
 * before the lease's end: its `until` is pulled in to that instant (never pushed out) and `releasePendingAt` records
 * it; the lapse sweep writes the release down then. Otherwise it is released now, with an event. A mark that is not
 * this reset's (someone else's record, or none) is left alone. Returns when the mark lifts.
 */
async function releaseMark(tx: Prisma.TransactionClient, r: ContextResetRow, now: Date): Promise<Date | null> {
  const mark = await lockMark(tx, r.workerId);
  if (!ownsMark(mark, r) || !recordInEffect(mark, now)) return null;
  const lease = (await outstandingStopLease(tx, r.workerId, now))?.leaseEnd ?? null;
  if (lease) {
    if (!mark.until || mark.until.getTime() > lease.getTime()) await moveMark(tx, r.workerId, { until: lease });
    await tx.contextReset.update({ where: { id: r.id }, data: { releasePendingAt: lease } });
    return lease;
  }
  await tx.workerAvailability.update({
    where: { workerId: r.workerId },
    data: { state: 'available', reason: null, until: null, setAt: now, setBy: 'context-reset', clearsOnActivityAfter: null, contextResetId: null, ...PLAIN_SETTER },
  });
  await appendAvailabilityEvent(tx, {
    appId: r.appId, actor: PLATFORM_ACTOR, createdAt: now,
    event: { kind: 'worker', workerId: r.workerId, state: 'available', reason: null, until: null, setBy: 'context-reset', resetId: r.id },
  });
  return now;
}

// ── Ending a reset ────────────────────────────────────────────────────────

/**
 * End a reset refused or failed: terminal, the epoch moved (so every later host step is STALE_EPOCH), an event for the
 * coordinator (§6), and its mark released under §2 unless the caller writes the worker's record itself.
 */
async function endReset(
  tx: Prisma.TransactionClient,
  r: ContextResetRow,
  reason: ContextResetReason,
  now: Date,
  opts: { releaseMark?: boolean } = {},
): Promise<ContextResetRow> {
  const ended = await tx.contextReset.update({
    where: { id: r.id },
    data: { phase: isRefusal(reason) ? 'refused' : 'failed', reason, endedAt: now, epoch: { increment: 1 } },
  });
  await appendResetEvent(tx, {
    appId: r.appId, taskId: r.taskId, workerId: r.workerId, type: CONTEXT_RESET_FAILED_EVENT, now,
    payload: { resetId: r.id, phase: ended.phase, reason, fromPhase: r.phase },
  });
  if (opts.releaseMark !== false && (CLAIMED_PHASES as readonly string[]).includes(r.phase)) await releaseMark(tx, ended, now);
  return tx.contextReset.findUniqueOrThrow({ where: { id: r.id } });
}

// ── The host's steps ──────────────────────────────────────────────────────

/** The host a step is made by: the key's own App and host (cor:agt:070:04), never a request field. */
export type ResetHost = { appId: string; hostId: string };

/**
 * Lock and load a reset for a host step, in the #2162 order: the per-worker lock, the worker's availability row, then
 * the reset row. Another App's or another host's reset reads as not found. The operation must have been collected by
 * this host (cor:agt:070:04): a host acts on what it collected, never on an id it guessed.
 */
async function lockForHost(tx: Prisma.TransactionClient, host: ResetHost, resetId: string): Promise<ContextResetRow> {
  const notFound = () => new ContextResetError('CONTEXT_RESET_NOT_FOUND', 'Context reset not found.');
  if (typeof resetId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(resetId)) throw notFound();
  const head = await tx.contextReset.findUnique({ where: { id: resetId }, select: { workerId: true, appId: true, hostId: true } });
  if (!head || head.appId !== host.appId || head.hostId !== host.hostId) throw notFound();
  await lockWorkersForAssignment(tx, [head.workerId]);
  await lockMark(tx, head.workerId);
  await tx.$queryRaw`SELECT id FROM context_resets WHERE id = ${resetId} FOR UPDATE`;
  const r = await tx.contextReset.findUniqueOrThrow({ where: { id: resetId } });
  const op = r.hostOperationId ? await tx.hostOperation.findUnique({ where: { id: r.hostOperationId }, select: { status: true } }) : null;
  if (!op) throw notFound();
  if (op.status === 'issued') {
    throw new ContextResetError('HOST_OPERATION_NOT_COLLECTED', 'Collect the reset\'s operation before acting on it.');
  }
  return r;
}

function requireEpoch(r: ContextResetRow, epoch: unknown): void {
  if (!Number.isInteger(epoch) || epoch !== r.epoch) {
    throw new ContextResetError('STALE_EPOCH', `This reset is at epoch ${r.epoch}; a step naming another is refused.`);
  }
}

function parseProcess(p: unknown): ObservedProcess {
  const v = (p ?? {}) as { pid?: unknown; startTime?: unknown };
  if (!Number.isInteger(v.pid) || (v.pid as number) < 1 || (v.pid as number) > 2 ** 31 - 1
      || typeof v.startTime !== 'string' || !PROCESS_START_TIME_PATTERN.test(v.startTime)) {
    throw new ContextResetError('BAD_CONTEXT_RESET_INPUT', 'process is {pid: a positive integer, startTime: a token}.');
  }
  return { pid: v.pid as number, startTime: v.startTime };
}

const sameProcess = (a: unknown, b: ObservedProcess): boolean => {
  const x = (a ?? {}) as { pid?: unknown; startTime?: unknown };
  return x.pid === b.pid && x.startTime === b.startTime;
};

const claimLapsed = (r: ContextResetRow, now: Date): boolean =>
  !r.claimedAt || r.claimedAt.getTime() + CLAIM_LEASE_MS <= now.getTime();

const step = (reset: ContextResetRow, refused: ContextResetReason | null = null, replayed = false): ContextResetStep => ({ reset, refused, replayed });

/** Replay an ended reset's own refusal at the step that refused it; any other step on it is out of order. */
function replayEnded(r: ContextResetRow): ContextResetStep {
  return step(r, (r.reason as ContextResetReason | null) ?? null, true);
}

/**
 * The claim (§1.5): take the fence. Names the epoch the host collected (0). On success the worker is `resetting`
 * until the claim lease, the epoch moves to 1, and the process the host observed is recorded. The first failing check
 * refuses and ends the reset; nothing else changes.
 */
export async function claimContextReset(
  tx: Prisma.TransactionClient, host: ResetHost, resetId: string, epoch: unknown, process: unknown, now: Date,
): Promise<ContextResetStep> {
  const observed = parseProcess(process);
  const r = await lockForHost(tx, host, resetId);
  // A replay of a claim that succeeded names the epoch it was made at; one that was refused, the epoch it left.
  if (r.phase !== 'requested') {
    if (r.claimedAt && epoch === r.epoch - 1 && sameProcess(r.claimProcess, observed) && !r.endedAt) return step(r, null, true);
    if (r.endedAt && !r.claimedAt && epoch === r.epoch - 1) return replayEnded(r);
    requireEpoch(r, epoch);
    throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; it is claimed once.`);
  }
  requireEpoch(r, epoch);
  const refuse = (reason: ContextResetRefusal | ContextResetFailure) => endReset(tx, r, reason, now).then((e) => step(e, reason));

  const [worker] = await tx.$queryRaw<{ retiredAt: Date | null; on: boolean }[]>`
    SELECT w.retired_at AS "retiredAt", a.reset_context_after_task AS "on"
    FROM workers w JOIN agents a ON a.id = w.agent_id WHERE w.id = ${r.workerId}`;
  if (!worker || worker.retiredAt) return refuse('WORKER_GONE');
  // (a) the session is still the worker's open session, and its only one.
  const open = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sessions WHERE worker_id = ${r.workerId} AND ended_at IS NULL AND deleted_at IS NULL`;
  if (open.length !== 1 || open[0]!.id !== r.sessionId) return refuse('SESSION_CHANGED');
  // (b) no open task, pending or started.
  const tasks = await tx.agentTask.count({ where: { assigneeWorkerId: r.workerId, status: { in: ['pending', 'started'] } } });
  if (tasks > 0) return refuse('OTHER_WORK');
  // (c) no other availability record in effect.
  const view = (await loadAvailabilityByFamily(tx, [{ id: r.workerId, appId: r.appId, families: [] }], now)).get(r.workerId);
  // An ended reset's stop grant still outstanding keeps the worker out too (#2255 review): no writer exposes it before
  // the lease ends, and no new claim takes it either.
  if (view?.ownInEffect || (await outstandingStopLease(tx, r.workerId, now))) return refuse('UNAVAILABLE');
  const app = await tx.app.findUnique({ where: { id: r.appId }, select: { teamPausedAt: true } });
  if (!app || app.teamPausedAt) return refuse('PAUSED');
  if (!worker.on) return refuse('SETTING_OFF');

  const claimed = await tx.contextReset.update({
    where: { id: r.id },
    data: { phase: 'claimed', claimedAt: now, claimProcess: observed, epoch: { increment: 1 } },
  });
  await setMark(tx, claimed, new Date(now.getTime() + CLAIM_LEASE_MS), now);
  return step(claimed);
}

/**
 * Register the durable recovery reference BEFORE any process control (§3.4): a checkpoint node in the worker's own
 * working memory, for the reset's own session and task. A wrong reference is refused RECOVERY_REF_INVALID and changes
 * nothing; the host may register a right one while the claim lease runs.
 */
export async function registerContextResetRecovery(
  tx: Prisma.TransactionClient, host: ResetHost, resetId: string, epoch: unknown,
  ref: { checkpointNode: unknown; sessionId: unknown; taskId: unknown }, now: Date,
): Promise<ContextResetStep> {
  const r = await lockForHost(tx, host, resetId);
  requireEpoch(r, epoch);
  if (r.phase !== 'claimed') {
    const stored = (r.recoveryRef ?? null) as { checkpointNodeId?: string } | null;
    if (r.recoveryRegisteredAt && !r.endedAt && stored) return step(r, null, true);
    throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; recovery is registered once, after the claim.`);
  }
  if (claimLapsed(r, now)) return endReset(tx, r, 'CLAIM_LAPSED', now).then((e) => step(e, 'CLAIM_LAPSED'));
  const invalid = (why: string) => new ContextResetError('RECOVERY_REF_INVALID', why);
  if (ref.sessionId !== r.sessionId) throw invalid('The recovery reference names another session.');
  if (ref.taskId !== r.taskId) throw invalid('The recovery reference names another task.');
  if (typeof ref.checkpointNode !== 'string' || ref.checkpointNode.trim() === '') throw invalid('Name the checkpoint node.');
  const worker = await tx.worker.findUnique({ where: { id: r.workerId }, select: { memoryId: true } });
  let nodeId: string | null = null;
  try {
    nodeId = (await resolveNodeRef(tx as unknown as PrismaClient, ref.checkpointNode.trim())).id;
  } catch {
    nodeId = null;
  }
  const node = nodeId ? await tx.node.findFirst({ where: { id: nodeId, deletedAt: null }, select: { memoryId: true } }) : null;
  if (!node || !worker?.memoryId || node.memoryId !== worker.memoryId) {
    throw invalid("The checkpoint is a live node in the worker's own working memory.");
  }
  const registered = await tx.contextReset.update({
    where: { id: r.id },
    data: { phase: 'checkpointed', recoveryRef: { checkpointNodeId: nodeId!, sessionId: r.sessionId, taskId: r.taskId }, recoveryRegisteredAt: now },
  });
  return step(registered);
}

/**
 * Authorize the stop (§2.1): at most ONE grant per claim; a replay returns the same grant (the same `stopGrantedAt`
 * and lease), never a fresh window. Requires the recovery registered, the claim lease running, the same agent process
 * the claim observed, and no session activity since the claim (R5: the old agent acting again means it is not idle).
 * The mark's `until` becomes the lease end (§2.2).
 */
export async function authorizeContextResetStop(
  tx: Prisma.TransactionClient, host: ResetHost, resetId: string, epoch: unknown, process: unknown, now: Date,
): Promise<ContextResetStep> {
  const observed = parseProcess(process);
  const r = await lockForHost(tx, host, resetId);
  requireEpoch(r, epoch);
  if (r.stopGrantedAt && !r.endedAt) {
    if (!sameProcess(r.claimProcess, observed)) {
      throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', 'The stop was granted for another process.');
    }
    return step(r, null, true);
  }
  if (r.phase === 'claimed') return endReset(tx, r, 'NO_RECOVERY_REF', now).then((e) => step(e, 'NO_RECOVERY_REF'));
  if (r.phase !== 'checkpointed') {
    throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; a stop is authorized after recovery is registered.`);
  }
  if (claimLapsed(r, now)) return endReset(tx, r, 'CLAIM_LAPSED', now).then((e) => step(e, 'CLAIM_LAPSED'));
  if (!sameProcess(r.claimProcess, observed)) return endReset(tx, r, 'PROCESS_CHANGED', now).then((e) => step(e, 'PROCESS_CHANGED'));
  const active = await lastActivity(tx, r.workerId, now);
  if (active && r.claimedAt && active.getTime() > r.claimedAt.getTime()) {
    return endReset(tx, r, 'NOT_IDLE', now).then((e) => step(e, 'NOT_IDLE'));
  }
  const granted = await tx.contextReset.update({
    where: { id: r.id },
    data: { phase: 'stop-granted', stopGrantedAt: now, stopLeaseMs: STOP_LEASE_MS },
  });
  const mark = await lockMark(tx, r.workerId);
  if (ownsMark(mark, r)) await moveMark(tx, r.workerId, { until: stopLeaseEnd(now, STOP_LEASE_MS) });
  return step(granted);
}

/**
 * The host reports the old agent stopped. From here the mark lasts until the relaunched agent's first activity
 * (§4, R6), a `relaunchFailed`, or the operation's report deadline. A mark that already lapsed with the lease is not
 * raised again: the worker may have been given work since, and the recovery prompt reads its task list.
 */
export async function reportContextResetAgentStopped(
  tx: Prisma.TransactionClient, host: ResetHost, resetId: string, epoch: unknown, now: Date,
): Promise<ContextResetStep> {
  const r = await lockForHost(tx, host, resetId);
  requireEpoch(r, epoch);
  if (r.agentStoppedAt && !r.endedAt) return step(r, null, true);
  if (r.phase !== 'stop-granted') {
    throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; the agent is reported stopped after a granted stop.`);
  }
  const stopped = await tx.contextReset.update({ where: { id: r.id }, data: { phase: 'agent-stopped', agentStoppedAt: now } });
  const mark = await lockMark(tx, r.workerId);
  if (ownsMark(mark, r) && recordInEffect(mark, now)) {
    const op = await tx.hostOperation.findUniqueOrThrow({ where: { id: r.hostOperationId! }, select: { collectedAt: true } });
    const minutes = await hostReportTimeoutMinutes(tx, r.appId);
    const deadline = new Date((op.collectedAt ?? now).getTime() + minutes * 60_000);
    await moveMark(tx, r.workerId, { until: deadline.getTime() > now.getTime() ? deadline : new Date(now.getTime() + 60_000), clearsOnActivityAfter: now });
  }
  return step(stopped);
}

/** The host reports the agent relaunched under its wrapper, with the new process. The mark waits for its activity. */
export async function reportContextResetRelaunched(
  tx: Prisma.TransactionClient, host: ResetHost, resetId: string, epoch: unknown, process: unknown, now: Date,
): Promise<ContextResetStep> {
  const relaunch = parseProcess(process);
  const r = await lockForHost(tx, host, resetId);
  requireEpoch(r, epoch);
  if (r.relaunchedAt && !(r.phase === 'failed' || r.phase === 'refused')) return step(r, null, true);
  if (r.phase !== 'agent-stopped') {
    throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; a relaunch is reported after the agent stopped.`);
  }
  return step(await tx.contextReset.update({ where: { id: r.id }, data: { phase: 'relaunched', relaunchedAt: now, relaunchProcess: relaunch } }));
}

/** The host reports a failure after the claim that it saw (a checkpoint, staging or relaunch failure). */
export async function reportContextResetRelaunchFailed(
  tx: Prisma.TransactionClient, host: ResetHost, resetId: string, epoch: unknown, reason: unknown, now: Date,
): Promise<ContextResetStep> {
  if (typeof reason !== 'string' || !(RELAUNCH_FAILED_REASONS as readonly string[]).includes(reason)) {
    throw new ContextResetError('BAD_CONTEXT_RESET_INPUT', `reason is one of ${RELAUNCH_FAILED_REASONS.join(', ')}.`);
  }
  const r = await lockForHost(tx, host, resetId);
  if (r.endedAt && r.reason === reason && epoch === r.epoch - 1) return replayEnded(r);
  requireEpoch(r, epoch);
  if (!(['claimed', 'checkpointed', 'stop-granted', 'agent-stopped'] as string[]).includes(r.phase)) {
    throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; nothing is left to fail.`);
  }
  const ended = await endReset(tx, r, reason as ContextResetFailure, now);
  return step(ended, reason as ContextResetFailure);
}

/**
 * The 070:02 report of a reset's operation, in the report's transaction (the operation row held): SUCCEEDED means the
 * reset completed, so it must be relaunched; FAILED names its closed reason first (`"<REASON>: free text"`). A reset
 * already ended by a step keeps its outcome. Throws a ContextResetError for a report the reset cannot take.
 */
export async function onContextResetReported(
  tx: Prisma.TransactionClient, op: { id: string; appId: string; hostId: string }, outcome: 'succeeded' | 'failed', failureReason: string | null, now: Date,
): Promise<void> {
  const head = await tx.contextReset.findUnique({ where: { hostOperationId: op.id }, select: { id: true } });
  if (!head) return;
  const r = await lockForHost(tx, { appId: op.appId, hostId: op.hostId }, head.id);
  if (outcome === 'succeeded') {
    if (r.phase === 'done') return;
    if (r.phase !== 'relaunched') {
      throw new ContextResetError('CONTEXT_RESET_WRONG_PHASE', `This reset is ${r.phase}; report it SUCCEEDED once the agent is relaunched.`);
    }
    await tx.contextReset.update({ where: { id: r.id }, data: { phase: 'done', endedAt: now } });
    await appendResetEvent(tx, {
      appId: r.appId, taskId: r.taskId, workerId: r.workerId, type: CONTEXT_RESET_DONE_EVENT, now, payload: { resetId: r.id },
    });
    return;
  }
  const code = (failureReason ?? '').split(/[\s:]/, 1)[0] ?? '';
  if (!(HOST_REPORTED_REASONS as readonly string[]).includes(code) && !r.endedAt) {
    throw new ContextResetError(
      'BAD_CONTEXT_RESET_INPUT',
      `A reset's failure starts with its reason: one of ${HOST_REPORTED_REASONS.join(', ')}, then ": " and any detail.`,
    );
  }
  if (r.endedAt) return;
  await endReset(tx, r, code as ContextResetReason, now);
}

// ── Cancellation by another writer ────────────────────────────────────────

/**
 * A writer that decides the worker's availability itself (a hand clear, the worker marking itself, a host marking it
 * down) cancels its live reset (§2.4): the claim ends now, the epoch moves, and every later host step is STALE_EPOCH.
 * The caller holds the per-worker lock and writes the record. Returns the worker's outstanding stop lease
 * (`outstandingStopLease`), live reset or not: the caller must not make the worker available before it ends
 * (`holdForStopLease`), nor write an `until` earlier than it.
 */
export async function cancelLiveReset(
  tx: Prisma.TransactionClient, workerId: string, reason: 'CANCELLED_BY_CLEAR' | 'HOST_LOST', now: Date,
): Promise<{ resetId: string; leaseEnd: Date } | null> {
  const live = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM context_resets
    WHERE worker_id = ${workerId} AND phase IN (${Prisma.join([...CANCELLABLE_PHASES].filter((p) => p !== 'requested'))})
    ORDER BY requested_at DESC, id DESC
    FOR UPDATE`;
  for (const { id } of live) {
    const r = await tx.contextReset.findUniqueOrThrow({ where: { id } });
    const lease = outstandingLeaseEnd(r, now);
    await endReset(tx, r, reason, now, { releaseMark: false });
    if (lease) await tx.contextReset.update({ where: { id }, data: { releasePendingAt: lease } });
  }
  return outstandingStopLease(tx, workerId, now);
}

// ── The sweep ─────────────────────────────────────────────────────────────

/** Resets per page of the sweep. */
const SWEEP_PAGE = 500;

/**
 * The reset sweep (from the stall evaluator's tick): end every reset whose claim lapsed (CLAIM_LAPSED), whose session
 * ended (SESSION_ENDED), whose worker was retired (WORKER_GONE), or whose operation settled without the protocol
 * finishing (the 070:02 timeout or a lost host: REPORT_TIMEOUT / HOST_LOST, or RELAUNCH_UNVERIFIED after a granted
 * stop); release its mark under §2. Then write down every `resetting` mark the relaunched agent's activity ended.
 * Each reset is decided again in its own transaction under its locks. Returns how many resets it ended.
 */
export async function sweepContextResets(db: PrismaClient, now = new Date()): Promise<number> {
  const at = Prisma.sql`${toNaiveUtc(now)}::timestamp`;
  const due = await db.$queryRaw<{ id: string; workerId: string }[]>`
    SELECT r.id, r.worker_id AS "workerId" FROM context_resets r
    LEFT JOIN host_operations o ON o.id = r.host_operation_id
    LEFT JOIN sessions s ON s.id = r.session_id
    LEFT JOIN workers w ON w.id = r.worker_id
    WHERE r.ended_at IS NULL AND (
      (r.phase IN ('claimed', 'checkpointed') AND r.claimed_at + make_interval(secs => ${CLAIM_LEASE_MS / 1000}) <= ${at})
      OR o.status IN ('succeeded', 'failed')
      OR s.id IS NULL OR s.ended_at IS NOT NULL OR s.deleted_at IS NOT NULL
      OR w.retired_at IS NOT NULL)
    ORDER BY r.requested_at, r.id
    LIMIT ${SWEEP_PAGE}`;
  let ended = 0;
  for (const d of due) {
    try {
      if (await sweepOne(db, d, now)) ended += 1;
    } catch (err) {
      console.error('[context-reset] sweeping a reset failed:', d.id, err);
    }
  }
  await clearResetMarks(db, now);
  return ended;
}

async function sweepOne(db: PrismaClient, d: { id: string; workerId: string }, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockWorkersForAssignment(tx, [d.workerId]);
    await lockMark(tx, d.workerId);
    await tx.$queryRaw`SELECT id FROM context_resets WHERE id = ${d.id} FOR UPDATE`;
    const r = await tx.contextReset.findUnique({ where: { id: d.id } });
    if (!r || r.endedAt) return false;
    const op = r.hostOperationId
      ? await tx.hostOperation.findUnique({ where: { id: r.hostOperationId }, select: { status: true, collectedAt: true, failureReason: true } })
      : null;
    const session = await tx.session.findUnique({ where: { id: r.sessionId }, select: { endedAt: true, deletedAt: true } });
    const worker = await tx.worker.findUnique({ where: { id: r.workerId }, select: { retiredAt: true } });
    let reason: ContextResetReason | null = null;
    if (op?.status === 'succeeded' && r.phase === 'relaunched') {
      await tx.contextReset.update({ where: { id: r.id }, data: { phase: 'done', endedAt: now } });
      await appendResetEvent(tx, {
        appId: r.appId, taskId: r.taskId, workerId: r.workerId, type: CONTEXT_RESET_DONE_EVENT, now, payload: { resetId: r.id },
      });
      return true;
    }
    if (!worker || worker.retiredAt) reason = 'WORKER_GONE';
    else if (!session || session.endedAt || session.deletedAt) reason = 'SESSION_ENDED';
    else if (op?.status === 'failed' || op?.status === 'succeeded') {
      const code = (op.failureReason ?? '').split(/[\s:]/, 1)[0] ?? '';
      reason = (HOST_REPORTED_REASONS as readonly string[]).includes(code) ? code as ContextResetReason
        : r.phase === 'stop-granted' || r.phase === 'agent-stopped' ? 'RELAUNCH_UNVERIFIED'
        : !op.collectedAt ? 'HOST_LOST'
        : 'REPORT_TIMEOUT';
    } else if ((r.phase === 'claimed' || r.phase === 'checkpointed') && claimLapsed(r, now)) reason = 'CLAIM_LAPSED';
    if (!reason) return false;
    await endReset(tx, r, reason, now);
    return true;
  });
}

/**
 * Write down every `resetting` mark the relaunched agent's activity ended (§4, R6), as `clearStalledMarks` does for a
 * stall: the record becomes available, set by the reset, with one event. Guarded on the record as read.
 */
export async function clearResetMarks(db: PrismaClient, now: Date): Promise<number> {
  const marks = await db.workerAvailability.findMany({
    where: { state: 'unavailable', reason: 'resetting', clearsOnActivityAfter: { not: null } },
    select: { workerId: true, setAt: true, clearsOnActivityAfter: true, worker: { select: { appId: true } } },
    take: SWEEP_PAGE,
  });
  if (marks.length === 0) return 0;
  const activity = await loadWorkersActivity({ db } as unknown as Context, marks.map((m) => m.workerId), now);
  let cleared = 0;
  for (const m of marks) {
    const at = activity.get(m.workerId)?.lastActiveAt;
    if (!at || at.getTime() <= m.clearsOnActivityAfter!.getTime()) continue;
    const done = await db.$transaction(async (tx) => {
      await lockWorkersForAssignment(tx, [m.workerId]);
      if (await outstandingStopLease(tx, m.workerId, now)) return false;
      const n = await tx.workerAvailability.updateMany({
        where: { workerId: m.workerId, state: 'unavailable', reason: 'resetting', setAt: m.setAt, clearsOnActivityAfter: m.clearsOnActivityAfter },
        data: { state: 'available', reason: null, until: null, setAt: now, setBy: 'context-reset', clearsOnActivityAfter: null, contextResetId: null, ...PLAIN_SETTER },
      });
      if (n.count === 0) return false;
      await appendAvailabilityEvent(tx, {
        appId: m.worker.appId, actor: PLATFORM_ACTOR, createdAt: now,
        event: { kind: 'worker', workerId: m.workerId, state: 'available', reason: null, until: null, setBy: 'context-reset' },
      });
      return true;
    });
    if (done) cleared += 1;
  }
  return cleared;
}
