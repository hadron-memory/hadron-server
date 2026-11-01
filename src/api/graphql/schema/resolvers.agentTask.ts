import { isDeepStrictEqual } from 'node:util';
import { lockTaskGraph, taskPriority, addTaskBlocker, removeTaskBlocker } from '../../../lib/agentTasks/blockers.js';
import { taskListDateTime } from '../../../lib/agentTasks/listDateTime.js';
// Agent tasks — #1705 (Task Management slice T1, epic #1704).
//
// A team App assigns its work as AgentTasks (cor:agt:050). Each task has one
// OWNER (who needs it done) and at most one ASSIGNEE (who carries it to its
// end, cor:agt:050:05); every state change appends an AgentTeamEvent in the
// same transaction (cor:agt:050:11). The platform never reads what the work is.
//
// WHO THE ACTOR IS. A request acts either as a WORKER or as a PERSON:
//   - a WORKER when the request's validated session binding names a Worker
//     (#1610 `currentActor()` — filled from the X-Hadron-Session header on
//     GraphQL, or from the MCP tool's `session` argument). Workers are App
//     participants through their session (Holger, team chat #7489): only a
//     participant can cast a worker or drive its session. That holds at bind
//     time, so the gate makes it hold on EVERY call: the worker belongs to
//     THIS App and is not retired, AND the credential may still drive it —
//     the shared `mayStillDriveWorkerApp` (#1540): current participation in a
//     live App (#1713 review, Rook P1-2: a session's userId is historical, so
//     a removed member's open worker session must stop authorizing).
//   - a PERSON otherwise: the credential's user, who must pass the shared
//     App-participation predicate (`isAppParticipant`, cor:acl:010:01).
// A pure App key is refused, with or without a worker binding. INTERIM until
// Holger rules cor:agt:050:21 (#1713 review, Rook P2-1): an App key validates
// ANY open session of its App, including one a person started on their
// worker, so admitting it would let any key holder act as any worker whose
// session id it has seen. A request that NAMED a session that did not
// validate is refused rather than silently acting as its human driver.
//
// EVERY WRITE RE-GATES INSIDE ITS TRANSACTION (#1713 review, Diego P2-A):
// `inTaskWriteTx` runs under `withAuthorizedTx`, taking SHARED authority
// anchors on the App (+ its org, or its owner) and the caller — the anchors
// removeAppMember / removeOrgMember / updateOrgMember / deleteApp take
// EXCLUSIVELY — plus FOR SHARE on the caller's AppMember row (self-service
// leaveApp deletes it unanchored) and the bound worker's row (retireWorker
// updates it). It then re-runs the actor gate and the App-lifecycle checks on
// the TRANSACTION client, and manager / party checks use that client too. A
// revocation or uninstall that commits first is seen; one that comes later
// waits for this write.
//
// FOR T6 (Rook P3-4): a task write grants no platform authority, so an
// assignment is only a record. Launch-on-assign changes that, because a launch
// is an effect with real authority. The launch path must re-gate at launch time
// (participation, holder, App live), not trust the assignment it was queued from.
//
// AUTHORIZATION (cor:agt:050:06–:09, plan §10, rulings on epic #1704):
//   create root     any App participant (050:06); the creator may name the
//                   owner at creation — any participating worker or person
//                   (050:01, Holger team chat #8183; #1757)
//   create child    the parent's assignee, who owns the child (050:07)
//   assign/cancel   the task's owner, or whoever manages the App (050:09, Proposed)
//   reassign        the task's owner (ruled, D-2026-10-07-004), or an App manager (Proposed)
//   all three, also a worker the task's owner reports to, up the chain (#1726, #7804)
//   start/progress/finish   the assignee only (050:08, Proposed)
//   read            the App's participants, workers included (050:21, Proposed)
// "Whoever manages the App" is cor:acl:010:01 as Holger ruled it on
// 2026-10-10 (team chat #7790, #1731; `managesApp`): the App's user-owner,
// owner-role AppMembers, org ADMIN/OWNER and platform admins. It replaced the
// strict reading of #1713 (Rook P1-1), whose self-grant risk #1714 closed:
// `joinApp` never hands out `owner`.
// INTERIM (team chat #7508): the App-manager arm counts only for a PERSON
// acting as themselves; a worker acting through its session does not inherit
// its driver's management rights. This is attribution hygiene, NOT a privilege
// boundary (Rook P3-3): the same credential can act as the person by sending
// no worker session. It keeps a worker's own acts from being recorded as
// management acts. A worker's own authority over others' tasks is 050:09's
// `reportsTo` arm (Holger #7804; built with #1726), not its driver's role.
//
// CONCEALMENT: a task the caller cannot read — including one in another App,
// or a parent named across Apps — reads as TASK_NOT_FOUND (mutations) or null
// (queries), never Forbidden: no existence oracle over task ids (#1577 posture).
// An App the caller does not participate in reads exactly like an absent one:
// APP_NOT_FOUND (#1713 review, Rook P3-1; the resolvePilotApp posture).

import { normalizeFamily } from '../../../lib/agentTasks/family.js';
import { GraphQLError } from 'graphql';
import { Prisma, type PrismaClient } from '../../../generated/prisma/index.js';
import { type Context, isAppParticipant, clampListTake, withoutRequestCaches, pageArgs, pageEnvelope } from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AppNotFoundError, WorkerNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { parseTaskHandle, composeTaskHandle, handleDepth, MAX_HANDLE_DEPTH, MAX_HANDLE_LENGTH } from '../../../lib/agentTasks/handle.js';
import { ensureProjectZero, PROJECT_ZERO_HANDLE, rootTaskWhere } from '../../../lib/agentTasks/projectZero.js';
import { composeWorkerUrn, resolveWorkerRef as resolveWorkerRefId } from '../../../lib/entityRef/workerRef.js';
import { resolveWorkerIdByName } from './resolvers.worker.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { lockAppReportsTo } from '../../../lib/workerReportsTo.js';
import { lockStopFence } from '../../../lib/stopSignals/state.js';
import { refuseStoppedAssignee } from '../../../lib/stopSignals/enforce.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { mayStillDriveWorkerApp } from '../../../lib/teamAttention.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { currentActor } from '../../../lib/requestActor.js';
import { appKeyCaller, refuseSessionBound } from '../../../lib/appKeyScopes/scopes.js';
import { keyHostId } from '../../../lib/hostOperations/hostKey.js';
import { launchForAssignment } from '../../../lib/hostOperations/launch.js';
import { requestSessionEnd } from '../../../lib/hostOperations/sessionEnd.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { isWorkerResetting, requestContextResetSafely } from '../../../lib/contextReset/contextReset.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import {
  appendTaskEvent,
  eventActor,
  TASK_EVENT_TYPES,
  TASK_EDIT_FIELDS,
  type TaskEditField,
  type EventActor,
  type TaskParty,
} from '../../../lib/agentTasks/events.js';
import { loadAppModelGroups, matchAfterChange } from '../../../lib/agentTasks/matcher.js';
import { normalizeModelGroupName } from '../../../lib/agentTasks/modelGroups.js';
import { checkAgainstTeamSchema, normalizeTaskProperties, propertiesFingerprint, type PropertiesFingerprint } from '../../../lib/agentTasks/properties.js';
import { emitTaskWarnings, readAssigneeFacts, type TaskWarningCode } from './resolvers.taskWarnings.js';
import type { GraphQLResolveInfo } from 'graphql';

// ── Limits ────────────────────────────────────────────────────────────────

export const TASK_TITLE_MAX = 500;
export const TASK_DESCRIPTION_MAX = 20_000;
export const TASK_SOURCE_MAX = 2_048;
export const TASK_SUMMARY_MAX = 20_000;
export const TASK_EVIDENCE_MAX = 2_048;
export const TASK_TAG_MAX = 64;
export const TASK_TAGS_MAX = 32;
export const TASK_REQUIREMENT_LIST_MAX = 32;
/**
 * An outcome is a WORD (cor:agt:050:01: `succeeded`, `failed`, or a word the
 * team chooses) — and it is copied into the event stream, which must never
 * carry free text (050:11). So it is held to a token shape here.
 */
export const TASK_OUTCOME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TASK_TREE_MAX = 1_000;

const STATUSES = ['backlog', 'pending', 'started', 'finished', 'cancelled'] as const;
type TaskStatus = (typeof STATUSES)[number];
const ENDED: readonly string[] = ['finished', 'cancelled'];
const OPEN: TaskStatus[] = ['pending', 'started'];

/**
 * #1754 (cor:agt:050:02): a task enters as backlog or pending — every other
 * status is reached by a move, never at creation. A backlog task is parked: no
 * assignee (so never matched, never waited on, no alarms); assigning it or
 * making it ready moves it to pending.
 */
function normalizeCreateStatus(value: string | null | undefined): 'backlog' | 'pending' {
  if (value == null || value === '') return 'pending';
  const s = value.toLowerCase();
  if (s === 'backlog' || s === 'pending') return s;
  throw badInput('status at creation is PENDING (the default) or BACKLOG; every other status is reached by a move.');
}

// ── Errors ────────────────────────────────────────────────────────────────

export function taskError(code: string, message: string, ext: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...ext } });
}
const notFound = (taskId: string): GraphQLError =>
  taskError('TASK_NOT_FOUND', 'Task not found.', { taskId });
/** #2664: the longest `text` filter, after trimming. */
const TASK_TEXT_FILTER_MAX = 200;
const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const forbidden = (message = 'You are not a participant of this App.'): GraphQLError =>
  taskError('FORBIDDEN', message);

// ── Rows ──────────────────────────────────────────────────────────────────

const APP_SELECT = {
  id: true, name: true, urn: true, organizationId: true, ownerUserId: true,
  uninstalledAt: true, deletedAt: true,
} as const;
export type TaskApp = Prisma.AppGetPayload<{ select: typeof APP_SELECT }>;
type TaskRow = Prisma.AgentTaskGetPayload<Record<string, never>>;

/** Who is acting on a task: a worker through its session, or a person as themselves. */
export type TaskActor =
  | { kind: 'worker'; workerId: string; agentId: string | null; userId: string | null }
  | { kind: 'user'; userId: string };

/**
 * #1756 (cor:agt:050:06): a headless run of the App creating a root task. Not a `TaskActor`: a run is never an
 * owner, an assignee or a participant, so no read or transition path ever sees one. It exists for the one write it
 * is allowed, and `inTaskWriteTx` re-gates it under the App's anchors like any other creator.
 */
export type RunCreator = { kind: 'run'; runId: string };

/** The run is this App's, and still running, judged under the write's locks (a finished run creates nothing). */
async function requireRunLive(txCtx: Context, app: TaskApp, runId: string): Promise<void> {
  if (app.deletedAt) throw new TaskGateRefused();
  const rows = await txCtx.db.$queryRaw<Array<{ app_id: string; status: string }>>`
    SELECT app_id, status::text AS status FROM app_runs WHERE id = ${runId} FOR SHARE`;
  if (rows.length !== 1 || rows[0]!.app_id !== app.id || rows[0]!.status !== 'RUNNING') throw new TaskGateRefused();
}

// ── The access gate ───────────────────────────────────────────────────────

/**
 * The actor for this request in `app`, or null when the caller is not a
 * participant. ONE computation for every read and write surface, built on the
 * shared participation predicate rather than a per-resolver gate.
 */
export async function resolveTaskActor(ctx: Context, app: TaskApp): Promise<TaskActor | null> {
  if (app.deletedAt) return null;
  const bound = currentActor();
  if (bound.workerId) {
    // INTERIM until cor:agt:050:21 is ruled (Rook P2-1): no App key acts as a
    // worker, even through a validated session of its own App.
    if (!ctx.userId) return null;
    const worker = await ctx.db.worker.findUnique({
      where: { id: bound.workerId },
      select: { appId: true, retiredAt: true },
    });
    if (!worker || worker.appId !== app.id || worker.retiredAt) return null;
    // The credential must STILL be able to drive this App's workers (Rook P1-2).
    if (!(await mayStillDriveWorkerApp(ctx, app.id))) return null;
    return { kind: 'worker', workerId: bound.workerId, agentId: bound.agentId, userId: ctx.userId };
  }
  if (!ctx.userId) return null;
  if (!(await isAppParticipant(ctx, app))) return null;
  return { kind: 'user', userId: ctx.userId };
}

/** The write-side preconditions every task mutation shares, after the actor resolved. */
export function requireWritable(ctx: Context, app: TaskApp): void {
  if (ctx.impersonation) throw forbidden('Impersonation sessions are read-only.');
  if (ctx.sessionBindingRefused) {
    throw taskError(
      'SESSION_NOT_BOUND',
      'The session this request names is not one of your open sessions (it may have ended). ' +
        'Nothing was written. Bind a live session, or send no session to act as yourself.',
    );
  }
  if (app.uninstalledAt) throw taskError('APP_UNINSTALLED', 'This App is uninstalled; its tasks are read-only.');
}

export async function loadApp(ctx: Context, appId: string): Promise<TaskApp | null> {
  return ctx.db.app.findUnique({ where: { id: appId }, select: APP_SELECT });
}

const appNotFound = (appRef: string): GraphQLError => taskError('APP_NOT_FOUND', 'App not found.', { appRef });

/**
 * Resolve an App ref the caller participates in. An App that does not exist
 * and one the caller may not read answer the SAME refusal (Rook P3-1).
 */
export async function resolveParticipatedApp(ctx: Context, appRef: string): Promise<{ app: TaskApp; actor: TaskActor }> {
  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(ctx.db, appRef));
  } catch (e) {
    if (e instanceof AppNotFoundError) throw appNotFound(appRef);
    throw e;
  }
  const app = await loadApp(ctx, appId);
  if (!app) throw appNotFound(appRef);
  const actor = await resolveTaskActor(ctx, app);
  if (!actor) throw appNotFound(appRef);
  return { app, actor };
}

/**
 * cor:agt:050:21 (#1755): a pure App key reads the tasks and events of its OWN
 * App, and nothing else. READ-ONLY by construction: it yields no `TaskActor`,
 * so every write path (which needs one) still refuses it, and it never acts as a
 * worker. A foreign, deleted or revoked-key App answers like a missing one; only
 * then is a session refused, so a key learns nothing about an App not its own.
 * Judged on `ctx.db`, which for a key's read is the read's own transaction.
 */
