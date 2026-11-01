/**
 * #2022 (S6) — a stop signal's events and notices (cor:agt:090:04), as `agent_team_events` rows (append-only,
 * cor:agt:050:11): ids, levels and words only, never text.
 *
 * - `stop.set`, `stop.lifted`, `stop.expired`: the signal's own history.
 * - `stop.notice`: one notice to one recipient. `subject_worker_id` is the recipient worker; a notice to whoever
 *   manages the App (the `pause-dispatch` fallback, H24 reading A, Proposed) names the person in `recipientUserId`
 *   and has no subject. `notice` is `stop` or `resume`; `interrupt` is true only for a `halt`'s stop notice (D-2026-10-16-003).
 *
 * A notice's identity is its event id: it is delivered through the same per-event receipt as a task wake
 * (`worker_delivery_task_events`, the proof's `tasks` entry at chain position 0), so acknowledging it moves no chat
 * mark (R53).
 */

import type { Prisma } from '../../generated/prisma/index.js';
import type { EventActor } from '../agentTasks/events.js';
import type { StopLevel, StopSignal } from './state.js';

export const STOP_NOTICE_EVENT = 'stop.notice';
/**
 * #3045 (V20): a worker left a live `pause-dispatch`'s coordinators while another live one still names it. No resume is
 * sent for the signal it left, and a notice of that signal it was never offered no longer applies: this event, newer
 * than that notice, drops it from the offer (`pendingStopNotices`). It is never a notice itself and is never offered.
 */
export const STOP_NOTICE_WITHDRAWN_EVENT = 'stop.notice.withdrawn';
export const STOP_LIFECYCLE_EVENTS = ['stop.set', 'stop.lifted', 'stop.expired'] as const;

export type StopNoticeKind = 'stop' | 'resume';

/** The signal's setter or ender as an event actor: a person, or (a host key) nobody, with the key in the payload. */
export type StopActor = { userId: string; actor: EventActor } | { appKeyId: string };

const actorColumns = (a: StopActor) =>
  'userId' in a
    ? { actorUserId: a.actor.userId, actorWorkerId: a.actor.workerId, actorAgentId: a.actor.agentId }
    : { actorUserId: null, actorWorkerId: null, actorAgentId: null };

/** Append `stop.set`. */
export async function appendStopSetEvent(tx: Prisma.TransactionClient, s: StopSignal, by: StopActor): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: s.appId,
      type: 'stop.set',
      ...actorColumns(by),
      subjectWorkerId: s.targetWorkerId,
      payload: {
        signalId: s.id, level: s.level, scope: s.scope,
        targetWorkerId: s.targetWorkerId, targetHostRegistrationId: s.targetHostRegistrationId,
        until: s.until ? s.until.toISOString() : null,
        ...('appKeyId' in by ? { appKeyId: by.appKeyId } : {}),
      },
      createdAt: s.setAt,
    },
  });
}

/** Append `stop.lifted` (by a person or a host key) or `stop.expired` (by nobody, at its until). */
export async function appendStopEndEvent(
  tx: Prisma.TransactionClient,
  s: Pick<StopSignal, 'id' | 'appId' | 'level'>,
  end: { kind: 'lifted'; by: StopActor; at: Date } | { kind: 'expired'; at: Date },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: s.appId,
      type: end.kind === 'lifted' ? 'stop.lifted' : 'stop.expired',
      ...(end.kind === 'lifted' ? actorColumns(end.by) : { actorUserId: null, actorWorkerId: null, actorAgentId: null }),
      payload: {
        signalId: s.id, level: s.level,
        ...(end.kind === 'lifted' && 'appKeyId' in end.by ? { appKeyId: end.by.appKeyId } : {}),
      },
      createdAt: end.at,
    },
  });
}

/** Append one `stop.notice` to a worker or (the managers' fallback) a person. */
export async function appendStopNotice(
  tx: Prisma.TransactionClient,
  args: {
    appId: string;
    recipient: { workerId: string } | { userId: string };
    signalId: string;
    level: StopLevel;
    notice: StopNoticeKind;
    at: Date;
  },
): Promise<void> {
  const interrupt = args.notice === 'stop' && args.level === 'halt';
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: STOP_NOTICE_EVENT,
      actorUserId: null,
      actorWorkerId: null,
      actorAgentId: null,
      subjectWorkerId: 'workerId' in args.recipient ? args.recipient.workerId : null,
      payload: {
        signalId: args.signalId, level: args.level, notice: args.notice, interrupt,
        ...('userId' in args.recipient ? { recipientUserId: args.recipient.userId } : {}),
      },
      createdAt: args.at,
    },
  });
}

/** Append `stop.notice.withdrawn` for one worker and one `pause-dispatch` (see `STOP_NOTICE_WITHDRAWN_EVENT`). */
export async function appendStopNoticeWithdrawn(
  tx: Prisma.TransactionClient,
  args: { appId: string; workerId: string; signalId: string; at: Date },
): Promise<void> {
  await tx.agentTeamEvent.create({
    data: {
      appId: args.appId,
      type: STOP_NOTICE_WITHDRAWN_EVENT,
      actorUserId: null,
      actorWorkerId: null,
      actorAgentId: null,
      subjectWorkerId: args.workerId,
      payload: { signalId: args.signalId, level: 'pause-dispatch' },
      createdAt: args.at,
    },
  });
}

/**
 * Who a `pause-dispatch` tells (cor:agt:090:04, H24 reading A, Proposed; Vera's receipt §3): every covered worker that
 * others report to; for each covered worker, the worker it reports to directly when this signal doesn't cover that
 * one; and, when those name nobody, whoever manages the App. Computed, never stored, so a later ruling changes no
 * schema. Retired workers are never told.
 */
export function pauseDispatchRecipients(
  covered: ReadonlySet<string>,
  workers: ReadonlyArray<{ id: string; reportsToWorkerId: string | null }>,
  managerUserIds: readonly string[],
): Array<{ workerId: string } | { userId: string }> {
  const live = new Set(workers.map((w) => w.id));
  const headed = new Set(workers.filter((w) => w.reportsToWorkerId).map((w) => w.reportsToWorkerId as string));
  const out = new Set<string>();
  for (const w of workers) {
    if (!covered.has(w.id)) continue;
    if (headed.has(w.id)) out.add(w.id);
    const up = w.reportsToWorkerId;
    if (up && !covered.has(up) && live.has(up)) out.add(up);
  }
  if (out.size > 0) return [...out].sort().map((workerId) => ({ workerId }));
  return [...new Set(managerUserIds)].sort().map((userId) => ({ userId }));
}
