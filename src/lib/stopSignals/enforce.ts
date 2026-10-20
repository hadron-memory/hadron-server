/**
 * #2022 (S6) — the manual side of "every level stops assignment" (cor:agt:090:03, D-2026-10-16-003): making a covered
 * worker a task's assignee by hand (a create with an assignee, an assign, a reassign) is refused with TASK_STOPPED.
 *
 * Called inside the task write's transaction, after its own actor and visibility gates (so a caller who may not
 * direct the task learns nothing about stops) and before any state or event write; the write holds the App's stop
 * fence shared (`inTaskWriteTx`), so a signal set or lifted concurrently is ordered with this decision. Moving a task
 * AWAY from a covered worker, cancelling, parking, finishing and progress are not refused (090:03 edge cases, Proposed).
 *
 * The refusal names who set each blocking signal and until when (090:03, Proposed; plan r2 S6): ids, levels, scopes,
 * the setter's user id or that a host key set it, and the until. At most `BLOCKERS_MAX` are listed, oldest set first,
 * with `moreBlockers` when there are more, so no blocker is silently dropped.
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { coveringSignals } from './state.js';

export const BLOCKERS_MAX = 20;
export const TASK_STOPPED_MESSAGE = 'Assignment is stopped by an active stop signal.';

/** Refuse making `workerId` an assignee while a live stop signal covers it. */
export async function refuseStoppedAssignee(tx: Prisma.TransactionClient, appId: string, workerId: string, now: Date, taskId?: string): Promise<void> {
  const list = (await coveringSignals(tx, appId, [workerId], now)).get(workerId);
  if (!list || list.length === 0) return;
  const blockers = list.slice(0, BLOCKERS_MAX).map((s) => ({
    id: s.id,
    level: s.level,
    scope: s.scope,
    setByUserId: s.setByUserId,
    setByHostKey: s.setByAppKeyId !== null,
    until: s.until ? s.until.toISOString() : null,
  }));
  throw new GraphQLError(TASK_STOPPED_MESSAGE, {
    extensions: {
      code: 'TASK_STOPPED',
      workerId,
      ...(taskId ? { taskId } : {}),
      blockers,
      moreBlockers: list.length > BLOCKERS_MAX,
    },
  });
}
