/**
 * #1705 — the application writer of `agent_team_events` (cor:agt:050:11).
 * #2644: SQL emits only the fixed empty platform task.released event when
 * its blocker-state transition commits, including physical FK cascades.
 *
 * An event is append-only in the database (prisma/agent-task-invariants.sql),
 * so this module's job is the half the trigger cannot check: what goes into
 * `payload`. Its builders accept ids, counts, outcome words and booleans only,
 * so no message, title, description or summary text can reach the stream
 * (cor:agt:050:11, Proposed: "an event never holds message bodies"). A caller
 * that wants to record something new adds a typed builder here rather than
 * passing a bag through.
 */

import { raiseDeliveredOnAssignment } from '../tickers/standbyAssignment.js';
import type { Prisma } from '../../generated/prisma/index.js';
import { currentActor } from '../requestActor.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';

/** The task event types T1 writes (cor:agt:050:11; `task.reassigned` is Proposed there). */
export const TASK_EVENT_TYPES = [
  'task.created',
  'task.assigned',
  'task.reassigned',
  'task.started',
  'task.progress',
  'task.finished',
  'task.cancelled',
  // #1754 — the backlog moves (cor:agt:050:02).
  'task.parked',
  'task.ready',
  'task.warning',
  'task.released', 'task.priority', 'task.blocker-added', 'task.blocker-removed',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/**
 * #1707 — the assignment events the matcher's slice writes (cor:agt:050:11):
 * `assignment.queued` when a task enters the queue (created with no
 * assignee), `assignment.matched` when the platform assigns it
 * (cor:agt:060:06). The matched event IS the assignment's record: the matcher
 * writes no `task.assigned` beside it. `assignment.unassignable` is the
 * stall evaluator's alarm (ALARM_EVENT_TYPES).
 */
export const ASSIGNMENT_EVENT_TYPES = ['assignment.queued', 'assignment.matched'] as const;

/**
 * The events that mark a worker as assigned, for "assigned least recently"
 * (cor:agt:060:06): each carries the new assignee as its subject worker.
 */
export const ASSIGNED_EVENT_TYPES = ['task.assigned', 'task.reassigned', 'assignment.matched'] as const;

/** Passive history must be excluded from EVERY later-event/activity predicate when a kind is added here. */
export const PASSIVE_EVENT_TYPES = ['task.warning'] as const;
/** #2609: only facts already readable by every team-event reader. Assignee state and future codes are excluded. */
export const RECORDED_TASK_WARNING_CODES = ['task.create.no-source', 'task.finish.open-children'] as const;
export type RecordedTaskWarningCode = (typeof RECORDED_TASK_WARNING_CODES)[number];

/** A party to a task: exactly one of a Worker or a User. */
export type TaskParty = { workerId: string; userId?: never; via?: never } | { userId: string; workerId?: never; via?: 'manager' };

/** Who acted: the human credential, and the Worker / Agent the request's session is bound to (#1610). */
export type EventActor = {
  userId: string | null; workerId: string | null; agentId: string | null;
  /** #1756: the headless run that acted. Then the three above are null. */
  runId?: string | null;
};

/** The payload each type carries. Ids, counts, outcome words and flags only — never text. */
export type TaskEventPayload =
  | { type: 'task.created'; parentTaskId: string | null; owner: TaskParty; hasAssignee: boolean }
  | { type: 'task.assigned'; assignee: TaskParty; closeSessionWhenDone: boolean }
  | { type: 'task.reassigned'; from: TaskParty; to: TaskParty; closeSessionWhenDone: boolean }
  | { type: 'task.warning'; code: RecordedTaskWarningCode }
  | { type: 'task.released' }
  | { type: 'task.priority'; priority: number }
  | { type: 'task.blocker-added' | 'task.blocker-removed'; blockerTaskId: string }
  | { type: 'task.started' }
  | { type: 'task.progress' }
  | { type: 'task.finished'; outcome: string }
  | { type: 'task.cancelled'; fromStatus: 'backlog' | 'pending' | 'started'; openChildCount: number }
  | { type: 'task.parked' }
  | { type: 'task.ready' }
  | { type: 'assignment.queued' }
  | { type: 'assignment.matched'; assignee: { workerId: string }; family: string; closeSessionWhenDone: boolean };

/** The event actor for the current request: `userId` from the credential, Worker / Agent from #1610. */
export function eventActor(userId: string | null | undefined): EventActor {
  const actor = currentActor();
  return { userId: userId ?? null, workerId: actor.workerId, agentId: actor.agentId };
}

function partyJson(p: TaskParty): Prisma.InputJsonObject {
  if (p.workerId) return { workerId: p.workerId };
  // `via: 'manager'` marks a chain entry that is there only because the person managed the App (#1761): it is
  // provenance, so a later demotion cannot turn it into an owner's standing to acknowledge.
  return p.via ? { userId: p.userId as string, via: p.via } : { userId: p.userId as string };
}

/** The stored `payload` for a typed event. Exhaustive over the union, so a new type must be built here. */
function payloadJson(e: TaskEventPayload): Prisma.InputJsonObject {
  switch (e.type) {
    case 'task.warning':
      if (!(RECORDED_TASK_WARNING_CODES as readonly string[]).includes(e.code)) throw new Error('Unsupported task warning history code');
      return { code: e.code };
    case 'task.created':
      // The owner rides task.created (#1757, cor:agt:050:01): a creator-named
      // owner is visible to the event stream from creation.
      return { parentTaskId: e.parentTaskId, owner: partyJson(e.owner), hasAssignee: e.hasAssignee };
    case 'task.assigned':
      return { assignee: partyJson(e.assignee), closeSessionWhenDone: e.closeSessionWhenDone };
    case 'task.reassigned':
      return { from: partyJson(e.from), to: partyJson(e.to), closeSessionWhenDone: e.closeSessionWhenDone };
    case 'task.priority': return { priority: e.priority };
    case 'task.blocker-added':
    case 'task.blocker-removed': return { blockerTaskId: e.blockerTaskId };
    case 'task.released':
    case 'task.started':
    case 'task.progress':
      return {};
    case 'task.finished':
      return { outcome: e.outcome };
    case 'task.cancelled':
      return { fromStatus: e.fromStatus, openChildCount: e.openChildCount };
    case 'task.parked':
    case 'task.ready':
    case 'assignment.queued':
      return {};
    case 'assignment.matched':
      return { assignee: partyJson(e.assignee), family: e.family, closeSessionWhenDone: e.closeSessionWhenDone };
  }
}

/** The worker an event concerns: the (new) assignee when it is a worker. */
function subjectWorkerId(e: TaskEventPayload): string | null {
  if (e.type === 'task.assigned') return e.assignee.workerId ?? null;
  if (e.type === 'task.reassigned') return e.to.workerId ?? null;
  if (e.type === 'assignment.matched') return e.assignee.workerId;
  return null;
}

/**
 * Append one ordinary (non-alarm) task event, inside the caller's transaction
 * so the event and the state change it records commit together.
 */
export async function appendTaskEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; taskId: string; actor: EventActor; event: TaskEventPayload; createdAt?: Date },
): Promise<void> {
  const subject = subjectWorkerId(args.event);
  // S7 (#2023, R90): an assignment to a worker that was on standby raises its delivered mark past the held messages, in this
  // same transaction, and the count rides the event so the task wake returns it exactly once.
  const standbyHeld = subject && (ASSIGNED_EVENT_TYPES as readonly string[]).includes(args.event.type)
    ? await raiseDeliveredOnAssignment(tx, { workerId: subject, taskId: args.taskId, actor: { userId: args.actor.userId, workerId: args.actor.workerId }, now: args.createdAt })
    : 0;
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      taskId: args.taskId,
      type: args.event.type,
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      actorRunId: args.actor.runId ?? null,
      subjectWorkerId: subject,
      payload: standbyHeld > 0 ? { ...payloadJson(args.event), standbyHeld } : payloadJson(args.event),
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    },
  });
}