async function keyMayReadApp(ctx: Context, app: TaskApp): Promise<boolean> {
  const key = appKeyCaller(ctx);
  if (!key || app.deletedAt || app.id !== key.appId) return false;
  const live = await ctx.db.appKey.findFirst({
    where: { id: key.appKeyId, appId: app.id, revokedAt: null },
    select: { id: true },
  });
  if (!live) return false;
  if (app.organizationId) {
    const org = await ctx.db.organization.findFirst({ where: { id: app.organizationId, deletedAt: null }, select: { id: true } });
    if (!org) return false;
  }
  // A key never narrows or widens its read through a session (Holger #8097).
  refuseSessionBound(ctx);
  if (currentActor().workerId) {
    throw taskError('APP_KEY_SESSION_BOUND', 'An App key does not act as a worker. Send no session.');
  }
  return true;
}

/**
 * A key's whole read in ONE transaction that holds the App's authority anchors
 * SHARED: whoever revokes the key or deletes the App takes them exclusively, so
 * either the revocation committed first and the key is refused here, or it waits
 * for this read. The App and the key are re-read after the lock. `onGone` runs
 * (and its refusal propagates) when the key may not read.
 */
async function inKeyReadTx<T>(
  ctx: Context,
  appId: string,
  onGone: () => T,
  body: (txCtx: Context, app: TaskApp) => Promise<T>,
): Promise<T> {
  return inAnchoredAppTx(ctx, appId, onGone, async (txCtx, app) => ((await keyMayReadApp(txCtx, app)) ? body(txCtx, app) : onGone()));
}

/** One transaction holding the App's authority anchors SHARED, with the App re-read after the lock (see `inKeyReadTx`). */
async function inAnchoredAppTx<T>(
  ctx: Context,
  appId: string,
  onGone: () => T,
  body: (txCtx: Context, app: TaskApp) => Promise<T>,
): Promise<T> {
  const head = await loadApp(ctx, appId);
  if (!head) return onGone();
  return ctx.db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [
      { kind: 'app', id: head.id },
      ...(head.organizationId ? [{ kind: 'org' as const, id: head.organizationId }] : []),
      ...(head.ownerUserId ? [{ kind: 'user' as const, id: head.ownerUserId }] : []),
    ], 'shared');
    const txCtx = withoutRequestCaches(ctx, tx);
    const app = await loadApp(txCtx, appId);
    // Ownership moved while we waited for the anchors: the locks we hold are the wrong ones, so answer as missing.
    if (!app || app.organizationId !== head.organizationId || app.ownerUserId !== head.ownerUserId) return onGone();
    return body(txCtx, app);
  });
}

/**
 * #2931 (V6, Holger 2026-10-31; cor:agt:070:04, cor:agt:080:18, :22) — the host this caller reads an App's tickers
 * as: the App's OWN key holding a live `host:operate` scope, or null. Judged on `ctx.db`, which is the read's own
 * transaction under the App's shared anchors, so a scope or key revoked while the read waited is seen.
 *
 * ORDER, so that every caller this does not admit gets exactly today's answer (APP_NOT_FOUND / null):
 * own App, App and org live, then the scope (`keyHostId`: a live scope on an unrevoked key of an installed App),
 * and ONLY THEN the session refusal. A session-bound key without the scope still reads "not found"; a host key
 * learns only that it carries a session. Unlike `keyMayReadApp`, an unscoped own-App key is NOT admitted, and no
 * worker set is derived for a key without a host: such a key is refused, never given an "unregistered" set.
 * READ-ONLY by construction: it yields no `TaskActor`, so every write still refuses the key.
 */
async function hostKeyTickerReader(ctx: Context, app: TaskApp): Promise<string | null> {
  const key = appKeyCaller(ctx);
  if (!key || app.deletedAt || app.id !== key.appId) return null;
  if (app.organizationId) {
    const org = await ctx.db.organization.findFirst({ where: { id: app.organizationId, deletedAt: null }, select: { id: true } });
    if (!org) return null;
  }
  const hostId = await keyHostId(ctx.db, key);
  if (!hostId) return null;
  refuseSessionBound(ctx);
  if (currentActor().workerId) throw taskError('APP_KEY_SESSION_BOUND', 'A host key does not act as a worker. Send no session.');
  return hostId;
}

/**
 * #2931 — a host key's ticker read of App `appId`, in one transaction under the App's shared anchors: `body` runs
 * with the host the key operates as, re-judged after the lock; `onGone` answers (or throws) for anyone else.
 */
export async function inHostKeyTickerReadTx<T>(
  ctx: Context,
  appId: string,
  onGone: () => T,
  body: (txCtx: Context, app: TaskApp, hostId: string) => Promise<T>,
): Promise<T> {
  return inAnchoredAppTx(ctx, appId, onGone, async (txCtx, app) => {
    const hostId = await hostKeyTickerReader(txCtx, app);
    return hostId ? body(txCtx, app, hostId) : onGone();
  });
}

/** #2931 — `inHostKeyTickerReadTx` by App ref: another App's ref, or one that resolves to nothing, is APP_NOT_FOUND as today. */
export async function withHostKeyTickerApp<T>(
  ctx: Context,
  appRef: string,
  body: (txCtx: Context, app: TaskApp, hostId: string) => Promise<T>,
): Promise<T> {
  const key = appKeyCaller(ctx);
  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(ctx.db, appRef));
  } catch (e) {
    if (e instanceof AppNotFoundError) throw appNotFound(appRef);
    throw e;
  }
  if (!key || appId !== key.appId) throw appNotFound(appRef);
  return inHostKeyTickerReadTx(ctx, appId, () => { throw appNotFound(appRef); }, body);
}

/** Run a read over an App the caller may READ tasks and events of: a participant, or the App's own key. */
export async function withReadableApp<T>(ctx: Context, appRef: string, body: (c: Context, app: TaskApp) => Promise<T>): Promise<T> {
  const key = appKeyCaller(ctx);
  if (!key) {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    return body(ctx, app);
  }
  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(ctx.db, appRef));
  } catch (e) {
    if (e instanceof AppNotFoundError) throw appNotFound(appRef);
    throw e;
  }
  if (appId !== key.appId) throw appNotFound(appRef);
  return inKeyReadTx(ctx, appId, () => { throw appNotFound(appRef); }, body);
}

/**
 * #1708 — may this caller read the App's tasks and events (cor:agt:050:21)? The arms of `withReadableApp`,
 * as a boolean: a participant (a person, or a worker session whose credential may still drive the App), or
 * the App's own live key. App-wide: whoever reads one of the App's tasks reads them all.
 */
export async function mayReadAppTasks(ctx: Context, appId: string): Promise<boolean> {
  const app = await loadApp(ctx, appId);
  if (!app || app.deletedAt) return false;
  if (appKeyCaller(ctx)) return keyMayReadApp(ctx, app);
  return (await resolveTaskActor(ctx, app)) !== null;
}

/** The Apps a person belongs to for tasks: those where the shared participation predicate admits them. Read in pages of this size. */
const HANDLE_APP_CAP = 200;
async function participatedAppIds(ctx: Context): Promise<string[]> {
  if (!ctx.userId) return [];
  const [memberships, orgs] = await Promise.all([
    ctx.db.appMember.findMany({ where: { userId: ctx.userId }, select: { appId: true } }),
    ctx.db.orgMember.findMany({ where: { userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP }, select: { organizationId: true } }),
  ]);
  const where: Prisma.AppWhereInput = {
    deletedAt: null,
    OR: [
      { ownerUserId: ctx.userId },
      { id: { in: memberships.map((m) => m.appId) } },
      { organizationId: { in: orgs.map((o) => o.organizationId) } },
    ],
  };
  // Pages of HANDLE_APP_CAP by id until a second admitted App is found or the candidates run out: the refusal below
  // needs only to know the count exceeds one, so a later page can never be skipped into a wrong single answer.
  const admitted: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.db.app.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: APP_SELECT,
      orderBy: { id: 'asc' },
      take: HANDLE_APP_CAP,
    });
    for (const app of page) {
      if (await resolveTaskActor(ctx, app)) admitted.push(app.id);
      if (admitted.length > 1) return admitted;
    }
    if (page.length < HANDLE_APP_CAP) return admitted;
    cursor = page[page.length - 1]!.id;
  }
}

/** The ONE App a BARE handle means for this caller: a key's own App, a worker session's App, else the one App a person belongs to. */
async function bareHandleApp(ctx: Context, ref: string): Promise<string | null> {
  const key = appKeyCaller(ctx);
  if (key) return key.appId;
  const bound = currentActor();
  if (bound.workerId) {
    const worker = await ctx.db.worker.findUnique({ where: { id: bound.workerId }, select: { appId: true } });
    return worker?.appId ?? null;
  }
  const apps = await participatedAppIds(ctx);
  if (apps.length > 1) {
    // Decided by HOW MANY Apps the caller belongs to and nothing else: never by whether any task has this number
    // (otherwise the refusal would say where a task exists).
    throw taskError('TASK_HANDLE_QUALIFY',
      'You belong to more than one App, so a bare handle is ambiguous. Qualify it: hrn:agenttask:<app-urn>:AT<number>.', { taskId: ref });
  }
  return apps[0] ?? null;
}

/**
 * #2553: a task reference to the canonical task id — or null when it names nothing. An id passes through; a handle
 * (bare, or qualified by the App's URN) is looked up by (App, number). It decides NOTHING about access: every
 * caller still runs the existing readable-task gate on the id, so a handle for a task the caller may not read, in
 * an App they cannot read, or for no task at all all end as the same not-found answer an unknown id gets.
 * `inApp` fixes the App when the surface already names one (a list filter), which a qualified handle must match.
 */
export async function resolveTaskRef(ctx: Context, ref: unknown, inApp?: string): Promise<string | null> {
  if (typeof ref !== 'string') return null;
  if (isId(ref)) return ref;
  const handle = parseTaskHandle(ref);
  if (!handle) return null;
  let appId: string | null;
  if (handle.appUrn) {
    try {
      appId = (await resolveAppRef(ctx.db, handle.appUrn)).id;
    } catch (e) {
      if (e instanceof AppNotFoundError) return null;
      throw e;
    }
    if (inApp && appId !== inApp) return null;
  } else {
    appId = inApp ?? (await bareHandleApp(ctx, ref));
  }
  if (!appId) return null;
  const row = await ctx.db.agentTask.findUnique({ where: { appId_handle: { appId, handle: handle.handle } }, select: { id: true } });
  return row?.id ?? null;
}

/** Load a task the caller may read, with its App and the actor — or null (concealed as missing). */
async function loadReadableTask(
  ctx: Context,
  taskRef: string,
): Promise<{ task: TaskRow; app: TaskApp; actor: TaskActor } | null> {
  const taskId = await resolveTaskRef(ctx, taskRef);
  if (!taskId) return null;
  const task = await ctx.db.agentTask.findUnique({ where: { id: taskId } });
  if (!task) return null;
  const app = await loadApp(ctx, task.appId);
  if (!app) return null;
  const actor = await resolveTaskActor(ctx, app);
  if (!actor) return null;
  return { task, app, actor };
}

/** A task the caller may READ, with its App: a participant, or the App's own key (#1755). Null when missing or unreadable. */
async function withReadableTask<T>(
  ctx: Context,
  taskRef: string,
  body: (c: Context, r: { task: TaskRow; app: TaskApp }) => Promise<T>,
): Promise<T | null> {
  const key = appKeyCaller(ctx);
  if (!key) {
    const readable = await loadReadableTask(ctx, taskRef);
    return readable ? body(ctx, readable) : null;
  }
  const taskId = await resolveTaskRef(ctx, taskRef);
  if (!taskId) return null;
  const head = await ctx.db.agentTask.findUnique({ where: { id: taskId }, select: { appId: true } });
  if (!head || head.appId !== key.appId) return null;
  return inKeyReadTx<T | null>(ctx, head.appId, () => null, async (txCtx, app) => {
    const task = await txCtx.db.agentTask.findUnique({ where: { id: taskId } });
    return task && task.appId === app.id ? body(txCtx, { task, app }) : null;
  });
}

/** Is the actor this party? A person never matches a worker party, nor the reverse. */
function actorIs(actor: TaskActor, workerId: string | null, userId: string | null): boolean {
  if (actor.kind === 'worker') return workerId !== null && workerId === actor.workerId;
  return workerId === null && userId !== null && userId === actor.userId;
}
const isOwner = (actor: TaskActor, t: Pick<TaskRow, 'ownerWorkerId' | 'ownerUserId'>): boolean => actorIs(actor, t.ownerWorkerId, t.ownerUserId);
const isAssignee = (actor: TaskActor, t: Pick<TaskRow, 'assigneeWorkerId' | 'assigneeUserId'>): boolean =>
  actorIs(actor, t.assigneeWorkerId, t.assigneeUserId);

/**
 * Whoever manages the App — cor:acl:010:01 as Holger ruled it on 2026-10-10
 * (`managesApp`, #1731). INTERIM: a person acting as themselves only — see the
 * file header. Called with the transaction context, so it reads committed
 * state under the write's anchors, with platform roles re-read from the user row.
 */
export async function actorManagesApp(ctx: Context, app: TaskApp, actor: TaskActor): Promise<boolean> {
  if (actor.kind !== 'user' || ctx.impersonation) return false;
  return managesApp(ctx, app);
}

/**
 * #1726 / cor:agt:050:09 (Holger, team chat #7804): a worker may assign,
 * reassign and cancel the tasks owned by workers that report to it, directly
 * or up the `reportsTo` chain. There is no separate coordinator grant, and a
 * team with no `reportsTo` lines has no worker coordinators.
 *
 * Walked on the transaction client under the App's reportsTo graph lock, which
 * `inTaskWriteTx` takes SHARED before any row: a `reportsTo` change (or a
 * retirement, which clears one) either committed first and is seen here, or
 * waits for this write. The walk locks no rows of its own, so it adds no
 * worker-row order to conflict with the writer's (#1737 review, Diego P2-3).
 * It stops at the first worker that reports to nobody; a retired worker
 * reports to nobody, so a chain never runs through one.
 */
async function actorCoordinatesOwner(tx: Prisma.TransactionClient, actor: TaskActor, task: Pick<TaskRow, 'ownerWorkerId'>): Promise<boolean> {
  if (actor.kind !== 'worker' || !task.ownerWorkerId) return false;
  let current = task.ownerWorkerId;
  for (let hops = 0; hops < 1000; hops++) {
    const row = await tx.worker.findUnique({ where: { id: current }, select: { reportsToWorkerId: true } });
    const next = row?.reportsToWorkerId ?? null;
    if (!next) return false;
    if (next === actor.workerId) return true;
    current = next;
  }
  return false;
}

