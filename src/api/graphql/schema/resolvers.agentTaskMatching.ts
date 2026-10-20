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
import { resolveParticipatedApp } from './resolvers.agentTask.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { loadTeamRoster, type RosterEntry } from '../../../lib/agentTasks/roster.js';
import type { WorkerCheckStatus } from '../../../lib/workerCheckStatus.js';
import { loadAppWorkerCheckStatuses } from './resolvers.worker.js';

const toGqlWord = (s: string): string => s.toUpperCase().replace(/-/g, '_');

export const agentTaskMatchingQueries = {
  /** #1707 — every worker's derived state in an App (plan §7.4), for its task audience. */
  teamRoster: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    const asOf = new Date();
    const [entries, checks] = await Promise.all([
      loadTeamRoster(ctx.db, app.id, asOf),
      // #2138 §3.4 — the same derivation as Worker.checkStatus, at the roster's instant.
      loadAppWorkerCheckStatuses(ctx, app.id, { now: asOf }),
    ]);
    return {
      appId: app.id,
      asOf,
      workers: entries.map((e) => ({ ...e, appUrn: app.urn, checkStatus: checks.get(e.workerId) ?? null })),
    };
  },
};

type RosterRow = RosterEntry & { appUrn: string; checkStatus: WorkerCheckStatus | null };

export const agentTaskMatchingFieldResolvers = {
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