// ── #1706: alarms and availability ─────────────────────────────────────────

/**
 * The alarm types the stall evaluator writes (cor:agt:050:14–:17), one per
 * rule. `assignment.unassignable` is cor:agt:050:17's alarm; T3 writes the
 * ordinary `assignment.queued` / `.matched` events.
 */
export const ALARM_EVENT_TYPES = [
  'stall.not-started',
  'stall.no-progress',
  'stall.owner-unreactive',
  'assignment.unassignable',
  // #2755: a worker gone dark (cor:agt:100:06, Proposed). Task-less; its episode lives in `dark_worker_episodes`.
  'alarm.dark-worker',
] as const;
export type AlarmEventType = (typeof ALARM_EVENT_TYPES)[number];

/** The owner chain an alarm is raised with, nearest first (cor:agt:050:18). */
export type AlarmChain = TaskParty[];

/** What an alarm carries: its rule's window, and the ids that locate the stall. Never text. */
export type AlarmPayload = {
  windowMinutes: number;
  /** The assignee the stall concerns (not-started, no-progress, owner-unreactive). */
  assignee?: TaskParty | null;
  /** owner-unreactive: the finished child task whose finish began the episode. */
  childTaskId?: string;
};

/**
 * Append one stall alarm, once per episode (cor:agt:050:13). The episode's key
 * is (task, type, episodeStart) under the unique index
 * agent_team_events_episode_uniq, so a second insert of the same episode —
 * a re-run, or a concurrent evaluator pass on another instance — does
 * nothing: `ON CONFLICT DO NOTHING`, never a read-then-write. A concurrent
 * insert of the same key waits for the first to commit and then conflicts.
 *
 * Returns the new event's id, or null when the episode already has its alarm.
 * `createdAt` is the evaluator pass's clock; `episodeStart` is the instant of
 * the move that began the condition, so every pass computes the same key.
 */