/** The task's owner, whoever manages the App, or (#1726) a worker the owner reports to. */
async function mayDirectTask(tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor, task: Pick<TaskRow, 'ownerWorkerId' | 'ownerUserId'>): Promise<boolean> {
  return isOwner(actor, task) || (await actorManagesApp(txCtx, app, actor)) || (await actorCoordinatesOwner(tx, actor, task));
}

/**
 * #2420 (cor:agt:050:28): who may write a task's `properties` — the cor:agt:050:09 set (owner, a worker the owner
 * reports to, whoever manages the App) AND the task's own assignee; nobody else. Asked of a task row or, at creation,
 * of the facts the new row will carry.
 */
async function mayWriteProperties(
  tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor,
  task: Pick<TaskRow, 'ownerWorkerId' | 'ownerUserId' | 'assigneeWorkerId' | 'assigneeUserId'>,
): Promise<boolean> {
  return (await mayDirectTask(tx, txCtx, app, actor, task)) || isAssignee(actor, task);
}

function sameActor(a: TaskActor, b: TaskActor): boolean {
  return a.kind === b.kind && (a.kind === 'worker'
    ? a.workerId === (b as { workerId: string }).workerId
    : a.userId === b.userId);
}

export function actorParty(actor: TaskActor): TaskParty {
  return actor.kind === 'worker' ? { workerId: actor.workerId } : { userId: actor.userId };
}

// ── Party and field validation ────────────────────────────────────────────

type PartyInput = { worker?: string | null; user?: string | null } | null | undefined;

/**
 * Resolve an owner or assignee to a party of THIS App: a worker cast into the
 * App and not retired, or a person who participates in it (#1705 assignee
 * validation). Anything else is refused with `invalidCode` — the same refusal
 * whether the ref names nobody or somebody elsewhere.
 */
async function resolveParty(
  ctx: Context,
  app: TaskApp,
  input: NonNullable<PartyInput>,
  invalidCode: 'TASK_ASSIGNEE_INVALID' | 'TASK_OWNER_INVALID',
): Promise<TaskParty> {
  const worker = input.worker?.trim() || null;
  const user = input.user?.trim() || null;
  if ((worker === null) === (user === null)) {
    throw badInput('Name exactly one of worker or user.');
  }
  const invalid = (ref: string) =>
    taskError(invalidCode, `${ref} is not a ${invalidCode === 'TASK_OWNER_INVALID' ? 'possible owner' : 'possible assignee'} in this App: it must be a worker of the App that is not retired, or a person who participates in it.`, { ref });
  if (worker !== null) {
    const workerId = await resolveTaskWorkerId(ctx, app.id, worker);
    if (!workerId) throw invalid(worker);
    const row = await ctx.db.worker.findUnique({ where: { id: workerId }, select: { appId: true, retiredAt: true } });
    if (!row || row.appId !== app.id || row.retiredAt) throw invalid(worker);
    return { workerId };
  }
  const ref = (user as string).replace(/^@/, '');
  const row = isId(ref)
    ? await ctx.db.user.findFirst({ where: { id: ref, deletedAt: null }, select: { id: true } })
    : await ctx.db.user.findFirst({
        where: { handle: { equals: ref, mode: 'insensitive' }, deletedAt: null },
        select: { id: true },
      });
  if (!row) throw invalid(user as string);
  // The target's participation, judged on the target alone (no caller roles).
  const participates = await isAppParticipant({ db: ctx.db, userId: row.id } as Context, app);
  // (ctx.db is the write's transaction client when called from a mutation.)
  if (!participates) throw invalid(user as string);
  return { userId: row.id };
}

/** A worker ref within an App: its id, its URN, or its name. Null when it names nothing. */
export async function resolveTaskWorkerId(ctx: Context, appId: string, ref: string): Promise<string | null> {
  if (isId(ref) || ref.startsWith('hrn:')) {
    try {
      return (await resolveWorkerRefId(ctx.db, ref)).id;
    } catch (e) {
      if (e instanceof WorkerNotFoundError) return null;
      throw e;
    }
  }
  return resolveWorkerIdByName(ctx.db, appId, ref);
}

function partyColumns(prefix: 'owner' | 'assignee' | 'creator', p: TaskParty | null) {
  if (prefix === 'owner') return { ownerWorkerId: p?.workerId ?? null, ownerUserId: p?.userId ?? null };
  // `createdBy` projects the worker when createdByWorkerId is set, else the person (see the AgentTask
  // resolver), and a worker-session create stamps BOTH columns. The filter matches the projection: a
  // person is the creator only where no worker was (#2370).
  if (prefix === 'creator') {
    return p?.workerId
      ? { createdByWorkerId: p.workerId }
      : { createdBy: p?.userId ?? null, createdByWorkerId: null };
  }
  return { assigneeWorkerId: p?.workerId ?? null, assigneeUserId: p?.userId ?? null };
}

function sameParty(a: TaskParty, b: TaskParty): boolean {
  return (a.workerId ?? null) === (b.workerId ?? null) && (a.userId ?? null) === (b.userId ?? null);
}

function assigneeOf(t: TaskRow): TaskParty | null {
  if (t.assigneeWorkerId) return { workerId: t.assigneeWorkerId };
  if (t.assigneeUserId) return { userId: t.assigneeUserId };
  return null;
}

function optionalText(value: string | null | undefined, max: number, field: string): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === '') return null;
  if (v.length > max) throw badInput(`${field} is longer than ${max} characters.`);
  return v;
}

function normalizeTitle(title: string): string {
  const t = (title ?? '').trim();
  if (t === '') throw badInput('A task needs a title.');
  if (t.length > TASK_TITLE_MAX) throw badInput(`title is longer than ${TASK_TITLE_MAX} characters.`);
  return t;
}

function normalizeTags(tags: readonly string[] | null | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const t = (raw ?? '').trim();
    if (t === '') continue;
    if (t.length > TASK_TAG_MAX) throw badInput(`A tag is longer than ${TASK_TAG_MAX} characters.`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > TASK_TAGS_MAX) throw badInput(`A task carries at most ${TASK_TAGS_MAX} tags.`);
  return out;
}

const REQUIREMENT_KEYS = new Set(['role', 'familyIn', 'familyNotIn', 'excludeWorkers', 'minTier', 'modelGroupIn', 'modelGroupNotIn']);

type RequirementsInput = {
  role?: string | null;
  familyIn?: string[] | null;
  familyNotIn?: string[] | null;
  excludeWorkers?: string[] | null;
  minTier?: string | null;
  modelGroupIn?: string[] | null;
  modelGroupNotIn?: string[] | null;
};

/** The matcher's requirements (plan §3.1). Stored for T3; validated here. */
async function normalizeRequirements(
  ctx: Context,
  app: TaskApp,
  input: RequirementsInput | null | undefined,
): Promise<Prisma.InputJsonObject | null> {
  if (!input) return null;
  // #2252 D1: there is no `maxTier`, and no other key is read here, so an unknown one is refused rather than silently
  // dropped (GraphQL validation already refuses it; this holds for any caller that reaches the resolver, MCP included).
  const unknown = Object.keys(input).filter((k) => !REQUIREMENT_KEYS.has(k));
  if (unknown.length) throw badInput(`requirements has no field ${unknown.map((k) => `"${k}"`).join(', ')}${unknown.includes('maxTier') ? ' (a task names a minimum tier, minTier, never a maximum)' : ''}.`);
  const role = optionalText(input.role, 128, 'requirements.role');
  const list = (xs: string[] | null | undefined, field: string): string[] | null => {
    if (!xs) return null;
    const out = [...new Set(xs.map((x) => (x ?? '').trim()).filter((x) => x !== ''))];
    if (out.length > TASK_REQUIREMENT_LIST_MAX) throw badInput(`${field} has more than ${TASK_REQUIREMENT_LIST_MAX} entries.`);
    if (out.some((x) => x.length > 64)) throw badInput(`An entry of ${field} is longer than 64 characters.`);
    return out.length ? out : null;
  };
  const families = (xs: string[] | null | undefined, field: string) => {
    const values = list(xs, field);
    if (!values) return null;
    const canonical = values.map(normalizeFamily);
    if (canonical.some((f) => f === null)) throw badInput(`${field} entries must be model family tokens (letters, digits, ".", "_" or "-").`);
    return [...new Set(canonical as string[])];
  };
  const familyIn = families(input.familyIn, 'requirements.familyIn');
  const familyNotIn = families(input.familyNotIn, 'requirements.familyNotIn');
  if (familyIn && familyNotIn) throw badInput('Name familyIn or familyNotIn, not both.');
  const excludeRefs = list(input.excludeWorkers, 'requirements.excludeWorkers');
  let excludeWorkerIds: string[] | null = null;
  if (excludeRefs) {
    excludeWorkerIds = [];
    for (const ref of excludeRefs) {
      const id = await resolveTaskWorkerId(ctx, app.id, ref);
      const row = id ? await ctx.db.worker.findUnique({ where: { id }, select: { appId: true } }) : null;
      if (!id || !row || row.appId !== app.id) {
        throw badInput(`requirements.excludeWorkers: ${ref} is not a worker of this App.`);
      }
      if (!excludeWorkerIds.includes(id)) excludeWorkerIds.push(id);
    }
  }
  // #2252 D1: exactly low | mid | high (cor:agt:060:06); anything else is refused, never read as "no bound".
  if (input.minTier != null && input.minTier !== 'low' && input.minTier !== 'mid' && input.minTier !== 'high') {
    throw badInput('requirements.minTier must be low, mid or high.');
  }
  // #2831 S2 (cor:agt:060:12): group names, lowercase; a name no effective group of this App carries is refused,
  // naming it, so a typo never becomes a filter that silently matches no one (In) or everyone (NotIn).
  const groupNames = (xs: string[] | null | undefined, field: string): string[] | null => {
    const values = list(xs, field);
    if (!values) return null;
    const names = values.map((v) => {
      const n = normalizeModelGroupName(v);
      if (!n) throw badInput(`${field} entries are model group names: letters, digits, ".", "_" or "-", up to 64 characters.`);
      return n;
    });
    return [...new Set(names)];
  };
  const modelGroupIn = groupNames(input.modelGroupIn, 'requirements.modelGroupIn');
  const modelGroupNotIn = groupNames(input.modelGroupNotIn, 'requirements.modelGroupNotIn');
  if (modelGroupIn || modelGroupNotIn) {
    const known = new Set((await loadAppModelGroups(ctx.db, app.id, { strict: true })).map((g) => g.name));
    for (const name of [...(modelGroupIn ?? []), ...(modelGroupNotIn ?? [])]) {
      if (!known.has(name)) throw taskError('MODEL_GROUP_NOT_FOUND', `No model group named "${name}" is declared for this App.`, { name });
    }
  }
  const out: Prisma.InputJsonObject = {
    ...(role ? { role } : {}),
    ...(familyIn ? { familyIn } : {}),
    ...(familyNotIn ? { familyNotIn } : {}),
    ...(excludeWorkerIds ? { excludeWorkerIds } : {}),
    ...(input.minTier ? { minTier: input.minTier } : {}),
    ...(modelGroupIn ? { modelGroupIn } : {}),
    ...(modelGroupNotIn ? { modelGroupNotIn } : {}),
  };
  return Object.keys(out).length ? out : null;
}

function parseStartBy(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw badInput('startBy is not a valid date-time.');
  return d;
}

// ── Audit stamping (#1610 actor shape) ────────────────────────────────────

function createdStamp(ctx: Context) {
  const a = currentActor();
  return {
    createdBy: ctx.userId ?? null, createdByWorkerId: a.workerId, createdByAgentId: a.agentId,
    updatedBy: ctx.userId ?? null, updatedByWorkerId: a.workerId, updatedByAgentId: a.agentId,
  };
}
function updatedStamp(ctx: Context) {
  const a = currentActor();
  return { updatedBy: ctx.userId ?? null, updatedByWorkerId: a.workerId, updatedByAgentId: a.agentId };
}
function assignedStamp(ctx: Context, at: Date) {
  const a = currentActor();
  return { assignedAt: at, assignedBy: ctx.userId ?? null, assignedByWorkerId: a.workerId, assignedByAgentId: a.agentId };
}

// ── Transactions ──────────────────────────────────────────────────────────

/** Row-lock a task inside a transaction and return its current state. */
async function lockTask(tx: Prisma.TransactionClient, taskId: string): Promise<TaskRow | null> {
  await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${taskId} FOR UPDATE`;
  return tx.agentTask.findUnique({ where: { id: taskId } });
}

/** The in-transaction gate refused: concealed by the caller as its own not-found. */
class TaskGateRefused extends Error {}

/**
 * Run a task write under the authority it depends on (#1713 review, Diego
 * P2-A). Takes the App's authority anchors SHARED (the revokers take them
 * EXCLUSIVELY), locks the caller's AppMember row and the bound worker's row
 * FOR SHARE, then re-runs the actor gate and the lifecycle checks on the
 * transaction client: the actor must be the same one the request resolved
 * before the wait. A refusal discovered here is `refused()` — the caller's
 * concealment — except an uninstall that won the race, which says so.
 */
export async function inTaskWriteTx<T>(
  ctx: Context,
  app: TaskApp,
  actor: TaskActor | RunCreator,
  refused: () => GraphQLError,
  write: (tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp) => Promise<T>,
  /**
   * `lockMode: 'exclusive'` for a writer that UPDATEs the anchored App row itself: it cannot upgrade a shared hold
   * without deadlocking its peers. `stopFence` (#2022): the App's stop fence, taken after the anchors and BEFORE the
   * reportsTo graph lock (src/lib/stopSignals/state.ts, the lock order). Every task write holds it shared, so an
   * assignment decision and a stop signal change are ordered; a stop signal writer asks for it exclusive.
   */
  options: {
    lockMode?: 'shared' | 'exclusive';
    stopFence?: 'shared' | 'exclusive';
    taskGraph?: 'shared' | 'exclusive';
    /**
     * #2162: the workers whose per-worker assignment lock this write takes (src/lib/agentTasks/workerLock.ts), right
     * after the reportsTo graph and BEFORE the app_members and workers rows below, so every task write takes it in
     * one order with the matcher, a session bind and a context reset's steps (Dan, #29368: inside `write()` it would
     * come after the worker row and cycle).
     */
    lockWorkerIds?: readonly (string | null | undefined)[];
  } = {},
): Promise<T> {
  const anchors: AuthorityAnchor[] = [
    { kind: 'app', id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ];
  const workerId = currentActor().workerId;
  let fresh: TaskApp | null = null;
  try {
    return await withAuthorizedTx(
      ctx,
      anchors,
      async (txCtx) => {
        fresh = await txCtx.db.app.findUnique({ where: { id: app.id }, select: APP_SELECT });
        if (!fresh) throw new TaskGateRefused();
        if (actor.kind === 'run') {
          await requireRunLive(txCtx, fresh, actor.runId);
        } else {
          const again = await resolveTaskActor(txCtx, fresh);
          if (!again || !sameActor(again, actor)) throw new TaskGateRefused();
        }
        requireWritable(txCtx, fresh);
      },
      (tx, txCtx) => write(tx, txCtx, fresh as TaskApp),
      {
        lockMode: options.lockMode,
        afterLock: async (tx) => {
          await lockStopFence(tx, app.id, options.stopFence ?? 'shared');
          await lockTaskGraph(tx, app.id, options.taskGraph ?? 'shared');
          // #1726: the reportsTo graph, SHARED, before any membership or worker
          // row (src/lib/workerReportsTo.ts, the lock protocol). The chain arm
          // of cor:agt:050:09 then reads a graph no writer can change before
          // this commits.
          await lockAppReportsTo(tx, app.id, 'shared');
          if (options.lockWorkerIds?.length) await lockWorkersForAssignment(tx, options.lockWorkerIds);
          if (ctx.userId) {
            await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${app.id} AND user_id = ${ctx.userId} FOR SHARE`;
          }
          if (workerId) await tx.$queryRaw`SELECT 1 FROM workers WHERE id = ${workerId} FOR SHARE`;
        },
      },
    );
  } catch (e) {
    const denied = e instanceof TaskGateRefused || (e instanceof Error && e.message === 'Forbidden');
    if (!denied) throw e;
    const now = await ctx.db.app.findUnique({ where: { id: app.id }, select: { deletedAt: true, uninstalledAt: true } });
    if (now && !now.deletedAt && now.uninstalledAt) {
      throw taskError('APP_UNINSTALLED', 'This App is uninstalled; its tasks are read-only.');
    }
    throw refused();
  }
}

