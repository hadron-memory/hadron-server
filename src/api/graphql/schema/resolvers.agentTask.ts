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

import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, isAppParticipant, clampListTake, withoutRequestCaches } from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AppNotFoundError, WorkerNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { composeWorkerUrn, resolveWorkerRef as resolveWorkerRefId } from '../../../lib/entityRef/workerRef.js';
import { resolveWorkerIdByName } from './resolvers.worker.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { lockAppReportsTo } from '../../../lib/workerReportsTo.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { mayStillDriveWorkerApp } from '../../../lib/teamAttention.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { currentActor } from '../../../lib/requestActor.js';
import { appKeyCaller, refuseSessionBound } from '../../../lib/appKeyScopes/scopes.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import {
  appendTaskEvent,
  eventActor,
  TASK_EVENT_TYPES,
  type TaskParty,
} from '../../../lib/agentTasks/events.js';
import { matchAfterChange } from '../../../lib/agentTasks/matcher.js';

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

const STATUSES = ['pending', 'started', 'finished', 'cancelled'] as const;
type TaskStatus = (typeof STATUSES)[number];
const ENDED: readonly string[] = ['finished', 'cancelled'];
const OPEN: TaskStatus[] = ['pending', 'started'];

// ── Errors ────────────────────────────────────────────────────────────────

export function taskError(code: string, message: string, ext: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...ext } });
}
const notFound = (taskId: string): GraphQLError =>
  taskError('TASK_NOT_FOUND', 'Task not found.', { taskId });
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
    if (!(await keyMayReadApp(txCtx, app))) return onGone();
    return body(txCtx, app);
  });
}