export async function appendAlarmEvent(
  tx: Prisma.TransactionClient,
  args: {
    appId: string;
    taskId: string;
    type: AlarmEventType;
    episodeStart: Date;
    chain: AlarmChain;
    subjectWorkerId: string | null;
    payload: AlarmPayload;
    createdAt: Date;
  },
): Promise<string | null> {
  const payload: Prisma.InputJsonObject = {
    windowMinutes: args.payload.windowMinutes,
    ...(args.payload.assignee ? { assignee: partyJson(args.payload.assignee) } : {}),
    ...(args.payload.childTaskId ? { childTaskId: args.payload.childTaskId } : {}),
  };
  const chain = args.chain.map(partyJson);
  // Naive-UTC literals: these columns are timestamp WITHOUT time zone
  // (findings:prisma-naive-timestamp-raw-sql).
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO agent_team_events
      (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
    VALUES (
      ${generateId()}, ${args.appId}, ${args.type}, ${args.taskId}, ${args.subjectWorkerId}, 'alarm',
      ${JSON.stringify(chain)}::jsonb, ${JSON.stringify(payload)}::jsonb,
      ${toNaiveUtc(args.createdAt)}::timestamp, ${toNaiveUtc(args.episodeStart)}::timestamp
    )
    ON CONFLICT (task_id, type, episode_start) DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/**
 * cor:agt:060:02 / :03 — who set an availability record: cor:agt:060:08's
 * setter classes (`reports-to`, #1759: the worker it reports to, clearing a
 * stall), plus `lapse` (#1766): the platform writing down that an `until`
 * passed (cor:agt:060:02).
 */
export type AvailabilitySetter = 'worker' | 'holder' | 'app-manager' | 'reports-to' | 'stall-rule' | 'host' | 'lapse' | 'context-reset';
/** #2162: `resetting` is written only by the platform's context reset (cor:agt:050:27); no caller sets it. */
export type AvailabilityReason = 'stalled' | 'out-of-tokens' | 'host-down' | 'other' | 'resetting';

/** `availability.changed`: a worker's or a model family's record changed. Words and ids only. */
export type AvailabilityEvent =
  | {
      kind: 'worker';
      workerId: string;
      state: 'available' | 'unavailable';
      reason: AvailabilityReason | null;
      until: Date | null;
      setBy: AvailabilitySetter;
      /** The alarm that made the worker unavailable (cor:agt:060:07). */
      alarmEventId?: string;
      /** #1766: the `until` that passed, when the lapse made the worker available (cor:agt:060:02). */
      lapsedAt?: Date;
      /** #1709: the host whose key set it (`setBy: 'host'`, cor:agt:060:08). */
      hostId?: string;
      /** #2162: the context reset that set or released it (`setBy: 'context-reset'`). */
      resetId?: string;
    }
  | {
      kind: 'family';
      family: string;
      state: 'available' | 'unavailable';
      reason: AvailabilityReason | null;
      until: Date | null;
    };

/** Append one `availability.changed` event in the caller's transaction. */
export async function appendAvailabilityEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; event: AvailabilityEvent; createdAt?: Date },
): Promise<void> {
  const e = args.event;
  const common = { state: e.state, reason: e.reason, until: e.until ? e.until.toISOString() : null };
  const payload: Prisma.InputJsonObject = e.kind === 'worker'
    ? {
        ...common,
        setBy: e.setBy,
        ...(e.alarmEventId ? { alarmEventId: e.alarmEventId } : {}),
        ...(e.lapsedAt ? { lapsedAt: e.lapsedAt.toISOString() } : {}),
        ...(e.hostId ? { hostId: e.hostId } : {}),
        ...(e.resetId ? { resetId: e.resetId } : {}),
      }
    : { ...common, family: e.family };
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: 'availability.changed',
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      subjectWorkerId: e.kind === 'worker' ? e.workerId : null,
      payload,
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    },
  });
}