/**
 * The shared shape of every mutation on an existing task: resolve the actor
 * (concealing an unreadable task), then — inside `inTaskWriteTx` — re-gate,
 * lock the task row, re-read it, and run `act` on the locked state with the
 * TRANSACTION context, so the authorization and state checks inside `act` see
 * exactly the row and the authority they depend on.
 */
async function mutateTask(
  ctx: Context,
  taskRef: string,
  act: (tx: Prisma.TransactionClient, task: TaskRow, actor: TaskActor, app: TaskApp, txCtx: Context, locked: ReadonlySet<string>) => Promise<void>,
  /**
   * #2162: the workers to take the per-worker lock on (src/lib/agentTasks/workerLock.ts), before any row. `assignee`
   * is the task's current worker assignee, read unlocked and then re-checked under the task's row lock: if it moved
   * in between, the write is retried once, then refused TASK_CONFLICT. `workers` are named by the write itself (a new
   * assignee).
   */
  locks: { taskGraph?: 'shared' | 'exclusive'; assignee?: boolean; workers?: (appId: string) => Promise<(string | null)[]> } = {},
): Promise<TaskRow> {
  const readable = await loadReadableTask(ctx, taskRef);
  if (!readable) throw notFound(taskRef);
  // #2553: AT0 is the platform's own row; no operation changes it, and it reads as a task for every other purpose.
  if (readable.task.handle === PROJECT_ZERO_HANDLE) {
    throw taskError('TASK_PROJECT_ZERO_FIXED', 'AT0 ("No project") is the platform\'s reserved project; no operation changes it.', { taskId: taskRef });
  }
  // #2553: the caller's spelling (an id or a handle) is echoed in refusals; every query below runs on the id.
  const taskId = readable.task.id;
  const { app, actor } = readable;
  requireWritable(ctx, app);
  for (let attempt = 0; ; attempt += 1) {
    const named = locks.workers ? await locks.workers(app.id) : [];
    const expected = locks.assignee
      ? (await ctx.db.agentTask.findUnique({ where: { id: taskId }, select: { assigneeWorkerId: true } }))?.assigneeWorkerId ?? null
      : null;
    try {
      await inTaskWriteTx(ctx, app, actor, () => notFound(taskRef), async (tx, txCtx, freshApp) => {
        const task = await lockTask(tx, taskId);
        if (!task || task.appId !== freshApp.id) throw notFound(taskRef);
        if (locks.assignee && task.assigneeWorkerId !== expected) throw new AssigneeMoved();
        await act(tx, task, actor, freshApp, txCtx, new Set([expected, ...named].filter((id): id is string => Boolean(id))));
      }, { lockWorkerIds: [expected, ...named], taskGraph: locks.taskGraph });
      break;
    } catch (e) {
      if (!(e instanceof AssigneeMoved)) throw e;
      if (attempt > 0) {
        throw taskError('TASK_CONFLICT', "The task's assignee changed while this write waited; read the task and try again.", { taskId: taskRef });
      }
    }
  }
  return ctx.db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
}

/**
 * #2162: the worker a write locks for moved between the unlocked read that chose the per-worker lock and the row lock
 * (the task's assignee, or the worker a ref resolves to).
 */
class AssigneeMoved extends Error {}

/**
 * #2162 (cor:agt:050:27 §4, R118): a worker under a `resetting` mark takes no new work on any path. Asked under the
 * worker's per-worker lock, so a claim cannot slip in between this check and the write.
 */
async function refuseResettingAssignee(tx: Prisma.TransactionClient, appId: string, workerId: string | null | undefined): Promise<void> {
  if (!workerId) return;
  if (await isWorkerResetting(tx, workerId, appId, new Date())) {
    throw taskError('WORKER_RESETTING', 'This worker is resetting its context; it takes no work until its relaunched agent acts.', { workerId });
  }
}

/** The worker a party input names, resolved unlocked to choose the per-worker lock; the write re-checks it locked. */
async function partyWorkerForLock(ctx: Context, appId: string, input: PartyInput): Promise<string | null> {
  const ref = input?.worker?.trim();
  return ref ? resolveTaskWorkerId(ctx, appId, ref) : null;
}

function refuseEnded(task: TaskRow): void {
  if (ENDED.includes(task.status)) {
    throw taskError('TASK_ENDED', `This task is ${task.status}; an ended task never moves again.`, {
      taskId: task.id, status: task.status,
    });
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────

type CreateInput = {
  appRef?: string | null;
  parentTaskId?: string | null;
  title: string;
  priority?: number | null;
  blockedBy?: string[] | null;
  description?: string | null;
  source?: string | null;
  owner?: PartyInput;
  assignee?: PartyInput;
  requirements?: RequirementsInput | null;
  startBy?: unknown;
  tags?: string[] | null;
  closeSessionWhenDone?: boolean | null;
  status?: string | null;
  /** #2553: make a top-level PROJECT (AT1, AT2, ...) instead of a task under AT0. Not with a parentTaskId. */
  project?: boolean | null;
  /** #2420 (cor:agt:050:28): the task's own properties; left out, not refused, for a creator who may not write them. */
  properties?: unknown;
};

/**
 * The one place a new task row, its events and its queue entry are written (cor:agt:050:03, :11), for a task made
 * by a person, a worker's session or a headless run. The caller has authorized and resolved the parties.
 */
async function insertTask(
  tx: Prisma.TransactionClient,
  a: {
    app: TaskApp; parentId: string | null; title: string; description: string | null; source: string | null;
    tags: string[]; startBy: Date | null; closeSessionWhenDone: boolean; priority?: number;
    requirements: Prisma.InputJsonObject | null; owner: TaskParty; assignee: TaskParty | null;
    /** #2420: already normalized and schema-checked by the caller, which also decided the creator may set it. */
    properties?: Prisma.InputJsonObject | null;
    created: Record<string, unknown>; assigned: Record<string, unknown>; evActor: EventActor;
    /** #1754: a backlog task is parked, never queued (cor:agt:050:02). Default pending. */
    status?: 'backlog' | 'pending';
    /** #2553: make a top-level PROJECT (numbered from the App's project counter) instead of a child of AT0. */
    project?: boolean;
  },
): Promise<{ id: string; queued: boolean }> {
  // #2022 (cor:agt:090:03): a stop signal refuses making a covered worker the assignee, at creation too.
  if (a.assignee?.workerId) await refuseStoppedAssignee(tx, a.app.id, a.assignee.workerId, new Date());
  // #2553: the handle. A task with no project is a child of the App's reserved AT0 (`project` makes a top-level
  // project instead); its number comes from its PARENT's counter row (the project counter for a project), not the App
  // row (which stays a SHARED authority anchor) and not the parent task row (a read, since handles are immutable).
  // LOCK ORDER: the counter row is taken after the anchors, the stop fence, the graph and worker locks and the
  // caller's parent-task lock, immediately before the insert, and nothing is locked after it. The upsert is atomic, so
  // two creates never read the same value. A rolled-back create rolls the counter back too, so only committed numbers
  // are ever spent.
  let parentId = a.parentId;
  if (!parentId && !a.project) {
    parentId = await ensureProjectZero(tx, a.app.id, a.owner);
    if (!parentId) throw taskError('TASK_PROJECT_ZERO_MISSING', 'This App has no "No project" project yet and none could be made for it.');
  }
  let parentHandle: string | null = null;
  if (parentId) {
    parentHandle = (await tx.agentTask.findUnique({ where: { id: parentId }, select: { handle: true } }))?.handle ?? null;
    if (parentHandle && handleDepth(parentHandle) >= MAX_HANDLE_DEPTH) {
      throw taskError('TASK_TOO_DEEP', `Tasks nest at most ${MAX_HANDLE_DEPTH} levels deep, counting the project; create this task under a shallower parent.`, { taskId: parentId });
    }
  }
  const [counter] = parentId
    ? await tx.$queryRaw<Array<{ last_number: bigint }>>`
        INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), ${a.app.id}, ${parentId}, 1)
        ON CONFLICT (app_id, parent_task_id) DO UPDATE SET last_number = agent_task_counters.last_number + 1
        RETURNING last_number`
    : await tx.$queryRaw<Array<{ last_number: bigint }>>`
        INSERT INTO agent_task_counters (id, app_id, parent_task_id, last_number)
        VALUES (replace(gen_random_uuid()::text, '-', ''), ${a.app.id}, NULL, 1)
        ON CONFLICT (app_id) WHERE parent_task_id IS NULL DO UPDATE SET last_number = agent_task_counters.last_number + 1
        RETURNING last_number`;
  // cor:urn:010:01 (Vera, #40303): a handle is a URN leaf of at most 64 characters, so a create whose handle would be
  // longer is refused like a too-deep one. Nothing is written: this transaction rolls back, counter increment included.
  const handle = composeTaskHandle(parentHandle, counter!.last_number);
  if (handle.length > MAX_HANDLE_LENGTH) {
    throw taskError('TASK_TOO_DEEP', `A task handle is at most ${MAX_HANDLE_LENGTH} characters; create this task under a shallower parent.`, { taskId: parentId });
  }
  const created = await tx.agentTask.create({
    data: {
      appId: a.app.id,
      taskNumber: counter!.last_number,
      handle,
      title: a.title, description: a.description, source: a.source, tags: a.tags, startBy: a.startBy,
      closeSessionWhenDone: a.closeSessionWhenDone,
      priority: a.priority ?? 1,
      status: a.status ?? 'pending',
      parentTaskId: parentId,
      requirements: a.requirements ?? Prisma.DbNull,
      properties: a.properties ?? Prisma.DbNull,
      ...partyColumns('owner', a.owner),
      ...partyColumns('assignee', a.assignee),
      ...(a.assignee ? a.assigned : {}),
      ...a.created,
    },
    select: { id: true },
  });
  await appendTaskEvent(tx, {
    appId: a.app.id, taskId: created.id, actor: a.evActor,
    // The owner rides the event (#1757): a named owner is visible to the
    // event stream — and so to the alarm chain — from creation.
    event: { type: 'task.created', parentTaskId: a.parentId, owner: a.owner, hasAssignee: a.assignee !== null },
  });
  if (a.properties) {
    await appendTaskEvent(tx, {
      appId: a.app.id, taskId: created.id, actor: a.evActor,
      event: { type: 'task.properties-changed', from: null, to: propertiesFingerprint(a.properties) },
    });
  }
  if (a.assignee) {
    await appendTaskEvent(tx, {
      appId: a.app.id, taskId: created.id, actor: a.evActor,
      event: { type: 'task.assigned', assignee: a.assignee, closeSessionWhenDone: a.closeSessionWhenDone },
    });
  } else if ((a.status ?? 'pending') === 'pending') {
    // #1707: the task enters the queue (cor:agt:050:03, :11). A backlog task
    // never does — it is parked (#1754, cor:agt:050:02).
    await appendTaskEvent(tx, { appId: a.app.id, taskId: created.id, actor: a.evActor, event: { type: 'assignment.queued' } });
  }
  return { id: created.id, queued: a.assignee === null && (a.status ?? 'pending') === 'pending' };
}

/**
 * #1756 (cor:agt:050:06, Holger team chat #7799): a headless run creates a root task in its OWN App, attributed to
 * the run. Roots only; the run is recorded as creator (no person, worker or agent is credited); the owner is named,
 * or defaults to the person the run acts for, and must participate like any owner (a run is never a party itself).
 * Judged under the App's authority anchors with the run row held, so a run that finished, an App that was
 * uninstalled or deleted, or a participant who left cannot be written around.
 */
export async function createRootTaskForRun(
  principal: Context,
  run: { id: string; appId: string },
  input: Omit<CreateInput, 'parentTaskId' | 'status'> & { parentTaskId?: unknown; status?: never },
) {
  // #1832: a run's root task is created pending (queued unless an assignee is named); a status is refused, never silently dropped. The type is `never` so a typed caller cannot pass one; an untyped one (the run tool) is caught here.
  if (input.status != null) throw badInput('A run-created task takes no status; it is created pending.');
  if (input.parentTaskId != null && input.parentTaskId !== '') throw badInput('A run creates root tasks only; it names no parentTaskId.');
  if (input.appRef) {
    let namedAppId: string | null = null;
    try {
      namedAppId = (await resolveAppRef(principal.db, input.appRef)).id;
    } catch (e) {
      if (!(e instanceof AppNotFoundError)) throw e;
    }
    // Another App, or none: the same answer as a missing one.
    if (namedAppId !== run.appId) throw appNotFound(input.appRef);
  }
  const app = await loadApp(principal, run.appId);
  if (!app || app.deletedAt) throw appNotFound(run.appId);
  const title = normalizeTitle(input.title);
  const description = optionalText(input.description, TASK_DESCRIPTION_MAX, 'description');
  const source = optionalText(input.source, TASK_SOURCE_MAX, 'source');
  const tags = normalizeTags(input.tags);
  const startBy = parseStartBy(input.startBy);
  const closeSessionWhenDone = input.closeSessionWhenDone ?? false;
  const now = new Date();
  const evActor: EventActor = { userId: null, workerId: null, agentId: null, runId: run.id };
  const lockedAssignee = await partyWorkerForLock(principal, app.id, input.assignee);
  const made = await inTaskWriteTx(principal, app, { kind: 'run', runId: run.id }, () => appNotFound(run.appId), async (tx, txCtx, fresh) => {
    const requirements = await normalizeRequirements(txCtx, fresh, input.requirements);
    let owner: TaskParty;
    if (input.owner) owner = await resolveParty(txCtx, fresh, input.owner, 'TASK_OWNER_INVALID');
    else if (principal.userId) owner = await resolveParty(txCtx, fresh, { user: principal.userId }, 'TASK_OWNER_INVALID');
    else throw taskError('TASK_OWNER_REQUIRED', 'A run that acts for no person names the task\'s owner: a worker of the App or a person who participates in it.');
    const assignee = input.assignee ? await resolveParty(txCtx, fresh, input.assignee, 'TASK_ASSIGNEE_INVALID') : null;
    if (assignee?.workerId && assignee.workerId !== lockedAssignee) {
      throw taskError('TASK_CONFLICT', 'The assignee named changed while this write waited; try again.');
    }
    // #2162 (cor:agt:050:27 §4): never onto a worker that is resetting.
    await refuseResettingAssignee(tx, fresh.id, assignee?.workerId);
    return insertTask(tx, {
      app: fresh, parentId: null, title, description, source, tags, startBy, closeSessionWhenDone, requirements, owner, assignee,
      created: { createdBy: null, createdByWorkerId: null, createdByAgentId: null, createdByRunId: run.id, updatedBy: null, updatedByWorkerId: null, updatedByAgentId: null },
      assigned: { assignedAt: now, assignedBy: null, assignedByWorkerId: null, assignedByAgentId: null },
      evActor,
    });
  }, { lockWorkerIds: [lockedAssignee] });
  if (made.queued) await matchAfterChange(principal.db, app.id);
  return principal.db.agentTask.findUniqueOrThrow({ where: { id: made.id } });
}

/** #2644: priority/blockers use exactly the existing assigner set, never the assignee alone. */
async function requireTaskDirection(tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor, task: TaskRow) {
  if (!(await mayDirectTask(tx, txCtx, app, actor, task))) throw taskError('TASK_NOT_OWNER', 'Only whoever may assign this task sets its priority or blockers.', { taskId: task.id });
}
/** Unknown, unreadable and cross-App blocker refs have the same concealed answer. */
async function blockerRef(ctx: Context, appId: string, ref: string): Promise<string> {
  const id = await resolveTaskRef(ctx, ref, appId);
  const row = id ? await ctx.db.agentTask.findUnique({ where: { id }, select: { appId: true, handle: true } }) : null;
  if (!row || row.appId !== appId) throw notFound(ref);
  return id!;
}
function requireBlockerState(task: TaskRow) {
  if (task.status !== 'backlog' && task.status !== 'pending') throw taskError('TASK_INVALID_TRANSITION', 'Blockers change only on backlog or pending tasks.', { taskId: task.id });
}

/**
 * #2644 / cor:agt:050:01: the in-transaction priority door, also for #2645.
 * Caller must enter inTaskWriteTx and lock the task before calling; this
 * function owns the value, authority, lifecycle, write and event together.
 */
export async function setTaskPriorityInTx(tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor, task: TaskRow, value: number) {
  const priority = taskPriority(value);
  await requireTaskDirection(tx, txCtx, app, actor, task);
  refuseEnded(task);
  await tx.agentTask.update({ where: { id: task.id }, data: { priority, ...updatedStamp(txCtx) } });
  await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(txCtx.userId), event: { type: 'task.priority', priority } });
}
/**
 * #2644 / cor:agt:050:02: the in-transaction link door, also for #2645.
 * Enter inTaskWriteTx with taskGraph: 'exclusive', BEFORE locking the task.
 * Never upgrade a shared graph lock after taking a task row. Never open a nested
 * transaction from an edit; post-commit matching is the outer caller's job.
 */