/** Run a read over an App the caller may READ tasks and events of: a participant, or the App's own key. */
async function withReadableApp<T>(ctx: Context, appRef: string, body: (c: Context, app: TaskApp) => Promise<T>): Promise<T> {
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

/** Load a task the caller may read, with its App and the actor — or null (concealed as missing). */
async function loadReadableTask(
  ctx: Context,
  taskId: string,
): Promise<{ task: TaskRow; app: TaskApp; actor: TaskActor } | null> {
  if (typeof taskId !== 'string' || !isId(taskId)) return null;
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
  taskId: string,
  body: (c: Context, r: { task: TaskRow; app: TaskApp }) => Promise<T>,
): Promise<T | null> {
  const key = appKeyCaller(ctx);
  if (!key) {
    const readable = await loadReadableTask(ctx, taskId);
    return readable ? body(ctx, readable) : null;
  }
  if (typeof taskId !== 'string' || !isId(taskId)) return null;
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
const isOwner = (actor: TaskActor, t: TaskRow): boolean => actorIs(actor, t.ownerWorkerId, t.ownerUserId);
const isAssignee = (actor: TaskActor, t: TaskRow): boolean =>
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
async function actorCoordinatesOwner(tx: Prisma.TransactionClient, actor: TaskActor, task: TaskRow): Promise<boolean> {
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
async function mayDirectTask(tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor, task: TaskRow): Promise<boolean> {
  return isOwner(actor, task) || (await actorManagesApp(txCtx, app, actor)) || (await actorCoordinatesOwner(tx, actor, task));
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

function partyColumns(prefix: 'owner' | 'assignee', p: TaskParty | null) {
  return prefix === 'owner'
    ? { ownerWorkerId: p?.workerId ?? null, ownerUserId: p?.userId ?? null }
    : { assigneeWorkerId: p?.workerId ?? null, assigneeUserId: p?.userId ?? null };
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

type RequirementsInput = {
  role?: string | null;
  familyIn?: string[] | null;
  familyNotIn?: string[] | null;
  excludeWorkers?: string[] | null;
};

/** The matcher's requirements (plan §3.1). Stored for T3; validated here. */
async function normalizeRequirements(
  ctx: Context,
  app: TaskApp,
  input: RequirementsInput | null | undefined,
): Promise<Prisma.InputJsonObject | null> {
  if (!input) return null;
  const role = optionalText(input.role, 128, 'requirements.role');
  const list = (xs: string[] | null | undefined, field: string): string[] | null => {
    if (!xs) return null;
    const out = [...new Set(xs.map((x) => (x ?? '').trim()).filter((x) => x !== ''))];
    if (out.length > TASK_REQUIREMENT_LIST_MAX) throw badInput(`${field} has more than ${TASK_REQUIREMENT_LIST_MAX} entries.`);
    if (out.some((x) => x.length > 64)) throw badInput(`An entry of ${field} is longer than 64 characters.`);
    return out.length ? out : null;
  };
  const familyIn = list(input.familyIn, 'requirements.familyIn');
  const familyNotIn = list(input.familyNotIn, 'requirements.familyNotIn');
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
  const out: Prisma.InputJsonObject = {
    ...(role ? { role } : {}),
    ...(familyIn ? { familyIn } : {}),
    ...(familyNotIn ? { familyNotIn } : {}),
    ...(excludeWorkerIds ? { excludeWorkerIds } : {}),
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
  actor: TaskActor,
  refused: () => GraphQLError,
  write: (tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp) => Promise<T>,
  /** `exclusive` for a writer that UPDATEs the anchored App row itself: it cannot upgrade a shared hold without deadlocking its peers. */
  options: { lockMode?: 'shared' | 'exclusive' } = {},
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
        const again = await resolveTaskActor(txCtx, fresh);
        if (!again || !sameActor(again, actor)) throw new TaskGateRefused();
        requireWritable(txCtx, fresh);
      },
      (tx, txCtx) => write(tx, txCtx, fresh as TaskApp),
      {
        lockMode: options.lockMode,
        afterLock: async (tx) => {
          // #1726: the reportsTo graph, SHARED, before any membership or worker
          // row (src/lib/workerReportsTo.ts, the lock protocol). The chain arm
          // of cor:agt:050:09 then reads a graph no writer can change before
          // this commits.
          await lockAppReportsTo(tx, app.id, 'shared');
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
  taskId: string,
  act: (tx: Prisma.TransactionClient, task: TaskRow, actor: TaskActor, app: TaskApp, txCtx: Context) => Promise<void>,
): Promise<TaskRow> {
  const readable = await loadReadableTask(ctx, taskId);
  if (!readable) throw notFound(taskId);
  const { app, actor } = readable;
  requireWritable(ctx, app);
  await inTaskWriteTx(ctx, app, actor, () => notFound(taskId), async (tx, txCtx, freshApp) => {
    const task = await lockTask(tx, taskId);
    if (!task || task.appId !== freshApp.id) throw notFound(taskId);
    await act(tx, task, actor, freshApp, txCtx);
  });
  return ctx.db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
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
  description?: string | null;
  source?: string | null;
  owner?: PartyInput;
  assignee?: PartyInput;
  requirements?: RequirementsInput | null;
  startBy?: unknown;
  tags?: string[] | null;
  closeSessionWhenDone?: boolean | null;
};

export const agentTaskMutations = {
  /**
   * Create a task (cor:agt:050:06 root, :07 child). A root task: any App
   * participant; its owner defaults to the creator, and the creator may name
   * any other participating worker or person as owner (cor:agt:050:01, Holger
   * team chat #8183; #1757). A child task: only the parent's assignee, who
   * owns it, and naming another owner is refused TASK_CHILD_OWNER_MISMATCH;
   * not under an ended parent (TASK_ENDED, 050:07 open question; #1705
   * interim).
   */
  createAgentTask: async (_: unknown, { input }: { input: CreateInput }, ctx: Context) => {
    if (!input) throw badInput('input is required.');
    const parentId = input.parentTaskId?.trim() || null;
    let app: TaskApp;
    let actor: TaskActor;
    if (parentId) {
      const readable = await loadReadableTask(ctx, parentId);
      if (!readable) throw notFound(parentId);
      ({ app, actor } = readable);
      // A parent in another App reads as not-found: no cross-App oracle (#1705).
      if (input.appRef) {
        let namedAppId: string | null = null;
        try {
          namedAppId = (await resolveAppRef(ctx.db, input.appRef)).id;
        } catch (e) {
          if (!(e instanceof AppNotFoundError)) throw e;
        }
        if (namedAppId !== app.id) throw notFound(parentId);
      }
    } else {
      if (!input.appRef) throw badInput('Name the App for a root task (or a parentTaskId for a child task).');
      ({ app, actor } = await resolveParticipatedApp(ctx, input.appRef));
    }
    requireWritable(ctx, app);

    const title = normalizeTitle(input.title);
    const description = optionalText(input.description, TASK_DESCRIPTION_MAX, 'description');
    const source = optionalText(input.source, TASK_SOURCE_MAX, 'source');
    const tags = normalizeTags(input.tags);
    const startBy = parseStartBy(input.startBy);
    const closeSessionWhenDone = input.closeSessionWhenDone ?? true;
    const now = new Date();
    const evActor = eventActor(ctx.userId);

    /**
     * The inputs that name OTHER entities (owner, assignee, excluded
     * workers). Resolved only after the caller is authorized — for a child
     * task, under the parent's row lock — so a caller who may not create here
     * learns nothing from which of them would be refused.
     */
    const resolveParties = async (txCtx: Context, app: TaskApp) => {
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
      return { requirements, owner, assignee };
    };

    const refused = parentId ? () => notFound(parentId) : () => appNotFound(input.appRef as string);
    const made = await inTaskWriteTx(ctx, app, actor, refused, async (tx, txCtx, app) => {
      if (parentId) {
        // Lock the parent so its assignee and status can't move under us,
        // then authorize against the locked row — the one assignee check.
        const parent = await lockTask(tx, parentId);
        if (!parent || parent.appId !== app.id) throw notFound(parentId);
        if (!isAssignee(actor, parent)) {
          throw taskError('TASK_NOT_ASSIGNEE', "Only the parent task's assignee creates its child tasks.", { taskId: parentId });
        }
        refuseEnded(parent);
      }
      const { requirements, owner, assignee } = await resolveParties(txCtx, app);
      const created = await tx.agentTask.create({
        data: {
          appId: app.id,
          title, description, source, tags, startBy, closeSessionWhenDone,
          parentTaskId: parentId,
          requirements: requirements ?? Prisma.DbNull,
          ...partyColumns('owner', owner),
          ...partyColumns('assignee', assignee),
          ...(assignee ? assignedStamp(ctx, now) : {}),
          ...createdStamp(ctx),
        },
        select: { id: true },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: created.id, actor: evActor,
        // The owner rides the event (#1757): a named owner is visible to the
        // event stream — and so to the alarm chain — from creation.
        event: { type: 'task.created', parentTaskId: parentId, owner, hasAssignee: assignee !== null },
      });
      if (assignee) {
        await appendTaskEvent(tx, {
          appId: app.id, taskId: created.id, actor: evActor,
          event: { type: 'task.assigned', assignee, closeSessionWhenDone },
        });
      } else {
        // #1707: the task enters the queue (cor:agt:050:03, :11).
        await appendTaskEvent(tx, { appId: app.id, taskId: created.id, actor: evActor, event: { type: 'assignment.queued' } });
      }
      return { id: created.id, queued: assignee === null };
    });
    // #1707 (cor:agt:060:06): a queued task is matched now, after its create
    // committed; the returned task shows the assignee when one was free.
    if (made.queued) await matchAfterChange(ctx.db, app.id);
    return ctx.db.agentTask.findUniqueOrThrow({ where: { id: made.id } });
  },

  /**
   * Assign a queued task — pending, with no assignee (cor:agt:050:09). The
   * owner, or whoever manages the App. A task that already has an assignee is
   * moved with `reassignAgentTask` instead.
   */
  assignAgentTask: async (
    _: unknown,
    { taskId, assignee, closeSessionWhenDone }: { taskId: string; assignee: NonNullable<PartyInput>; closeSessionWhenDone?: boolean | null },
    ctx: Context,
  ) => {
    let party: TaskParty | null = null;
    return mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, assigns it.", { taskId });
      }
      refuseEnded(task);
      if (assigneeOf(task)) {
        throw taskError('TASK_INVALID_TRANSITION', 'This task already has an assignee; reassign it instead.', { taskId });
      }
      party ??= await resolveParty(txCtx, app, assignee, 'TASK_ASSIGNEE_INVALID');
      const close = closeSessionWhenDone ?? task.closeSessionWhenDone;
      await tx.agentTask.update({
        where: { id: task.id },
        data: { ...partyColumns('assignee', party), closeSessionWhenDone: close, ...assignedStamp(ctx, new Date()), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId),
        event: { type: 'task.assigned', assignee: party, closeSessionWhenDone: close },
      });
    });
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
  ) => {
    let party: TaskParty | null = null;
    return mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, reassigns it.", { taskId });
      }
      refuseEnded(task);
      const from = assigneeOf(task);
      if (!from) {
        throw taskError('TASK_INVALID_TRANSITION', 'This task has no assignee yet; assign it instead.', { taskId });
      }
      party ??= await resolveParty(txCtx, app, assignee, 'TASK_ASSIGNEE_INVALID');
      if (sameParty(from, party)) {
        throw taskError('TASK_INVALID_TRANSITION', 'The task is already assigned there.', { taskId });
      }
      const close = closeSessionWhenDone ?? task.closeSessionWhenDone;
      await tx.agentTask.update({
        where: { id: task.id },
        data: { ...partyColumns('assignee', party), closeSessionWhenDone: close, ...assignedStamp(ctx, new Date()), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId),
        event: { type: 'task.reassigned', from, to: party, closeSessionWhenDone: close },
      });
    });
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
      await tx.agentTask.update({
        where: { id: task.id },
        data: { status: 'started', startedAt: new Date(), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, { appId: app.id, taskId: task.id, actor: eventActor(ctx.userId), event: { type: 'task.started' } });
    }),

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
   * `closeSessionWhenDone` is stored, not acted on here — T6 carries out 050:10.
   */
  finishAgentTask: async (
    _: unknown,
    { taskId, result }: { taskId: string; result: { outcome: string; summary?: string | null; evidence?: string | null } },
    ctx: Context,
  ) => {
    const outcome = (result?.outcome ?? '').trim();
    if (!TASK_OUTCOME_PATTERN.test(outcome)) {
      throw badInput('outcome is one word (letters, digits, "_", "-" or "."; up to 64 characters), e.g. succeeded or failed.');
    }
    const summary = optionalText(result?.summary, TASK_SUMMARY_MAX, 'summary');
    const evidence = optionalText(result?.evidence, TASK_EVIDENCE_MAX, 'evidence');
    const finished = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!isAssignee(actor, task)) {
        throw taskError('TASK_NOT_ASSIGNEE', "Only the task's assignee finishes it and sets its result.", { taskId });
      }
      refuseEnded(task);
      if (task.status !== 'started') {
        throw taskError('TASK_INVALID_TRANSITION', 'Start the task before finishing it.', { taskId, status: task.status });
      }
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
    });
    // #1707: a worker may have freed up (cor:agt:060:06).
    await matchAfterChange(ctx.db, finished.appId);
    return finished;
  },

  /** Cancel a pending or started task: its owner, or whoever manages the App (cor:agt:050:09, Proposed). */
  cancelAgentTask: async (_: unknown, { taskId }: { taskId: string }, ctx: Context) => {
    const cancelled = await mutateTask(ctx, taskId, async (tx, task, actor, app, txCtx) => {
      if (!(await mayDirectTask(tx, txCtx, app, actor, task))) {
        throw taskError('TASK_NOT_OWNER', "Only the task's owner, a worker the owner reports to, or whoever manages the App, cancels it.", { taskId });
      }
      refuseEnded(task);
      const openChildCount = await tx.agentTask.count({ where: { parentTaskId: task.id, status: { in: OPEN } } });
      await tx.agentTask.update({
        where: { id: task.id },
        data: { status: 'cancelled', cancelledAt: new Date(), ...updatedStamp(ctx) },
      });
      await appendTaskEvent(tx, {
        appId: app.id, taskId: task.id, actor: eventActor(ctx.userId),
        event: { type: 'task.cancelled', fromStatus: task.status as 'pending' | 'started', openChildCount },
      });
    });
    // #1707: a worker may have freed up (cor:agt:060:06).
    await matchAfterChange(ctx.db, cancelled.appId);
    return cancelled;
  },
};