/** The actor of a platform-made change (the stall evaluator, a lapse): nobody. */
export const PLATFORM_ACTOR: EventActor = { userId: null, workerId: null, agentId: null };

// ── #1707: host registrations ──────────────────────────────────────────────

/** The host events (cor:agt:050:11, Proposed: "host registered, host lost"). */
export const HOST_EVENT_TYPES = ['host.registered', 'host.lost'] as const;
export type HostEventType = (typeof HOST_EVENT_TYPES)[number];

/**
 * Append a host event. Carries the registration's id, the host's token id and
 * a count — never the label, which is free text (cor:agt:050:11).
 */
export async function appendHostEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; type: HostEventType; registrationId: string; hostId: string; workerCount: number; createdAt: Date },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: args.type,
      actorUserId: null,
      actorWorkerId: null,
      actorAgentId: null,
      payload: { registrationId: args.registrationId, hostId: args.hostId, workerCount: args.workerCount },
      createdAt: args.createdAt,
    },
  });
}

// ── #1709: host operation outcomes ─────────────────────────────────────────

/** A host operation's outcome (cor:agt:070:02: each outcome is also an event). */
export const HOST_OPERATION_EVENT_TYPES = ['host.operation.succeeded', 'host.operation.failed'] as const;
export type HostOperationEventType = (typeof HOST_OPERATION_EVENT_TYPES)[number];

/**
 * Append a host operation's outcome event, in the report's transaction. Ids
 * and the operation's type only: never its arguments (branch and repo names)
 * or the host's failure reason, which is free text the host wrote and stays
 * on the operation row (cor:agt:050:11).
 */
export async function appendHostOperationEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; type: HostOperationEventType; operationId: string; hostId: string; operationType: string; workerId: string; createdAt: Date },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: args.type,
      actorUserId: null,
      actorWorkerId: null,
      actorAgentId: null,
      subjectWorkerId: args.workerId,
      payload: { operationId: args.operationId, hostId: args.hostId, operationType: args.operationType },
      createdAt: args.createdAt,
    },
  });
}

// ── #1726: who a worker reports to ─────────────────────────────────────────

/**
 * Who changed a worker's `reportsTo` (#1726), as a word: the worker it
 * reported to, a worker claiming it, its holder, whoever manages the App, the worker's own
 * bind (`startSession`), or the platform clearing it on retirement.
 */
export type ReportsToSetter = 'current' | 'claimant' | 'holder' | 'app-manager' | 'bind' | 'retirement' | 'cast';

/**
 * #2458 (cor:dmo:050:11): append the one `worker.casting` event a change of a worker's agent writes, in the change's
 * own transaction: who, the worker, the old and new agent and role, and the per-worker boot-prompt pointer the change
 * cleared (null when none was set). Ids and role words only.
 */