export async function changeTaskBlockerInTx(tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor, task: TaskRow, ref: string, operation: 'add' | 'remove') {
  await requireTaskDirection(tx, txCtx, app, actor, task);
  requireBlockerState(task);
  const id = await blockerRef(txCtx, app.id, ref);
  const existed = await tx.agentTaskBlocker.count({ where: { taskId: task.id, blockerTaskId: id } });
  if (operation === 'add') await addTaskBlocker(tx, task.id, id);
  else await removeTaskBlocker(tx, task.id, id);
  if ((operation === 'add' && !existed) || (operation === 'remove' && existed)) {
    await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(txCtx.userId),
      event: { type: operation === 'add' ? 'task.blocker-added' : 'task.blocker-removed', blockerTaskId: id } });
  }
}

export const agentTaskMutations = {
  /** #2645: Proposed cor:agt:050:09 Editing. The assignment gate and transaction are the only write door. */
  updateAgentTask: async (_: unknown, { taskId, input }: { taskId: string; input: Record<string, unknown> }, ctx: Context) =>
    mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      // #2420 (cor:agt:050:28): the task's assignee may write its `properties` and nothing else; a patch that names
      // any other field needs the cor:agt:050:09 set, and is refused whole.
      const named = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
      const assigneeWritesProperties = named.length > 0 && named.every(k => k === 'properties') && isAssignee(actor, task);
      if (!assigneeWritesProperties && !(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, edits it; its assignee may write only its properties.", { taskId });
      }
      refuseEnded(task);
      if (!input || typeof input !== 'object' || Array.isArray(input) || named.some(k => k !== 'properties' && !(TASK_EDIT_FIELDS as readonly string[]).includes(k))) {
        throw badInput('Name only editable task fields; source and lifecycle fields are fixed.');
      }
      const data: Prisma.AgentTaskUpdateInput = {};
      const fields: TaskEditField[] = [];
      // #2420: omitted leaves the value, an object replaces the whole of it, null clears it (and skips the schema).
      let propertiesChange: { from: PropertiesFingerprint | null; to: PropertiesFingerprint | null } | null = null;
      if (input.properties !== undefined) {
        const next = input.properties === null ? null : normalizeTaskProperties(input.properties);
        if (next !== null) await checkAgainstTeamSchema(tx, txCtx, app.id, next);
        if (!isDeepStrictEqual(task.properties, next)) {
          Object.assign(data, { properties: next === null ? Prisma.DbNull : next });
          propertiesChange = {
            from: task.properties === null ? null : propertiesFingerprint(task.properties),
            to: next === null ? null : propertiesFingerprint(next),
          };
        }
      }
      for (const field of TASK_EDIT_FIELDS) {
        if (!Object.hasOwn(input, field)) continue;
        let value: unknown;
        switch (field) {
          case 'title': value = normalizeTitle(input.title as string); break;
          case 'description': value = optionalText(input.description as string | null, TASK_DESCRIPTION_MAX, 'description'); break;
          case 'tags': value = normalizeTags(input.tags as string[] | null); break;
          case 'requirements': value = await normalizeRequirements(txCtx, app, input.requirements as RequirementsInput | null); break;
          case 'startBy': value = input.startBy === '' ? null : parseStartBy(input.startBy); break;
          case 'closeSessionWhenDone':
            if (input.closeSessionWhenDone != null && typeof input.closeSessionWhenDone !== 'boolean') throw badInput('closeSessionWhenDone must be a boolean.');
            value = input.closeSessionWhenDone ?? false; break;
        }
        if (isDeepStrictEqual(task[field], value)) continue;
        fields.push(field);
        Object.assign(data, { [field]: field === 'requirements' && value === null ? Prisma.DbNull : value });
      }
      if (fields.length === 0 && !propertiesChange) return;
      // The episode identity is a deciding time after all authority/task waits, not transaction-start now().
      const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
      await tx.agentTask.update({ where: { id: task.id }, data: { ...data, ...updatedStamp(ctx) } });
      if (fields.length > 0) {
        await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.edited', fields }, createdAt: at });
      }
      if (propertiesChange) {
        await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.properties-changed', ...propertiesChange }, createdAt: at });
      }
    }),
  setAgentTaskPriority: async (_: unknown, { taskRef: taskId, priority }: { taskRef: string; priority: number }, ctx: Context) => {
    const value = taskPriority(priority);
    const task = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      await setTaskPriorityInTx(tx, txCtx, app, actor, task, value);
    });
    await matchAfterChange(ctx.db, task.appId);
    return ctx.db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  },
  addAgentTaskBlocker: async (_: unknown, { taskRef: taskId, blockerTaskRef: blockerTaskId }: { taskRef: string; blockerTaskRef: string }, ctx: Context) => {
    const task = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      await changeTaskBlockerInTx(tx, txCtx, app, actor, task, blockerTaskId, 'add');
    }, { taskGraph: 'exclusive' });
    return ctx.db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  },
  removeAgentTaskBlocker: async (_: unknown, { taskRef: taskId, blockerTaskRef: blockerTaskId }: { taskRef: string; blockerTaskRef: string }, ctx: Context) => {
    const task = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      await changeTaskBlockerInTx(tx, txCtx, app, actor, task, blockerTaskId, 'remove');
    }, { taskGraph: 'exclusive' });
    await matchAfterChange(ctx.db, task.appId);
    return ctx.db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  },
  /**
   * Create a task (cor:agt:050:06 root, :07 child). A root task: any App
   * participant; its owner defaults to the creator, and the creator may name
   * any other participating worker or person as owner (cor:agt:050:01, Holger
   * team chat #8183; #1757). A child task: only the parent's assignee, who
   * owns it, and naming another owner is refused TASK_CHILD_OWNER_MISMATCH;
   * not under an ended parent (TASK_ENDED, 050:07 open question; #1705
   * interim).
   */
  createAgentTask: async (_: unknown, { input }: { input: CreateInput }, ctx: Context, info?: GraphQLResolveInfo) => {
    if (!input) throw badInput('input is required.');
    let parentId = input.parentTaskId?.trim() || null;
    if (input.project && parentId) throw badInput('A project is a top-level task: it takes no parentTaskId.');
    // #2553: the parent's canonical id once it resolves (a handle is an alias); `parentId` stays the caller's spelling for echoes.
    let parentTaskId: string | null = null;
    let app: TaskApp;
    let actor: TaskActor;
    if (parentId) {
      const readable = await loadReadableTask(ctx, parentId);
      if (!readable) throw notFound(parentId);
      ({ app, actor } = readable);
      parentTaskId = readable.task.id;
      // #2553: AT0 is the implicit parent of a task with no project, never a parent a caller names: a plain create takes
      // the ROOT gate and owner rules (this input names no parent), so naming AT0 would reach the child gate instead.
      if (readable.task.handle === PROJECT_ZERO_HANDLE) throw badInput('AT0 is the reserved "No project" project: omit parentTaskId to make a task with no project.');
      // A parent in another App reads as not-found: no cross-App oracle (#1705).
      if (input.appRef) {
        let namedAppId: string | null = null;
        try {
          namedAppId = (await resolveAppRef(ctx.db, input.appRef)).id;
        } catch (e) {
          if (!(e instanceof AppNotFoundError)) throw e;
        }
        if (namedAppId !== app.id) throw notFound(input.parentTaskId!.trim());
      }
    } else {
      if (!input.appRef) throw badInput('Name the App for a root task (or a parentTaskId for a child task).');
      ({ app, actor } = await resolveParticipatedApp(ctx, input.appRef));
    }
    requireWritable(ctx, app);

    const priority = taskPriority(input.priority);
    const title = normalizeTitle(input.title);
    const description = optionalText(input.description, TASK_DESCRIPTION_MAX, 'description');
    const source = optionalText(input.source, TASK_SOURCE_MAX, 'source');
    const tags = normalizeTags(input.tags);
    const startBy = parseStartBy(input.startBy);
    const closeSessionWhenDone = input.closeSessionWhenDone ?? false;
    // #1754: backlog or pending — and a backlog task carries no assignee.
    const status = normalizeCreateStatus(input.status);
    if (status === 'backlog' && input.assignee) {
      throw badInput('A backlog task has no assignee (cor:agt:050:02). Make it ready, then assign it.');
    }
    const now = new Date();
    const evActor = eventActor(ctx.userId);

    /**
     * The inputs that name OTHER entities (owner, assignee, excluded
     * workers). Resolved only after the caller is authorized — for a child
     * task, under the parent's row lock — so a caller who may not create here
     * learns nothing from which of them would be refused.
     */
    const resolveParties = async (tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp) => {
      const requirements = await normalizeRequirements(txCtx, app, input.requirements);
      let owner: TaskParty = actorParty(actor);
      if (input.owner) {
        // #1757 (cor:agt:050:01, Holger team chat #8183): a root task's
        // creator — any participant, worker or person — may name its owner,
        // so long as the named party participates in the App too. A ref that
        // names nobody, a non-participant or another App's worker is
        // TASK_OWNER_INVALID — the same refusal either way. A child task's
        // owner is its parent's assignee, so naming anybody but yourself is
        // TASK_CHILD_OWNER_MISMATCH, valid ref or not (no oracle).
        let named: TaskParty | null = null;
        try {
          named = await resolveParty(txCtx, app, input.owner, 'TASK_OWNER_INVALID');
        } catch (e) {
          if (!parentId || !(e instanceof GraphQLError && e.extensions?.code === 'TASK_OWNER_INVALID')) throw e;
        }
        if (!named || !sameParty(named, owner)) {
          if (parentId) {
            throw taskError('TASK_CHILD_OWNER_MISMATCH', "A child task is owned by the parent's assignee who creates it; it cannot name another owner.");
          }
          owner = named as TaskParty;
        }
      }
      const assignee = input.assignee ? await resolveParty(txCtx, app, input.assignee, 'TASK_ASSIGNEE_INVALID') : null;
      // #2420 (cor:agt:050:28): a creator sets properties only when it is one of their writers for THIS new task (its
      // owner, someone above the owner, a manager, or the assignee it names); any other creator gets the task made
      // without them, never a refusal, and the value is not even judged (nothing to learn from its validation).
      let properties: Prisma.InputJsonObject | null = null;
      if (input.properties !== undefined && input.properties !== null
        && await mayWriteProperties(tx, txCtx, app, actor, {
          ownerWorkerId: owner.workerId ?? null, ownerUserId: owner.userId ?? null,
          assigneeWorkerId: assignee?.workerId ?? null, assigneeUserId: assignee?.userId ?? null,
        })) {
        properties = normalizeTaskProperties(input.properties);
        await checkAgainstTeamSchema(tx, txCtx, app.id, properties);
      }
      return { requirements, owner, assignee, properties };
    };

    const refused = parentId ? () => notFound(parentId) : input.appRef ? () => appNotFound(input.appRef as string) : () => notFound(input.parentTaskId!.trim());
    // #2198: advice decided inside the write transaction, filed after it commits.
    const warn: TaskWarningCode[] = source === null ? ['task.create.no-source'] : [];
    // #2162: a task created straight onto a worker takes that worker's per-worker lock, before any row.
    const lockedAssignee = await partyWorkerForLock(ctx, app.id, input.assignee);
    const made = await inTaskWriteTx(ctx, app, actor, refused, async (tx, txCtx, app) => {
      if (parentId) {
        // Lock the parent so its assignee and status can't move under us,
        // then authorize against the locked row — the one assignee check.
        const parent = await lockTask(tx, parentTaskId!);
        if (!parent || parent.appId !== app.id) throw notFound(parentId);
        if (!isAssignee(actor, parent)) {
          throw taskError('TASK_NOT_ASSIGNEE', "Only the parent task's assignee creates its child tasks.", { taskId: parentId });
        }
        refuseEnded(parent);
      }
      const { requirements, owner, assignee, properties } = await resolveParties(tx, txCtx, app);
      if (assignee?.workerId && assignee.workerId !== lockedAssignee) {
        throw taskError('TASK_CONFLICT', 'The assignee named changed while this write waited; try again.');
      }
      await refuseResettingAssignee(tx, app.id, assignee?.workerId);
      await assigneeAdvice(tx, app.id, assignee, null, warn);
      const made = await insertTask(tx, {
        app, parentId: parentTaskId, project: input.project === true, title, description, source, tags, startBy, closeSessionWhenDone, requirements, properties, owner, assignee, status, priority,
        created: createdStamp(ctx), assigned: assignedStamp(ctx, now), evActor,
      });
      const row = await tx.agentTask.findUniqueOrThrow({ where: { id: made.id } });
      if (input.priority !== undefined || input.blockedBy !== undefined) {
        await requireTaskDirection(tx, txCtx, app, actor, row);
      }
      for (const ref of [...new Set(input.blockedBy ?? [])]) {
        await changeTaskBlockerInTx(tx, txCtx, app, actor, row, ref, 'add');
      }
      return made;
    }, { lockWorkerIds: [lockedAssignee], taskGraph: input.blockedBy?.length ? 'exclusive' : 'shared' });
    // #1707 (cor:agt:060:06): a queued task is matched now, after its create
    // committed; the returned task shows the assignee when one was free.
    if (made.queued) await matchAfterChange(ctx.db, app.id);
    const created = await ctx.db.agentTask.findUniqueOrThrow({ where: { id: made.id } });
    // #1709 (cor:agt:070:08): created straight onto a worker, it may start that worker.
    await launchAssignee(ctx.db, created);
    await emitTaskWarnings(ctx, info, created.appId, { codes: warn, taskId: created.id });
    return created;
  },

  /**
   * Assign a task with no assignee — a queued task (pending) or a BACKLOG task
   * (cor:agt:050:09): the owner, whoever manages the App, or a worker the
   * owner reports to. Assigning a BACKLOG task moves it to pending
   * (cor:agt:050:02, #1754), writing `task.ready` beside `task.assigned`. A
   * task that already has an assignee is moved with `reassignAgentTask` instead.
   */
  assignAgentTask: async (
    _: unknown,
    { taskId, assignee, closeSessionWhenDone }: { taskId: string; assignee: NonNullable<PartyInput>; closeSessionWhenDone?: boolean | null },
    ctx: Context,
    info?: GraphQLResolveInfo,
  ) => {
    let party: TaskParty | null = null;
    const warn: TaskWarningCode[] = [];
    const assigned = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx, locked) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, assigns it.", { taskId });
      }
      refuseEnded(task);
      if (assigneeOf(task)) {
        throw taskError('TASK_INVALID_TRANSITION', 'This task already has an assignee; reassign it instead.', { taskId });
      }
      party ??= await resolveParty(txCtx, app, assignee, 'TASK_ASSIGNEE_INVALID');
      if (party.workerId && !locked.has(party.workerId)) {
        party = null;
        throw new AssigneeMoved();
      }
      await refuseResettingAssignee(tx, app.id, party.workerId);
      // #2022 (cor:agt:090:03): never to a worker a live stop signal covers.
      if (party.workerId) await refuseStoppedAssignee(tx, app.id, party.workerId, new Date(), task.id);
      await assigneeAdvice(tx, app.id, party, task.id, warn);
      const close = closeSessionWhenDone ?? task.closeSessionWhenDone;
      // #1754 (cor:agt:050:02): assigning a backlog task makes it ready work.
      // The write is a guarded updateMany on the consumed state (no assignee,
      // and the status the snapshot decided from) — the same discipline as the
      // matcher's assignment — so a state that moved under the write matches
      // no row and refuses typed instead of surfacing a CHECK violation.
      const fromBacklog = task.status === 'backlog';
      const n = await tx.agentTask.updateMany({
        where: {
          id: task.id, appId: app.id, assigneeWorkerId: null, assigneeUserId: null,
          status: fromBacklog ? 'backlog' : 'pending',
        },
        data: {
          ...partyColumns('assignee', party),
          ...(fromBacklog ? { status: 'pending' as const } : {}),
          closeSessionWhenDone: close, ...assignedStamp(ctx, new Date()), ...updatedStamp(ctx),
        },
      });
      if (n.count === 0) {
        throw taskError('TASK_INVALID_TRANSITION', 'This task already has an assignee; reassign it instead.', { taskId });
      }
      const evActor = eventActor(ctx.userId);
      if (fromBacklog) {
        // The uniform left-the-backlog signal (#1790 review, Emerson P3-1):
        // make-ready writes task.ready, and so does assigning a backlog task.
        await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: evActor, event: { type: 'task.ready' } });
      }
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: evActor,
        event: { type: 'task.assigned', assignee: party, closeSessionWhenDone: close },
      });
    }, { workers: async (appId) => [await partyWorkerForLock(ctx, appId, assignee)] });
    // #1709 (cor:agt:070:08): an assignment by hand starts a held worker with no live session through its host.
    await launchAssignee(ctx.db, assigned);
    await emitTaskWarnings(ctx, info, assigned.appId, { codes: warn, taskId: assigned.id });
    return assigned;
  },

  /**
   * Park a queued task in the backlog (#1754, cor:agt:050:02): pending with no
   * assignee becomes BACKLOG — unassigned, never matched, never waited on, no
   * alarms. Whoever may assign a task may park it (cor:agt:050:09).
   */
  parkAgentTask: async (_: unknown, { taskId }: { taskId: string }, ctx: Context) =>
    mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, parks it in the backlog.", { taskId });
      }
      refuseEnded(task);
      if (task.status !== 'pending') {
        throw taskError('TASK_INVALID_TRANSITION', 'Only a pending task can be parked in the backlog.', { taskId, status: task.status });
      }
      if (assigneeOf(task)) {
        throw taskError('TASK_INVALID_TRANSITION', 'A backlog task has no assignee; this one is assigned (cor:agt:050:02).', { taskId });
      }
      // A guarded updateMany on the consumed state (#1790 review, Xylon P2-1):
      // the task row is locked (lockTask), and the write re-asserts what it
      // consumes, so a state that moved anyway matches no row and refuses
      // typed rather than surfacing a CHECK violation.
      const n = await tx.agentTask.updateMany({
        where: { id: task.id, appId: app.id, status: 'pending', assigneeWorkerId: null, assigneeUserId: null },
        data: { status: 'backlog', ...updatedStamp(ctx) },
      });
      if (n.count === 0) {
        throw taskError('TASK_INVALID_TRANSITION', 'Only a pending task with no assignee can be parked in the backlog.', { taskId });
      }
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.parked' },
      });
    }),

  /**
   * Make a backlog task ready to be worked (#1754, cor:agt:050:02): BACKLOG
   * becomes pending and the task enters the queue. Whoever may assign a task
   * may make it ready (cor:agt:050:09).
   */
  makeAgentTaskReady: async (_: unknown, { taskId }: { taskId: string }, ctx: Context) => {
    const ready = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, makes a backlog task ready.", { taskId });
      }
      refuseEnded(task);
      if (task.status !== 'backlog') {
        throw taskError('TASK_INVALID_TRANSITION', 'Only a backlog task is made ready to be worked.', { taskId, status: task.status });
      }
      // A guarded updateMany on the consumed state (#1790 review, Xylon P2-1):
      // two concurrent make-ready calls cannot both append task.ready and
      // assignment.queued — the loser's update matches no row and refuses
      // typed, so the append-only stream never takes a duplicate pair.
      const n = await tx.agentTask.updateMany({
        where: { id: task.id, appId: app.id, status: 'backlog' },
        data: { status: 'pending', ...updatedStamp(ctx) },
      });
      if (n.count === 0) {
        throw taskError('TASK_INVALID_TRANSITION', 'Only a backlog task is made ready to be worked.', { taskId });
      }
      const evActor = eventActor(ctx.userId);
      await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: evActor, event: { type: 'task.ready' } });
      // #1707: it enters the queue now, exactly like a task created ready —
      // and this event is the stall rule's queue-entry stamp for the new stint
      // (cor:agt:050:17; the unassignable episode starts here, not at creation).
      await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: evActor, event: { type: 'assignment.queued' } });
    });
    // #1707 (cor:agt:060:06): a free worker may take it right away.
    await matchAfterChange(ctx.db, ready.appId);
    return ready;
  },

  /**
   * Move a task to a different assignee (cor:agt:050:09): its owner (ruled,
   * D-2026-10-07-004), or whoever manages the App (Proposed). A started task
   * stays started (050:02). The former assignee can no longer move it (050:08).
   */
  reassignAgentTask: async (
    _: unknown,
    { taskId, assignee, closeSessionWhenDone }: { taskId: string; assignee: NonNullable<PartyInput>; closeSessionWhenDone?: boolean | null },
    ctx: Context,
    info?: GraphQLResolveInfo,
  ) => {
    let party: TaskParty | null = null;
    const warn: TaskWarningCode[] = [];
    const reassigned = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx, locked) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, reassigns it.", { taskId });
      }
      refuseEnded(task);
      const from = assigneeOf(task);
      if (!from) {
        throw taskError('TASK_INVALID_TRANSITION', 'This task has no assignee yet; assign it instead.', { taskId });
      }
      party ??= await resolveParty(txCtx, app, assignee, 'TASK_ASSIGNEE_INVALID');
      if (party.workerId && !locked.has(party.workerId)) {
        party = null;
        throw new AssigneeMoved();
      }
      if (sameParty(from, party)) {
        throw taskError('TASK_INVALID_TRANSITION', 'The task is already assigned there.', { taskId });
      }
      // #2022 (cor:agt:090:03): never to a worker a live stop signal covers; moving it away is not refused.
      if (party.workerId) await refuseStoppedAssignee(tx, app.id, party.workerId, new Date(), task.id);
      await refuseResettingAssignee(tx, app.id, party.workerId);
      await assigneeAdvice(tx, app.id, party, task.id, warn);
      const close = closeSessionWhenDone ?? task.closeSessionWhenDone;
      await tx.agentTask.update({
        where: { id: task.id },
        data: { ...partyColumns('assignee', party), closeSessionWhenDone: close, ...assignedStamp(ctx, new Date()), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId),
        event: { type: 'task.reassigned', from, to: party, closeSessionWhenDone: close },
      });
    }, { assignee: true, workers: async (appId) => [await partyWorkerForLock(ctx, appId, assignee)] });
    await launchAssignee(ctx.db, reassigned);
    await emitTaskWarnings(ctx, info, reassigned.appId, { codes: warn, taskId: reassigned.id });
    return reassigned;
  },

  /**
   * Start a task: the assignee only (cor:agt:050:08). Explicit start only —
   * 050:02's inferred start is an open question (#1705 interim).
   */
  startAgentTask: async (_: unknown, { taskId }: { taskId: string }, ctx: Context) =>
    mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!isAssignee(actor, task)) {
        throw taskError('TASK_NOT_ASSIGNEE', "Only the task's assignee starts it.", { taskId });
      }
      refuseEnded(task);
      if (task.status !== 'pending') {
        throw taskError('TASK_INVALID_TRANSITION', 'This task has already started.', { taskId, status: task.status });
      }
      if (task.blocked) throw taskError('TASK_BLOCKED', 'This task has an open blocker.', { taskId });
      // #2162: unreachable while the claim requires no open task, and asserted here as a guard, not a path.
      await refuseResettingAssignee(tx, app.id, task.assigneeWorkerId);
      await tx.agentTask.update({
        where: { id: task.id },
        data: { status: 'started', startedAt: new Date(), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.started' } });
    }, { assignee: true }),

  /** Record progress on a started task: the assignee only (cor:agt:050:08). Carries no text (050:11). */
  recordAgentTaskProgress: async (_: unknown, { taskId }: { taskId: string }, ctx: Context) =>
    mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!isAssignee(actor, task)) {
        throw taskError('TASK_NOT_ASSIGNEE', "Only the task's assignee records progress on it.", { taskId });
      }
      refuseEnded(task);
      if (task.status !== 'started') {
        throw taskError('TASK_INVALID_TRANSITION', 'Start the task before recording progress.', { taskId, status: task.status });
      }
      await tx.agentTask.update({ where: { id: task.id }, data: { ...updatedStamp(ctx) } });
      await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.progress' } });
    }),

  /**
   * Finish a started task with its result: the assignee only (cor:agt:050:08).
   * Finishing without starting is refused (050:02 Proposed; #1705 interim).
   * #1709: with `closeSessionWhenDone`, the assignee is asked to end its session
   * (cor:agt:050:10, src/lib/hostOperations/sessionEnd.ts).
   */
  finishAgentTask: async (
    _: unknown,
    { taskId, result }: { taskId: string; result: { outcome: string; summary?: string | null; evidence?: string | null } },
    ctx: Context,
    info?: GraphQLResolveInfo,
  ) => {
    const outcome = (result?.outcome ?? '').trim();
    if (!TASK_OUTCOME_PATTERN.test(outcome)) {
      throw badInput('outcome is one word (letters, digits, "_", "-" or "."; up to 64 characters), e.g. succeeded or failed.');
    }
    const summary = optionalText(result?.summary, TASK_SUMMARY_MAX, 'summary');
    const evidence = optionalText(result?.evidence, TASK_EVIDENCE_MAX, 'evidence');
    const warn: TaskWarningCode[] = [];
    const finished = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!isAssignee(actor, task)) {
        throw taskError('TASK_NOT_ASSIGNEE', "Only the task's assignee finishes it and sets its result.", { taskId });
      }
      refuseEnded(task);
      if (task.status !== 'started') {
        throw taskError('TASK_INVALID_TRANSITION', 'Start the task before finishing it.', { taskId, status: task.status });
      }
      // #2198: finishing with open children still succeeds (as it always has); the response says so.
      if ((await tx.agentTask.count({ where: { parentTaskId: task.id, status: { in: OPEN } } })) > 0) warn.push('task.finish.open-children');
      await tx.agentTask.update({
        where: { id: task.id },
        data: {
          status: 'finished', finishedAt: new Date(),
          resultOutcome: outcome, resultSummary: summary, resultEvidence: evidence,
          ...updatedStamp(ctx),
        },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.finished', outcome },
      });
      // #1709 (cor:agt:050:10): ask the assignee to end its session when the task says so.
      const ending = await requestSessionEnd(tx, { appId: app.id, task, actor: eventActor(ctx.userId), now: new Date() });
      // #2162 (cor:agt:050:27): or reset its context, when its Agent asks for that and no session end was asked (R119).
      await requestContextResetSafely(tx, {
        appId: app.id, task, wasStarted: true, sessionEndRequested: ending !== null, actor: eventActor(ctx.userId), now: new Date(),
      });
    }, { assignee: true });
    // #1707: a worker may have freed up (cor:agt:060:06).
    await matchAfterChange(ctx.db, finished.appId);
    await emitTaskWarnings(ctx, info, finished.appId, { codes: warn, taskId: finished.id });
    return finished;
  },

  /**
   * Cancel a pending, started or backlog task: its owner, or whoever manages
   * the App (cor:agt:050:09, Proposed; backlog directly, Holger team chat #8150).
   */
  cancelAgentTask: async (_: unknown, { taskId }: { taskId: string }, ctx: Context, info?: GraphQLResolveInfo) => {
    const warn: TaskWarningCode[] = [];
    const cancelled = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, cancels it.", { taskId });
      }
      refuseEnded(task);
      const openChildCount = await tx.agentTask.count({ where: { parentTaskId: task.id, status: { in: OPEN } } });
      // #2607: cancelling with open children still succeeds; it does not end them, and the response says so.
      if (openChildCount > 0) warn.push('task.cancel.open-children');
      await tx.agentTask.update({
        where: { id: task.id },
        data: { status: 'cancelled', cancelledAt: new Date(), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId),
        event: { type: 'task.cancelled', fromStatus: task.status as 'backlog' | 'pending' | 'started', openChildCount },
      });
      // #1709 (cor:agt:050:10): cancelling asks the assignee to end its session too.
      const ending = await requestSessionEnd(tx, { appId: app.id, task, actor: eventActor(ctx.userId), now: new Date() });
      // #2162 (cor:agt:050:27, R117): a started-then-cancelled task resets too; one never started requests none.
      await requestContextResetSafely(tx, {
        appId: app.id, task, wasStarted: task.status === 'started', sessionEndRequested: ending !== null,
        actor: eventActor(ctx.userId), now: new Date(),
      });
    }, { assignee: true });
    // #1707: a worker may have freed up (cor:agt:060:06).
    await matchAfterChange(ctx.db, cancelled.appId);
    await emitTaskWarnings(ctx, info, cancelled.appId, { codes: warn, taskId: cancelled.id });
    return cancelled;
  },
};

