// #1707 — Task Management slice T3: the team roster (plan
// design:agent-tasks §7.4). Matching itself has no public surface: the
// platform assigns (src/lib/agentTasks/matcher.ts). Host registration is a
// `host:operate` App key's (T6, #1709: registerHost, resolvers.hostOperation.ts).
//
// AUTHORIZATION: the roster reads with the App's task audience — its
// participants, workers included (cor:agt:050:21, Proposed) — through T1's
// `resolveParticipatedApp`, so an App the caller does not participate in reads
// exactly like an absent one (APP_NOT_FOUND). Each worker is rendered through
// the same sanitized party projection as tasks, never the Worker object.

import { type Context, withoutRequestCaches } from './resolvers.helpers.js';
import { mayReadAppTasks, resolveParticipatedApp } from './resolvers.agentTask.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { loadRosterTaskSummaries, type RosterTaskSummary } from '../../../lib/agentTasks/rosterSummary.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { loadTeamRoster, type RosterEntry } from '../../../lib/agentTasks/roster.js';
import type { WorkerCheckStatus } from '../../../lib/workerCheckStatus.js';
import { loadAppWorkerCheckStatuses, maySeeWorkerInternals } from './resolvers.worker.js';
import { canSeeUserPersonalFieldsMany } from '../../../lib/auth/userVisibility.js';

const toGqlWord = (s: string): string => s.toUpperCase().replace(/-/g, '_');

export const agentTaskMatchingQueries = {
  /** #1707 — every worker's derived state in an App (plan §7.4), for its task audience. */
  teamRoster: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    // Admission, status and assignment projections share one read snapshot, including MCP callers.
    return ctx.db.$transaction(async (tx) => {
      const readCtx = withoutRequestCaches(ctx, tx);
      const { app } = await resolveParticipatedApp(readCtx, appRef);
      const asOf = new Date();
      const [entries, checks] = await Promise.all([
        loadTeamRoster(tx, app.id, asOf),
        // #2138 §3.4 — the same derivation as Worker.checkStatus, at the roster's instant.
        loadAppWorkerCheckStatuses(readCtx, app.id, { now: asOf }),
      ]);
      const workerIds = entries.map((e) => e.workerId);
      const canReadTasks = await mayReadAppTasks(readCtx, app.id);
      const [settings, tasks] = await Promise.all([
        tx.workerWakeSettings.findMany({ where: { workerId: { in: workerIds } }, select: { workerId: true, pausedUntil: true } }),
        canReadTasks ? loadRosterTaskSummaries(tx, app.id, workerIds) : new Map<string, RosterTaskSummary>(),
      ]);
      const pauses = new Map(settings.map((s) => [s.workerId, s.pausedUntil]));
      const holders = await loadRosterHolders(readCtx, tx, app.id, workerIds);
      return {
        appId: app.id,
        asOf,
        workers: entries.map((e) => ({ ...e, appUrn: app.urn, checkStatus: checks.get(e.workerId) ?? null,
          pausedUntil: pauses.get(e.workerId) ?? null, currentTask: tasks.get(e.workerId) ?? null,
          heldBy: holders.get(e.workerId)?.heldBy ?? null, heldAt: holders.get(e.workerId)?.heldAt ?? null })),
      };
    // An explicit, bounded read budget avoids imposing Prisma's implicit 5s interactive-transaction default
    // on the now-serialized bulk roster loaders. This does not change query/lock or test timeouts.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 });
  },
};

/** The sanitized holder a roster row carries: `name` is already behind the #384 gate, so the type's `name` field is a passthrough. */
export type RosterHolder = { id: string; handle: string | null; name: string | null };

/**
 * #2223 — who holds each worker's name, for the roster leaf.
 *
 * `heldByUserId`/`heldAt` are WORKING-STATE fields (cor:agt:020:09), narrower than the roster's audience, so
 * the worker working-state gate decides, once per App, before any holder is read: a reader who fails it
 * costs no holder query and every row answers null. A holder who is soft-deleted is null (fail closed; a live
 * hold should never point at one). Each name goes through the shared #384 gate in bulk, so the number of
 * queries is constant in the number of workers and distinct holders. The projection is selected, never the
 * User row (findings:broadening-read-gate-leaks-nested-objects).
 */
async function loadRosterHolders(
  readCtx: Context,
  tx: Prisma.TransactionClient,
  appId: string,
  workerIds: string[],
): Promise<Map<string, { heldBy: RosterHolder; heldAt: Date | null }>> {
  const out = new Map<string, { heldBy: RosterHolder; heldAt: Date | null }>();
  if (workerIds.length === 0 || !(await maySeeWorkerInternals(readCtx, appId))) return out;
  const holds = await tx.worker.findMany({
    where: { id: { in: workerIds }, heldByUserId: { not: null } },
    select: { id: true, heldByUserId: true, heldAt: true },
  });
  const holderIds = [...new Set(holds.map((h) => h.heldByUserId!))];
  if (holderIds.length === 0) return out;
  const users = await tx.user.findMany({
    where: { id: { in: holderIds }, deletedAt: null },
    select: { id: true, handle: true, name: true },
  });
  const nameVisible = await canSeeUserPersonalFieldsMany(readCtx, users.map((u) => u.id));
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const h of holds) {
    const u = byId.get(h.heldByUserId!);
    if (!u) continue;
    out.set(h.id, { heldBy: { id: u.id, handle: u.handle, name: nameVisible.has(u.id) ? (u.name || null) : null }, heldAt: h.heldAt });
  }
  return out;
}

type RosterRow = RosterEntry & {
  appUrn: string; checkStatus: WorkerCheckStatus | null; pausedUntil: Date | null; currentTask: RosterTaskSummary | null;
  heldBy: RosterHolder | null; heldAt: Date | null;
};

export const agentTaskMatchingFieldResolvers = {
  TeamRosterTaskSummary: { status: (r: RosterTaskSummary) => toGqlWord(r.status) },
  TeamRosterEntry: {
    worker: (r: RosterRow) => ({ kind: 'WORKER', id: r.workerId, name: r.name, urn: composeWorkerUrn(r.appUrn, r.slug) }),
    freeForWork: (r: RosterRow) => r.free,
    unavailableReason: (r: RosterRow) => (r.unavailable?.reason ? toGqlWord(r.unavailable.reason) : null),
    unavailableUntil: (r: RosterRow) => r.unavailable?.until ?? null,
    startedTasks: (r: RosterRow) => r.startedTaskIds,
    pendingTasks: (r: RosterRow) => r.pendingTaskIds,
    waitingOn: (r: RosterRow) => r.waitingOnTaskIds,
    alarms: (r: RosterRow) => r.alarmEventIds,
    unreactedChildTask: (r: RosterRow) => r.unreactedChildTaskId,
    reportsTo: (r: RosterRow) => (r.reportsTo
      ? { kind: 'WORKER', id: r.reportsTo.workerId, name: r.reportsTo.name, urn: composeWorkerUrn(r.appUrn, r.reportsTo.slug) }
      : null),
    reportsToRetired: (r: RosterRow) => r.reportsTo?.retired ?? false,
    checkStatus: (r: RosterRow) => r.checkStatus,
  },
};