export async function appendWorkerCastingEvent(
  tx: Prisma.TransactionClient,
  args: {
    appId: string; actor: EventActor; workerId: string;
    fromAgentId: string; toAgentId: string; fromRole: string | null; toRole: string | null;
    clearedBootPromptNodeId: string | null;
  },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: 'worker.casting',
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      subjectWorkerId: args.workerId,
      payload: {
        fromAgentId: args.fromAgentId, toAgentId: args.toAgentId, fromRole: args.fromRole, toRole: args.toRole,
        clearedBootPromptNodeId: args.clearedBootPromptNodeId,
      },
    },
  });
}

// ── #2766 (S2a of #2483): who staffed or changed the team ──────────────────

/**
 * The member and staffing acts the five doors record (cor:agt:050:11, Proposed). Each is appended in the act's own
 * transaction, after every refusal and before commit, by a person and a worker session alike (`actorWorkerId` is null
 * for a person). Ids and role words only: no name, email, signature, message text or key.
 */
export const STAFFING_EVENT_TYPES = [
  'member.added', 'member.role-changed', 'member.removed', 'worker.cast', 'worker.retired', 'worker.deleted',
] as const;
export type StaffingEventType = (typeof STAFFING_EVENT_TYPES)[number];

/** The census (`miscastHasReferences`) treats these on the subject worker as the cast's own bookkeeping, not use. */
export const SELF_BOOKKEEPING_EVENT_TYPES = ['worker.cast', 'worker.retired'] as const;

async function appendStaffingEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; type: StaffingEventType; subjectWorkerId?: string; payload: Prisma.InputJsonObject },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: args.type,
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      subjectWorkerId: args.subjectWorkerId ?? null,
      payload: args.payload,
    },
  });
}

/** `member.added` (a new membership) or `member.role-changed` (an existing member's role changed); nothing for an unchanged role. */
export async function appendMemberSetEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; userId: string; priorRole: string | null; role: string },
): Promise<void> {
  if (args.priorRole === args.role) return;
  if (args.priorRole === null) {
    return appendStaffingEvent(tx, { appId: args.appId, actor: args.actor, type: 'member.added', payload: { userId: args.userId, role: args.role } });
  }
  return appendStaffingEvent(tx, {
    appId: args.appId, actor: args.actor, type: 'member.role-changed',
    payload: { userId: args.userId, fromRole: args.priorRole, toRole: args.role },
  });
}

export async function appendMemberRemovedEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; userId: string; role: string },
): Promise<void> {
  await appendStaffingEvent(tx, { appId: args.appId, actor: args.actor, type: 'member.removed', payload: { userId: args.userId, role: args.role } });
}

export async function appendWorkerCastEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; workerId: string; agentId: string; role: string | null; reportsToWorkerId: string | null },
): Promise<void> {
  await appendStaffingEvent(tx, {
    appId: args.appId, actor: args.actor, type: 'worker.cast', subjectWorkerId: args.workerId,
    payload: { workerId: args.workerId, agentId: args.agentId, role: args.role, reportsToWorkerId: args.reportsToWorkerId },
  });
}

export async function appendWorkerRetiredEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; workerId: string },
): Promise<void> {
  await appendStaffingEvent(tx, { appId: args.appId, actor: args.actor, type: 'worker.retired', subjectWorkerId: args.workerId, payload: { workerId: args.workerId } });
}

export async function appendWorkerDeletedEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; workerId: string },
): Promise<void> {
  // The id rides the payload only: a `subject_worker_id` naming a worker that no longer exists is refused by the
  // worker-reference fence (#1162), and this event is written after the row is gone.
  await appendStaffingEvent(tx, { appId: args.appId, actor: args.actor, type: 'worker.deleted', payload: { workerId: args.workerId } });
}

/**
 * Append one `worker.reports-to` event: a set, handover or clear. The Worker
 * row holds only the current value; these events are its history. Ids and a
 * setter word only.
 */
export async function appendReportsToEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; actor: EventActor; workerId: string; from: string | null; to: string | null; setBy: ReportsToSetter; oldExplicitNoTeam?: boolean; newExplicitNoTeam?: boolean },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: 'worker.reports-to',
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      subjectWorkerId: args.workerId,
      payload: { from: args.from, to: args.to, setBy: args.setBy,
        ...(args.oldExplicitNoTeam !== undefined ? { oldExplicitNoTeam: args.oldExplicitNoTeam, newExplicitNoTeam: args.newExplicitNoTeam } : {}),
      },
    },
  });
}