/**
 * #2198: the advice an assignment earns, read in the write transaction: `unavailable`, `busy` and `paused` are pushed
 * onto `warn` (the privacy gate is applied after commit). Nothing for a user assignee, no assignee, or the caller
 * itself (a worker taking work for itself is not advised about its own state).
 */
async function assigneeAdvice(
  tx: Prisma.TransactionClient,
  appId: string,
  assignee: TaskParty | null,
  excludeTaskId: string | null,
  warn: TaskWarningCode[],
): Promise<void> {
  const workerId = assignee?.workerId ?? null;
  if (!workerId || workerId === currentActor().workerId) return;
  const facts = await readAssigneeFacts(tx, { appId, workerId, excludeTaskId, now: new Date() });
  if (facts.unavailable) warn.push('task.assign.assignee-unavailable');
  if (facts.busy) warn.push('task.assign.assignee-busy');
  if (facts.paused) warn.push('task.assign.assignee-paused');
}

/**
 * #1709 (cor:agt:070:08; Holger via Vera #10773 (6): assignment by hand launches too, not only matching). After the
 * assignment committed: if its assignee is a worker, ask the platform to start it through its host. Never fails the
 * assignment; a worker it cannot start leaves the task waiting.
 */
async function launchAssignee(db: Context['db'], t: TaskRow): Promise<void> {
  if (!t.assigneeWorkerId || !['pending', 'started'].includes(t.status)) return;
  await launchForAssignment(db as PrismaClient, { appId: t.appId, taskId: t.id, workerId: t.assigneeWorkerId });
}

