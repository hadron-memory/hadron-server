/**
 * #2022 (S6) — the manual side of "every level stops assignment" (cor:agt:090:03, D-2026-10-16-003): making a covered
 * worker a task's assignee by hand (a create with an assignee, an assign, a reassign) is refused with TASK_STOPPED.
 *
 * Called inside the task write's transaction, after its own actor and visibility gates (so a caller who may not
 * direct the task learns nothing about stops) and before any state or event write; the write holds the App's stop
 * fence shared (`inTaskWriteTx`), so a signal set or lifted concurrently is ordered with this decision. Moving a task
 * AWAY from a covered worker, cancelling, parking, finishing and progress are not refused (090:03 edge cases, Proposed).
 *
 * The refusal names who set each blocking signal and until when (090:03, Proposed; plan r2 S6): ids, levels and scopes
 * as the SDL enum values, the setter's user id and handle or that a host key set it, and the until. At most
 * `BLOCKERS_MAX` are listed, oldest set first, with `moreBlockers` when there are more, so no blocker is silently
 * dropped. The message names the worker, the first blocker and the way forward (Uma #2166 P2-1).
 */

import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { coveringSignals, type StopLevel, type StopScope } from './state.js';
import { stopNames } from './names.js';

export const BLOCKERS_MAX = 20;
const LEVEL_ENUM: Record<StopLevel, string> = { 'pause-dispatch': 'PAUSE_DISPATCH', pause: 'PAUSE', halt: 'HALT' };
const SCOPE_ENUM: Record<StopScope, string> = { worker: 'WORKER', team: 'TEAM', host: 'HOST' };

/** Refuse making `workerId` an assignee while a live stop signal covers it. */
export async function refuseStoppedAssignee(tx: Prisma.TransactionClient, appId: string, workerId: string, now: Date, taskId?: string): Promise<void> {
  const list = (await coveringSignals(tx, appId, [workerId], now)).get(workerId);
  if (!list || list.length === 0) return;
  const names = await stopNames(tx, appId, { workerIds: [workerId], userIds: list.map((s) => s.setByUserId) });
  const blockers = list.slice(0, BLOCKERS_MAX).map((s) => ({
    id: s.id,
    level: LEVEL_ENUM[s.level],
    scope: SCOPE_ENUM[s.scope],
    setByUserId: s.setByUserId,
    setByHandle: names.user(s.setByUserId),
    setByHostKey: s.setByAppKeyId !== null,
    until: s.until ? s.until.toISOString() : null,
  }));
  const who = names.worker(workerId);
  const first = blockers[0]!;
  const setter = first.setByHostKey ? 'a host key' : first.setByHandle ? `@${first.setByHandle}` : `user ${first.setByUserId}`;
  const more = list.length > 1 ? ` and ${list.length - 1} more` : '';
  const message = `Can't assign to ${who?.name ?? workerId}: a ${first.level} stop signal (${first.scope}, set by ${setter}, `
    + `until ${first.until ?? 'lifted'})${more} covers them. Assign someone else, or whoever manages the App lifts it `
    + `(hadron team stop lift id=${first.id}).`;
  throw new GraphQLError(message, {
    extensions: {
      code: 'TASK_STOPPED',
      workerId,
      workerUrn: who?.urn ?? null,
      ...(taskId ? { taskId } : {}),
      blockers,
      moreBlockers: list.length > BLOCKERS_MAX,
    },
  });
}
