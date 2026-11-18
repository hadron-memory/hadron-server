import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
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

import { matchingModelGroupNames } from '../../../lib/agentTasks/modelGroups.js';
import { type Context, withoutRequestCaches } from './resolvers.helpers.js';
import { mayReadAppTasks, resolveParticipatedApp, withReadableApp, type TaskApp } from './resolvers.agentTask.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { loadRosterTaskSummaries, type RosterTaskSummary } from '../../../lib/agentTasks/rosterSummary.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { loadTeamRoster, type RosterEntry } from '../../../lib/agentTasks/roster.js';
import type { WorkerCheckStatus } from '../../../lib/workerCheckStatus.js';
import { loadAppModelGroups, loadAppWorkerCheckStatuses, maySeeWorkerInternals } from './resolvers.worker.js';
import { workerTerminalView, type StoredWorkerTerminal } from '../../../lib/workerTerminal.js';
import { groupComposition } from '../../../lib/agentTasks/composition.js';
import { TEAM_READ_TX_MAX_WAIT_MS, TEAM_READ_TX_TIMEOUT_MS, TeamReadBusyError, isPrismaBusyExhaustion } from '../../../lib/agentTasks/teamReadBudget.js';
import { canSeeUserPersonalFieldsMany } from '../../../lib/auth/userVisibility.js';

const toGqlWord = (s: string): string => s.toUpperCase().replace(/-/g, '_');

/** Shared projected rows. Person and run reads use RepeatableRead; run reads also hold live authority anchors through projection. */
export async function withRosterAppRead<T>(ctx: Context, appRef: string, project: (readCtx: Context, app: TaskApp) => Promise<T>): Promise<T> {
    if (isRunPrincipal(ctx) && !ctx.userId) return withReadableApp(ctx, appRef, project, true);
    // Admission, status and assignment projections share one read snapshot, including MCP callers.
    try {
      return await ctx.db.$transaction(async (tx) => {
        // #4271: no JIT for this read. The roster's aggregates are priced in millions (the planner cannot see that a
        // closed session's usage-event probe is skipped), so Postgres JIT-compiled each one: about 0.4 s of CPU per
        // statement for a few ms of work, which a burst of rosters on a small box turned into the 20 s budget. SET
        // LOCAL lasts only as long as this transaction and changes no answer.
        await tx.$executeRawUnsafe('SET LOCAL jit = off');
        // #4476: the budget must bite ON the statement, not after it. #4455's transaction timeout
        // only lands once the running statement returns — prod's roster statements ran 20–175 s
        // (p50 66 s, Hugo's alpha journal, #118308) inside the 5 s budget, holding a pooled
        // connection long after every client had given up. statement_timeout from the same
        // constant makes Postgres itself cancel the running statement at the budget (SQLSTATE
        // 57014), which the catch below classifies as the same typed retryable refusal.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${TEAM_READ_TX_TIMEOUT_MS}`);
        const readCtx = withoutRequestCaches(ctx, tx);
        const { app } = await resolveParticipatedApp(readCtx, appRef);
        return project(readCtx, app);
      // #4455: one snapshot still, but bounded — a 20 s interactive transaction was the P2028 incident's steady
      // holder (#4380), holding one of prod's ~9 pool connections while its serialized statements ran. 5 s of
      // transaction plus an explicit 2 s pool wait (see lib/agentTasks/teamReadBudget.ts) and the budget's expiry
      // surfaces as the typed, retryable TEAM_READ_BUSY refusal instead of a raw driver fault. This does not change
      // query/lock or test timeouts, and the read semantics are unchanged (cor:agt:050:22).
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: TEAM_READ_TX_TIMEOUT_MS, maxWait: TEAM_READ_TX_MAX_WAIT_MS });
    } catch (error) {
      // #4455: the original driver error rides along on .cause (never crossed to the client;
      // .originalError would unwrap the refusal back to the foreign Prisma error) so the
      // tx-timeout / maxWait / pool-starvation arms stay distinguishable after the typed
      // conversion; the non-busy error rethrows untouched.
      if (isPrismaBusyExhaustion(error)) throw new TeamReadBusyError(error);
      throw error;
    }
}

async function readTeamRoster(ctx: Context, appRef: string) {
  return withRosterAppRead(ctx, appRef, projectTeamRoster);
}

async function projectTeamRoster(readCtx: Context, app: TaskApp) {
  const tx = readCtx.db;
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
  const workingStateVisible = workerIds.length > 0 && await maySeeWorkerInternals(readCtx, app.id);
  const { holders, terminals } = await loadRosterWorkingState(readCtx, tx, workerIds, workingStateVisible);
  return {
    appId: app.id,
    asOf,
    workers: entries.map((e): RosterRow => ({ ...e, appId: app.id, teamPlacement: workingStateVisible ? e.teamPlacement : null, appUrn: app.urn, checkStatus: checks.get(e.workerId) ?? null,
      pausedUntil: pauses.get(e.workerId) ?? null, currentTask: tasks.get(e.workerId) ?? null,
      heldBy: holders.get(e.workerId)?.heldBy ?? null, heldAt: holders.get(e.workerId)?.heldAt ?? null,
      terminal: terminals.get(e.workerId) ?? null, internalsVisible: workingStateVisible })),
  };
}

