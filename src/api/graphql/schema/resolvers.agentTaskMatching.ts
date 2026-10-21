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

import { type Context } from './resolvers.helpers.js';
import { mayReadAppTasks, resolveParticipatedApp } from './resolvers.agentTask.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { loadRosterTaskSummaries, type RosterTaskSummary } from '../../../lib/agentTasks/rosterSummary.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { loadTeamRoster, type RosterEntry } from '../../../lib/agentTasks/roster.js';
import type { WorkerCheckStatus } from '../../../lib/workerCheckStatus.js';
import { loadAppWorkerCheckStatuses } from './resolvers.worker.js';

const toGqlWord = (s: string): string => s.toUpperCase().replace(/-/g, '_');

export const agentTaskMatchingQueries = {
  /** #1707 — every worker's derived state in an App (plan §7.4), for its task audience. */
  teamRoster: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    // Admission, status and assignment projections share one read snapshot, including MCP callers.
    return ctx.db.$transaction(async (tx) => {
      const readCtx: Context = { ...ctx, db: tx as Context['db'] };
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
      return {
        appId: app.id,
        asOf,
        workers: entries.map((e) => ({ ...e, appUrn: app.urn, checkStatus: checks.get(e.workerId) ?? null,
          pausedUntil: pauses.get(e.workerId) ?? null, currentTask: tasks.get(e.workerId) ?? null })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  },
};

type RosterRow = RosterEntry & { appUrn: string; checkStatus: WorkerCheckStatus | null; pausedUntil: Date | null; currentTask: RosterTaskSummary | null };

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