// ── Queries ───────────────────────────────────────────────────────────────

type ListArgs = {
  appRef: string;
  status?: string[] | null;
  owner?: PartyInput;
  assignee?: PartyInput;
  creator?: PartyInput;
  tag?: string | null;
  tagsAny?: string[] | null;
  tagsAll?: string[] | null;
  source?: string | null;
  text?: string | null;
  overdue?: boolean | null;
  createdAfter?: unknown;
  createdBefore?: unknown;
  startedAfter?: unknown;
  startedBefore?: unknown;
  finishedAfter?: unknown;
  finishedBefore?: unknown;
  parentTaskId?: string | null;
  rootsOnly?: boolean | null;
  queued?: boolean | null;
  limit?: number | null;
  offset?: number | null;
};

const STATUS_FROM_GQL: Record<string, TaskStatus> = {
  BACKLOG: 'backlog', PENDING: 'pending', STARTED: 'started', FINISHED: 'finished', CANCELLED: 'cancelled',
};

/** A party filter: names a party of the App, or matches nothing (never refuses — a filter, not a write). */
async function partyFilter(ctx: Context, app: TaskApp, input: PartyInput, prefix: 'owner' | 'assignee' | 'creator') {
  if (!input) return {};
  try {
    const p = await resolveParty(ctx, app, input, 'TASK_ASSIGNEE_INVALID');
    return partyColumns(prefix, p);
  } catch (e) {
    if (e instanceof GraphQLError && e.extensions?.code === 'TASK_ASSIGNEE_INVALID') return { id: { in: [] as string[] } };
    throw e;
  }
}

