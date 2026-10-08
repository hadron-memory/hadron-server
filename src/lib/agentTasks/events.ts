/**
 * #1705 — the ONLY writer of `agent_team_events` (cor:agt:050:11).
 *
 * An event is append-only in the database (prisma/agent-task-invariants.sql),
 * so this module's job is the half the trigger cannot check: what goes into
 * `payload`. Its builders accept ids, counts, outcome words and booleans only,
 * so no message, title, description or summary text can reach the stream
 * (cor:agt:050:11, Proposed: "an event never holds message bodies"). A caller
 * that wants to record something new adds a typed builder here rather than
 * passing a bag through.
 */

import type { Prisma } from '../../generated/prisma/index.js';
import { currentActor } from '../requestActor.js';

/** The task event types T1 writes (cor:agt:050:11; `task.reassigned` is Proposed there). */
export const TASK_EVENT_TYPES = [
  'task.created',
  'task.assigned',
  'task.reassigned',
  'task.started',
  'task.progress',
  'task.finished',
  'task.cancelled',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** A party to a task: exactly one of a Worker or a User. */
export type TaskParty = { workerId: string; userId?: never } | { userId: string; workerId?: never };

/** Who acted: the human credential, and the Worker / Agent the request's session is bound to (#1610). */
export type EventActor = { userId: string | null; workerId: string | null; agentId: string | null };

/** The payload each type carries. Ids, counts, outcome words and flags only — never text. */
export type TaskEventPayload =
  | { type: 'task.created'; parentTaskId: string | null; hasAssignee: boolean }
  | { type: 'task.assigned'; assignee: TaskParty; closeSessionWhenDone: boolean }
  | { type: 'task.reassigned'; from: TaskParty; to: TaskParty; closeSessionWhenDone: boolean }
  | { type: 'task.started' }
  | { type: 'task.progress' }
  | { type: 'task.finished'; outcome: string }
  | { type: 'task.cancelled'; fromStatus: 'pending' | 'started'; openChildCount: number };

/** The event actor for the current request: `userId` from the credential, Worker / Agent from #1610. */
export function eventActor(userId: string | null | undefined): EventActor {
  const actor = currentActor();
  return { userId: userId ?? null, workerId: actor.workerId, agentId: actor.agentId };
}

function partyJson(p: TaskParty): Prisma.InputJsonObject {
  return p.workerId ? { workerId: p.workerId } : { userId: p.userId as string };
}

/** The stored `payload` for a typed event. Exhaustive over the union, so a new type must be built here. */
function payloadJson(e: TaskEventPayload): Prisma.InputJsonObject {
  switch (e.type) {
    case 'task.created':
      return { parentTaskId: e.parentTaskId, hasAssignee: e.hasAssignee };
    case 'task.assigned':
      return { assignee: partyJson(e.assignee), closeSessionWhenDone: e.closeSessionWhenDone };
    case 'task.reassigned':
      return { from: partyJson(e.from), to: partyJson(e.to), closeSessionWhenDone: e.closeSessionWhenDone };
    case 'task.started':
    case 'task.progress':
      return {};
    case 'task.finished':
      return { outcome: e.outcome };
    case 'task.cancelled':
      return { fromStatus: e.fromStatus, openChildCount: e.openChildCount };
  }
}

/** The worker an event concerns: the (new) assignee when it is a worker. */
function subjectWorkerId(e: TaskEventPayload): string | null {
  if (e.type === 'task.assigned') return e.assignee.workerId ?? null;
  if (e.type === 'task.reassigned') return e.to.workerId ?? null;
  return null;
}

/**
 * Append one ordinary (non-alarm) task event, inside the caller's transaction
 * so the event and the state change it records commit together.
 */
export async function appendTaskEvent(
  tx: Prisma.TransactionClient,
  args: { appId: string; taskId: string; actor: EventActor; event: TaskEventPayload },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      taskId: args.taskId,
      type: args.event.type,
      actorUserId: args.actor.userId,
      actorWorkerId: args.actor.workerId,
      actorAgentId: args.actor.agentId,
      subjectWorkerId: subjectWorkerId(args.event),
      payload: payloadJson(args.event),
    },
  });
}