// ── Queries ───────────────────────────────────────────────────────────────

type ListArgs = {
  appRef: string;
  status?: string[] | null;
  owner?: PartyInput;
  assignee?: PartyInput;
  tag?: string | null;
  parentTaskId?: string | null;
  rootsOnly?: boolean | null;
  queued?: boolean | null;
  limit?: number | null;
  offset?: number | null;
};

const STATUS_FROM_GQL: Record<string, TaskStatus> = {
  PENDING: 'pending', STARTED: 'started', FINISHED: 'finished', CANCELLED: 'cancelled',
};

/** A party filter: names a party of the App, or matches nothing (never refuses — a filter, not a write). */
async function partyFilter(ctx: Context, app: TaskApp, input: PartyInput, prefix: 'owner' | 'assignee') {
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
    const statuses = args.status?.map((s) => STATUS_FROM_GQL[s] ?? s);
    const where: Prisma.AgentTaskWhereInput = {
      appId: app.id,
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      ...(args.tag ? { tags: { has: args.tag } } : {}),
      ...(args.parentTaskId ? { parentTaskId: args.parentTaskId } : {}),
      ...(args.rootsOnly ? { parentTaskId: null } : {}),
      ...(args.queued ? { status: 'pending', assigneeWorkerId: null, assigneeUserId: null } : {}),
    };
    const ownerWhere = await partyFilter(c, app, args.owner, 'owner');
    const assigneeWhere = await partyFilter(c, app, args.assignee, 'assignee');
    return c.db.agentTask.findMany({
      where: { AND: [where, ownerWhere, assigneeWhere] },
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
        ...(args.taskId ? { taskId: args.taskId } : {}),
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

export const agentTaskFieldResolvers = {
  AgentTask: {
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
      };
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