export const agentTaskMatchingQueries = {
  teamRoster: (_: unknown, { appRef }: { appRef: string }, ctx: Context) => readTeamRoster(ctx, appRef),
  teamComposition: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const roster = await readTeamRoster(ctx, appRef);
    return { appId: roster.appId, asOf: roster.asOf, lanes: groupComposition(roster.workers) };
  },
};

/** The sanitized holder a roster row carries: `name` is already behind the #384 gate, so the type's `name` field is a passthrough. */
export type RosterHolder = { id: string; handle: string | null; name: string | null };

/**
 * #2223 — who holds each worker's name, for the roster leaf. #2771 — and each worker's stored terminal report, read in
 * the SAME query so the roster's query count does not grow.
 *
 * `heldByUserId`/`heldAt` and `terminal` are WORKING-STATE fields (cor:agt:020:09, cor:dmo:050:11), narrower than the
 * roster's audience, so the worker working-state gate decides, once per App, before any is read: a reader who fails it
 * costs no query and every row answers null. A holder who is soft-deleted is null (fail closed; a live
 * hold should never point at one). Each name goes through the shared #384 gate in bulk, so the number of
 * queries is constant in the number of workers and distinct holders. The projection is selected, never the
 * User row (findings:broadening-read-gate-leaks-nested-objects).
 */
async function loadRosterWorkingState(
  readCtx: Context,
  tx: Prisma.TransactionClient,
  workerIds: string[],
  workingStateVisible: boolean,
): Promise<{ holders: Map<string, { heldBy: RosterHolder; heldAt: Date | null }>; terminals: Map<string, StoredWorkerTerminal> }> {
  const holders = new Map<string, { heldBy: RosterHolder; heldAt: Date | null }>();
  const terminals = new Map<string, StoredWorkerTerminal>();
  if (workerIds.length === 0 || !workingStateVisible) return { holders, terminals };
  const rows = await tx.worker.findMany({
    where: { id: { in: workerIds } },
    select: { id: true, heldByUserId: true, heldAt: true, terminal: true },
  });
  for (const r of rows) if (r.terminal) terminals.set(r.id, r.terminal as unknown as StoredWorkerTerminal);
  const holds = rows.filter((r) => r.heldByUserId !== null);
  const holderIds = [...new Set(holds.map((h) => h.heldByUserId!))];
  if (holderIds.length === 0) return { holders, terminals };
  const users = await tx.user.findMany({
    where: { id: { in: holderIds }, deletedAt: null },
    select: { id: true, handle: true, name: true },
  });
  const nameVisible = await canSeeUserPersonalFieldsMany(readCtx, users.map((u) => u.id));
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const h of holds) {
    const u = byId.get(h.heldByUserId!);
    if (!u) continue;
    holders.set(h.id, { heldBy: { id: u.id, handle: u.handle, name: nameVisible.has(u.id) ? (u.name || null) : null }, heldAt: h.heldAt });
  }
  return { holders, terminals };
}

type RosterRow = Omit<RosterEntry, 'teamPlacement'> & {
  appId: string;
  teamPlacement: RosterEntry['teamPlacement'] | null;
  appUrn: string; checkStatus: WorkerCheckStatus | null; pausedUntil: Date | null; currentTask: RosterTaskSummary | null;
  heldBy: RosterHolder | null; heldAt: Date | null; terminal: StoredWorkerTerminal | null;
  /** maySeeWorkerInternals for this read: the one switch that also withholds a USER setter's identity (#3865). */
  internalsVisible: boolean;
};

/** Optional live metadata is outside the core roster transaction: a failed lookup must not
 * abort its snapshot or prevent clients reading existing roster/composition fields. */
export async function rosterModelGroups(row: { appId: string; model: string | null }, ctx: Context, memoize = false): Promise<string[]> {
  if (!row.model?.trim()) return [];
  return matchingModelGroupNames(await loadAppModelGroups(ctx, row.appId, memoize), row.model);
}

export const agentTaskMatchingFieldResolvers = {
  TeamRosterTaskSummary: { status: (r: RosterTaskSummary) => toGqlWord(r.status) },
  TeamRosterEntry: {
    modelGroups: (r: RosterRow, _: unknown, ctx: Context, info?: { operation?: { operation?: string } }) =>
      rosterModelGroups(r, ctx, info?.operation?.operation === 'query'),
    worker: (r: RosterRow) => ({ kind: 'WORKER', id: r.workerId, name: r.name, urn: composeWorkerUrn(r.appUrn, r.slug) }),
    freeForWork: (r: RosterRow) => r.free,
    unavailableReason: (r: RosterRow) => (r.unavailable?.reason ? toGqlWord(r.unavailable.reason) : null),
    unavailableUntil: (r: RosterRow) => r.unavailable?.until ?? null,
    // #3981: only an explicit decision from maySeeWorkerInternals admits the USER setter identity; malformed rows fail closed.
    availability: (r: RosterRow) => (r.availabilityRecord
      ? { ...r.availabilityRecord.row, ...(r.internalsVisible === true ? {} : { setByUserId: null }), __inEffect: r.availabilityRecord.inEffect }
      : null),
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
    terminal: (r: RosterRow) => workerTerminalView(r.terminal),
  },
};