export const agentTaskQueries = {
  /** One task, or null when it does not exist or the caller may not read it (cor:agt:050:21). */
  agentTask: async (_: unknown, { id }: { id: string }, ctx: Context) => {
    return withReadableTask(ctx, id, async (_c, { task }) => task);
  },

  /** An App's tasks, newest first, for its participants and the App's own key (cor:agt:050:21, #1755). */
  agentTasks: async (_: unknown, args: ListArgs, ctx: Context) =>
    withReadableApp(ctx, args.appRef, async (c, app) => {
    // Narrow only after the existing App read gate. All filters run in SQL before paging.
    const filters: Prisma.AgentTaskWhereInput[] = [];
    for (const [name, tags] of [['tagsAny', args.tagsAny], ['tagsAll', args.tagsAll]] as const) {
      // #2696: the bounds a task's own tags obey, so the read and write limits cannot drift.
      if (tags && tags.length > TASK_TAGS_MAX) throw badInput(`${name} takes at most ${TASK_TAGS_MAX} tags.`);
      if (tags?.some((t) => t.length > TASK_TAG_MAX)) throw badInput(`A ${name} tag is longer than ${TASK_TAG_MAX} characters.`);
    }
    if (args.tagsAny?.length) filters.push({ tags: { hasSome: args.tagsAny } });
    if (args.tagsAll?.length) filters.push({ tags: { hasEvery: args.tagsAll } });
    if (args.source != null) filters.push({ source: args.source });
    if (args.text != null) {
      // #2664: a case-insensitive substring over title and description. Trimmed, 1..TASK_TEXT_FILTER_MAX; the refusal
      // is fixed text (never the pattern) and comes after the App read gate, like the tag bounds above. Prisma's
      // `contains` does NOT escape LIKE wildcards, so %, _ and \ are escaped here and match literally.
      const text = args.text.trim();
      if (text.length < 1 || text.length > TASK_TEXT_FILTER_MAX) throw badInput(`text must be 1 to ${TASK_TEXT_FILTER_MAX} characters after trimming.`);
      const like = text.replace(/[\\%_]/g, '\\$&');
      filters.push({ OR: [
        { title: { contains: like, mode: 'insensitive' } },
        { description: { contains: like, mode: 'insensitive' } },
      ] });
    }
    for (const [prefix, field] of [['created', 'createdAt'], ['started', 'startedAt'], ['finished', 'finishedAt']] as const) {
      const range: { gte?: Date; lte?: Date } = {};
      for (const [suffix, op] of [['After', 'gte'], ['Before', 'lte']] as const) {
        const value = args[`${prefix}${suffix}`];
        if (value == null) continue;
        if (!(value instanceof Date) && !taskListDateTime.safeParse(value).success) {
          throw badInput(`${prefix}${suffix} must be an ISO date-time with a timezone offset.`);
        }
        const date = value instanceof Date ? value : new Date(value as string);
        if (!Number.isFinite(date.getTime())) throw badInput(`${prefix}${suffix} is not a valid date-time.`);
        range[op] = date;
      }
      if (range.gte && range.lte && range.gte > range.lte) throw badInput(`${prefix}After must not be later than ${prefix}Before.`);
      if (range.gte || range.lte) filters.push({ [field]: range });
    }
    if (args.overdue != null) {
      // Match the millisecond precision exposed by DateTime, using the database clock.
      const [{ now }] = await c.db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP) AS now`;
      const late: Prisma.AgentTaskWhereInput = {
        status: 'pending', startBy: { lt: now }, startedAt: null, finishedAt: null, cancelledAt: null,
      };
      // SQL NOT over a nullable startBy alone would also discard tasks with no deadline.
      filters.push(args.overdue ? late : { OR: [{ startBy: null }, { NOT: late }] });
    }
    const statuses = args.status?.map((s) => STATUS_FROM_GQL[s] ?? s);
    const where: Prisma.AgentTaskWhereInput = {
      appId: app.id,
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      ...(args.tag ? { tags: { has: args.tag } } : {}),
      ...(args.parentTaskId ? { parentTaskId: (await resolveTaskRef(c, args.parentTaskId, app.id)) ?? args.parentTaskId } : {}),
      ...(args.queued ? { status: 'pending', assigneeWorkerId: null, assigneeUserId: null } : {}),
    };
    // #2553: AT0 is the platform's bookkeeping row, not a task anyone works: a LIST never shows it (it still reads by
    // id or handle, and `parentTaskId: AT0` lists the tasks that have no project). `rootsOnly` keeps meaning "the top
    // of the tree a person sees": the projects and the tasks with no project (children of AT0), never AT0 itself.
    const noZero: Prisma.AgentTaskWhereInput = { handle: { not: PROJECT_ZERO_HANDLE } };
    const rootsWhere: Prisma.AgentTaskWhereInput = args.rootsOnly
      ? rootTaskWhere()
      : {};
    const ownerWhere = await partyFilter(c, app, args.owner, 'owner');
    const assigneeWhere = await partyFilter(c, app, args.assignee, 'assignee');
    const creatorWhere = await partyFilter(c, app, args.creator, 'creator');
    return c.db.agentTask.findMany({
      where: { AND: [where, noZero, rootsWhere, ownerWhere, assigneeWhere, creatorWhere, ...filters] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: clampListTake(args.limit),
      skip: Math.max(0, args.offset ?? 0),
    });
    }),

  /**
   * A task and every task below it, root first then by creation. Null when the
   * root is missing or unreadable. Bounded at TASK_TREE_MAX rows.
   */
  agentTaskTree: async (_: unknown, { root }: { root: string }, ctx: Context) =>
    withReadableTask(ctx, root, async (c, readable) => {
    // #2553: AT0 is the reserved "no project" bucket, never a tree root; its children are the roots (rootTaskWhere).
    if (readable.task.handle === PROJECT_ZERO_HANDLE) return null;
    const rows = await c.db.$queryRaw<{ id: string; depth: number }[]>`
      WITH RECURSIVE tree AS (
        SELECT id, 0 AS depth FROM agent_tasks WHERE id = ${readable.task.id}
        UNION ALL
        SELECT t.id, tree.depth + 1 FROM agent_tasks t
        JOIN tree ON t.parent_task_id = tree.id
        WHERE t.app_id = ${readable.app.id} AND tree.depth < 64
      )
      SELECT id, depth FROM tree LIMIT ${TASK_TREE_MAX}`;
    const tasks = await c.db.agentTask.findMany({
      where: { id: { in: rows.map((r) => r.id) }, appId: readable.app.id },
    });
    const depth = new Map(rows.map((r) => [r.id, r.depth]));
    return tasks.sort((a, b) =>
      (depth.get(a.id)! - depth.get(b.id)!) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    }),

  /**
   * An App's team event stream (cor:agt:050:11, :21), in (createdAt, id)
   * order. Continue a page with `after`: the id of the last event read. The
   * cursor is the PAIR, so rows sharing a timestamp — the task.created and
   * task.assigned one transaction writes, or a capped page cutting a larger
   * equal-time group — are never skipped (#1713 review, Diego P2-B). `since`
   * stays a coarse time filter, not a continuation.
   */
  agentTeamEvents: async (
    _: unknown,
    args: { appRef: string; since?: unknown; after?: string | null; types?: string[] | null; alarmsOnly?: boolean | null; taskId?: string | null; limit?: number | null },
    ctx: Context,
  ) => withReadableApp(ctx, args.appRef, async (c, app) => {
    const since = args.since == null ? null : parseStartBy(args.since);
    let afterWhere: Prisma.AgentTeamEventWhereInput = {};
    if (args.after) {
      // Scoped to this App: another App's event id is just an unknown cursor.
      const cursor = isId(args.after)
        ? await c.db.agentTeamEvent.findFirst({
            where: { id: args.after, appId: app.id },
            select: { id: true, createdAt: true },
          })
        : null;
      if (!cursor) throw badInput('after is not an event of this App. Pass the id of the last event you read.');
      afterWhere = {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      };
    }
    return c.db.agentTeamEvent.findMany({
      where: {
        appId: app.id,
        ...afterWhere,
        ...(since ? { createdAt: { gt: since } } : {}),
        ...(args.types?.length ? { type: { in: args.types } } : {}),
        ...(args.alarmsOnly ? { severity: 'alarm' } : {}),
        ...(args.taskId ? { taskId: (await resolveTaskRef(c, args.taskId, app.id)) ?? args.taskId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: clampListTake(args.limit),
    });
  }),
};

// ── Field resolvers ───────────────────────────────────────────────────────

export type PartyView = { kind: 'WORKER' | 'USER'; id: string; name: string | null; urn: string | null };

/** A sanitized party projection — never the User object (#552: no other tenant's identity fields). */
export async function partyView(ctx: Context, workerId: string | null, userId: string | null): Promise<PartyView | null> {
  if (workerId) {
    const w = await ctx.db.worker.findUnique({
      where: { id: workerId },
      select: { id: true, name: true, slug: true, app: { select: { urn: true } } },
    });
    if (!w) return { kind: 'WORKER', id: workerId, name: null, urn: null };
    return { kind: 'WORKER', id: w.id, name: w.name, urn: composeWorkerUrn(w.app.urn, w.slug) };
  }
  if (userId) {
    const u = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, handle: true } });
    return { kind: 'USER', id: userId, name: u?.handle ?? null, urn: null };
  }
  return null;
}

type RelationDirection = 'blockedBy' | 'blocks';
type RelationPage = { items: TaskRow[]; total: number; hasMore: boolean };
type RelationRequest = {
  id: string;
  direction: RelationDirection;
  take: number;
  skip: number;
  settle: (page: RelationPage) => void;
  fail: (error: unknown) => void;
};

/**
 * #2764: the relation requests one request's field resolvers raised in the current tick. Keyed by the Context OBJECT
 * (a WeakMap, not a field): a copy made for another caller or transaction (`{ ...ctx, userId }`) never inherits the
 * original's queue, so a batch holds one caller's requests only. Nothing here outlives its flush: the queue is
 * removed before the flush starts and no result is kept, so a later read always reaches the database.
 */
const relationQueues = new WeakMap<Context, RelationRequest[]>();

/**
 * #2644 / #2764: bounded same-App dependency reads, batched per request. GraphQL starts every list item's field
 * resolver in one synchronous pass, so the requests raised in that pass are served together by
 * {@link flushTaskRelations}: a 200-row list costs a fixed number of queries, not two per row.
 */
function taskRelations(ctx: Context, id: string, direction: RelationDirection, args: { limit?: number | null; offset?: number | null }): Promise<RelationPage> {
  const { take, skip } = pageArgs(args);
  return new Promise((settle, fail) => {
    let queue = relationQueues.get(ctx);
    if (!queue) {
      const fresh: RelationRequest[] = (queue = []);
      relationQueues.set(ctx, fresh);
      queueMicrotask(() => {
        relationQueues.delete(ctx);
        void flushTaskRelations(ctx, fresh);
      });
    }
    queue.push({ id, direction, take, skip, settle, fail });
  });
}

/** A caller with no readable parent gets exactly the page a missing task gets. */
const emptyRelationPage = (skip: number): RelationPage => pageEnvelope([] as TaskRow[], 0, skip);

async function flushTaskRelations(ctx: Context, requests: RelationRequest[]): Promise<void> {
  try {
    const taskIds = [...new Set(requests.map((r) => r.id))];
    const parents = await readableRelationParents(ctx, taskIds, requests);
    for (const r of requests) r.settle(parents.get(r) ?? emptyRelationPage(r.skip));
  } catch (e) {
    for (const r of requests) r.fail(e);
  }
}

/**
 * The relation page of every REQUESTED parent the caller may read, by the SAME gate the per-task read used: a
 * participant of the parent's App (decided once per distinct App, since the actor depends on the App alone), or the
 * App's own key inside ONE transaction holding the App's shared anchors. A parent that is missing or unreadable is
 * absent from the map, and the caller answers it with the empty page.
 */
async function readableRelationParents(ctx: Context, taskIds: string[], requests: RelationRequest[]): Promise<Map<RelationRequest, RelationPage>> {
  const key = appKeyCaller(ctx);
  const heads = await ctx.db.agentTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, appId: true } });
  if (!key) {
    const readableApps = new Set<string>();
    await Promise.all(
      [...new Set(heads.map((h) => h.appId))].map(async (appId) => {
        const app = await loadApp(ctx, appId);
        if (app && (await resolveTaskActor(ctx, app))) readableApps.add(appId);
      }),
    );
    return relationPages(ctx.db, heads.filter((h) => readableApps.has(h.appId)), requests);
  }
  const own = heads.filter((h) => h.appId === key.appId);
  if (!own.length) return new Map();
  const pages = await inKeyReadTx<Map<RelationRequest, RelationPage> | null>(ctx, key.appId, () => null, async (txCtx, app) => {
    const rows = await txCtx.db.agentTask.findMany({ where: { id: { in: own.map((h) => h.id) }, appId: app.id }, select: { id: true, appId: true } });
    return relationPages(txCtx.db, rows, requests);
  });
  return pages ?? new Map();
}

/**
 * Count and page every (parent, direction, take, skip) in a fixed number of statements. The related task is the
 * parent's blocker (`blockedBy`) or dependent (`blocks`), in the parent's own App, ordered by id; the window numbers
 * each parent's rows so a page is exactly `offset .. offset+limit` of ITS OWN list.
 */
async function relationPages(
  db: Context['db'],
  parents: Array<{ id: string; appId: string }>,
  requests: RelationRequest[],
): Promise<Map<RelationRequest, RelationPage>> {
  const known = new Set(parents.map((p) => p.id));
  const mine = requests.filter((r) => known.has(r.id));
  const out = new Map<RelationRequest, RelationPage>();
  if (!mine.length) return out;
  const totals = new Map<string, number>(); // `${direction}:${parent}` -> total
  const related = new Map<string, TaskRow>();
  const relatedIds = new Map<string, string[]>(); // `${direction}:${take}:${skip}:${parent}` -> related ids, in order
  for (const direction of ['blockedBy', 'blocks'] as const) {
    const ofDirection = mine.filter((r) => r.direction === direction);
    if (!ofDirection.length) continue;
    const parentIds = [...new Set(ofDirection.map((r) => r.id))];
    const counts = direction === 'blockedBy'
      ? await db.$queryRaw<Array<{ parent: string; n: number }>>`
          SELECT l.task_id AS parent, count(*)::int AS n FROM agent_task_blockers l
          JOIN agent_tasks p ON p.id = l.task_id JOIN agent_tasks r ON r.id = l.blocker_task_id AND r.app_id = p.app_id
          WHERE l.task_id IN (${Prisma.join(parentIds)}) GROUP BY l.task_id`
      : await db.$queryRaw<Array<{ parent: string; n: number }>>`
          SELECT l.blocker_task_id AS parent, count(*)::int AS n FROM agent_task_blockers l
          JOIN agent_tasks p ON p.id = l.blocker_task_id JOIN agent_tasks r ON r.id = l.task_id AND r.app_id = p.app_id
          WHERE l.blocker_task_id IN (${Prisma.join(parentIds)}) GROUP BY l.blocker_task_id`;
    for (const c of counts) totals.set(`${direction}:${c.parent}`, c.n);
    // One windowed read per distinct page shape (limit, offset); every parent that asked for it shares the statement.
    const shapes = new Map<string, { take: number; skip: number; parentIds: string[] }>();
    for (const r of ofDirection) {
      if (r.take === 0 || !totals.get(`${direction}:${r.id}`)) continue;
      const s = shapes.get(`${r.take}:${r.skip}`) ?? { take: r.take, skip: r.skip, parentIds: [] };
      if (!s.parentIds.includes(r.id)) s.parentIds.push(r.id);
      shapes.set(`${r.take}:${r.skip}`, s);
    }
    for (const s of shapes.values()) {
      const upper = s.skip + s.take;
      const rows = direction === 'blockedBy'
        ? await db.$queryRaw<Array<{ parent: string; related: string }>>`
            SELECT parent, related FROM (
              SELECT l.task_id AS parent, l.blocker_task_id AS related,
                     row_number() OVER (PARTITION BY l.task_id ORDER BY l.blocker_task_id) AS rn
              FROM agent_task_blockers l
              JOIN agent_tasks p ON p.id = l.task_id JOIN agent_tasks r ON r.id = l.blocker_task_id AND r.app_id = p.app_id
              WHERE l.task_id IN (${Prisma.join(s.parentIds)})) w
            WHERE rn > ${s.skip} AND rn <= ${upper} ORDER BY parent, related`
        : await db.$queryRaw<Array<{ parent: string; related: string }>>`
            SELECT parent, related FROM (
              SELECT l.blocker_task_id AS parent, l.task_id AS related,
                     row_number() OVER (PARTITION BY l.blocker_task_id ORDER BY l.task_id) AS rn
              FROM agent_task_blockers l
              JOIN agent_tasks p ON p.id = l.blocker_task_id JOIN agent_tasks r ON r.id = l.task_id AND r.app_id = p.app_id
              WHERE l.blocker_task_id IN (${Prisma.join(s.parentIds)})) w
            WHERE rn > ${s.skip} AND rn <= ${upper} ORDER BY parent, related`;
      for (const row of rows) {
        const k = `${direction}:${s.take}:${s.skip}:${row.parent}`;
        const list = relatedIds.get(k) ?? [];
        list.push(row.related);
        relatedIds.set(k, list);
      }
    }
  }
  const wanted = [...new Set([...relatedIds.values()].flat())];
  if (wanted.length) for (const t of await db.agentTask.findMany({ where: { id: { in: wanted } } })) related.set(t.id, t);
  for (const r of mine) {
    const items = (relatedIds.get(`${r.direction}:${r.take}:${r.skip}:${r.id}`) ?? []).map((id) => related.get(id)).filter((t): t is TaskRow => !!t);
    out.set(r, pageEnvelope(items, totals.get(`${r.direction}:${r.id}`) ?? 0, r.skip));
  }
  return out;
}

export const agentTaskFieldResolvers = {
  AgentTask: {
    blockedBy: async (task: TaskRow, args: { limit?: number | null; offset?: number | null }, ctx: Context) => taskRelations(ctx, task.id, 'blockedBy', args),
    blocks: async (task: TaskRow, args: { limit?: number | null; offset?: number | null }, ctx: Context) => taskRelations(ctx, task.id, 'blocks', args),
    /** #2553: the per-App handle. Never null in the database; the column is optional only in the client type. */
    handle: (t: TaskRow) => t.handle!,
    taskNumber: (t: TaskRow) => String(t.taskNumber),
    status: (t: TaskRow) => t.status.toUpperCase(),
    owner: (t: TaskRow, _: unknown, ctx: Context) => partyView(ctx, t.ownerWorkerId, t.ownerUserId),
    assignee: (t: TaskRow, _: unknown, ctx: Context) => partyView(ctx, t.assigneeWorkerId, t.assigneeUserId),
    result: (t: TaskRow) =>
      t.status === 'finished' && t.resultOutcome
        ? { outcome: t.resultOutcome, summary: t.resultSummary, evidence: t.resultEvidence }
        : null,
    requirements: (t: TaskRow) => {
      const r = (t.requirements ?? null) as Record<string, unknown> | null;
      if (!r) return null;
      return {
        role: (r.role as string) ?? null,
        familyIn: (r.familyIn as string[]) ?? null,
        familyNotIn: (r.familyNotIn as string[]) ?? null,
        excludeWorkerIds: (r.excludeWorkerIds as string[]) ?? null,
        minTier: (r.minTier as string) ?? null,
        modelGroupIn: (r.modelGroupIn as string[]) ?? null,
        modelGroupNotIn: (r.modelGroupNotIn as string[]) ?? null,
      };
    },
    /** #1709 (cor:agt:050:10) — the request this task's end made; the task was already read, so its readers read it. */
    sessionEndRequest: async (t: TaskRow, _: unknown, ctx: Context) => {
      const r = await ctx.db.taskSessionEndRequest.findUnique({ where: { taskId: t.id } });
      return r ? { ...r, resolution: r.resolution ? r.resolution.toUpperCase().replace(/-/g, '_') : null } : null;
    },
    /** cor:agt:050:03 — pending with no assignee. Derived, never stored. */
    queued: (t: TaskRow) => t.status === 'pending' && !t.assigneeWorkerId && !t.assigneeUserId,
    /** cor:agt:050:04 — started with at least one open child. Derived, never stored. */
    waitingOnChildren: async (t: TaskRow, _: unknown, ctx: Context) => {
      if (t.status !== 'started') return false;
      const open = await ctx.db.agentTask.findFirst({
        where: { parentTaskId: t.id, status: { in: OPEN } },
        select: { id: true },
      });
      return open !== null;
    },
    createdBy: (t: TaskRow, _: unknown, ctx: Context) => partyView(ctx, t.createdByWorkerId, t.createdByWorkerId ? null : t.createdBy),
    assignedBy: (t: TaskRow, _: unknown, ctx: Context) =>
      t.assignedAt ? partyView(ctx, t.assignedByWorkerId, t.assignedByWorkerId ? null : t.assignedBy) : null,
  },
  AgentTeamEvent: {
    // #2755: a dark-worker alarm's evidence is for a reader of the worker's internals; every other payload is as written.
    payload: async (e: { type: string; appId: string; payload: unknown }, _: unknown, ctx: Context) => {
      const { eventPayloadFor } = await import('../../../lib/agentTasks/darkWorker.js');
      return eventPayloadFor(e, ctx);
    },
    severity: (e: { severity: string | null }) => (e.severity === 'alarm' ? 'ALARM' : null),
    actor: (e: { actorWorkerId: string | null; actorUserId: string | null }, _: unknown, ctx: Context) =>
      partyView(ctx, e.actorWorkerId, e.actorWorkerId ? null : e.actorUserId),
    subjectWorker: (e: { subjectWorkerId: string | null }, _: unknown, ctx: Context) =>
      e.subjectWorkerId ? partyView(ctx, e.subjectWorkerId, null) : null,
    acknowledgedBy: (e: { acknowledgedByWorkerId: string | null; acknowledgedByUserId: string | null }, _: unknown, ctx: Context) =>
      partyView(ctx, e.acknowledgedByWorkerId, e.acknowledgedByWorkerId ? null : e.acknowledgedByUserId),
  },
};

/** The event types T1 writes — exported for the SDL description and tests. */
export const AGENT_TASK_EVENT_TYPES = TASK_EVENT_TYPES;
