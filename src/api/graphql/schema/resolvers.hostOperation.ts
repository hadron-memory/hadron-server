// Host operations — #1709 (Task Management T6, server half; plan design:agent-tasks §7.1).
//
// Two kinds of caller, never mixed:
//
// A HOST, through an App key holding `host:operate` bound to one host
// (cor:agt:070:04): `registerHost`, `collectHostOperations`,
// `reportHostOperation` and `setHostWorkerAvailability`. The host's identity
// comes from the key's scope row, never from the request: no host surface takes
// a host id. A key of another App, a key without the scope, a revoked scope or
// key, and a key bound to a session are refused, in that order, so what a key
// learns never depends on something it does not hold (the #1749 order). Each
// write re-checks the scope inside its transaction under the App's authority
// anchor (shared; the scope's, the key's and the App's revokers take it
// exclusively), and records the use in that same transaction (cor:agt:070:07).
// The host starts every exchange; the server never connects to a host.
//
// A PERSON OR A WORKER, issuing (cor:agt:070:05): `issueHostOperation`. The
// worktree operations: the worker's holder, the worker it reports to, or whoever
// manages the App. `worker.end` (slice 3): whoever manages the App, for an open
// session of the worker. `worker.start` ships with the launch grant (slice 2);
// `worker.deliver` waits for the router port's delivery path (hadron-cli#829).
// A task never issues a worktree operation (cor:agt:070:06): nothing on the task
// paths calls this. The platform's own `worker.end`, after a finished task's
// grace, is src/lib/hostOperations/sessionEnd.ts.

import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import {
  actorManagesApp,
  inTaskWriteTx,
  loadApp,
  requireWritable,
  resolveParticipatedApp,
  resolveTaskWorkerId,
  taskError,
  withReadableApp,
  type TaskActor,
  type TaskApp,
} from './resolvers.agentTask.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { appKeyCaller, refuseSessionBound } from '../../../lib/appKeyScopes/scopes.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { currentActor } from '../../../lib/requestActor.js';
import { generateId } from '../../../lib/id.js';
import { keyEverHeldHostOperate, keyHostId, recordHostKeyUse, recordHostKeyUseApart, type HostKey, type HostKeyAction } from '../../../lib/hostOperations/hostKey.js';
import {
  HOST_FAILURE_REASON_MAX,
  HostOperationArgsError,
  isHostToken,
  validateHostOperation,
  type HostOperationType,
} from '../../../lib/hostOperations/types.js';
import {
  HostRegistrationError,
  isRegistrationLive,
  registerHost,
  HOST_ID_PATTERN,
  HOST_LAPSE_CHECK_INS_DEFAULT,
} from '../../../lib/agentTasks/hosts.js';
import { appendAvailabilityEvent, appendHostOperationEvent, eventActor, PLATFORM_ACTOR } from '../../../lib/agentTasks/events.js';
import { recordInEffect } from '../../../lib/agentTasks/availability.js';
import { matchAfterChange } from '../../../lib/agentTasks/matcher.js';
import { fenceHostDecision, insertWorkerStart, LaunchRefusal, liveRegistrationsFor, lockStartableWorker, mintLaunchGrants } from '../../../lib/hostOperations/launch.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { sessionHasHandoff } from '../../../lib/hostOperations/settle.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { normalizeAvailability, type AvailabilityInput } from './resolvers.agentTaskAlarms.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { buildWorkerTerminal, validateTerminalBatch, type StoredWorkerTerminal, type TerminalReportInput } from '../../../lib/workerTerminal.js';
import { loadPendingReasons, type PendingReason } from '../../../lib/tickers/checkPending.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import {
  authorizeContextResetStop,
  cancelLiveReset,
  holdForStopLease,
  outstandingStopLease,
  claimContextReset,
  ContextResetError,
  onContextResetReported,
  registerContextResetRecovery,
  reportContextResetAgentStopped,
  reportContextResetRelaunched,
  reportContextResetRelaunchFailed,
  type ContextResetStep,
  type ResetHost,
} from '../../../lib/contextReset/contextReset.js';

const appNotFound = (appRef: string): GraphQLError => taskError('APP_NOT_FOUND', 'App not found.', { appRef });
const opNotFound = (id: string): GraphQLError => taskError('HOST_OPERATION_NOT_FOUND', 'Host operation not found.', { id });
const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);

/** At most this many operations per collection or page. */
const PAGE_MAX = 200;

/** The anchors every authority-revoking writer of an App takes exclusively (a scope, a key, the App itself). */
const appAnchors = (app: TaskApp): AuthorityAnchor[] => [
  { kind: 'app', id: app.id },
  ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
  ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
];

// ── The host's side: a host:operate key ───────────────────────────────────

const scopeRequired = (): GraphQLError =>
  taskError('APP_KEY_SCOPE_REQUIRED', 'This App key does not hold the host:operate scope. Whoever manages the App can grant it, for one host.');

/**
 * The host-key gate, outside any transaction (cor:agt:070:04): the caller is an App key; the App is the key's own (a
 * foreign App is "not found"); the key holds host:operate now; it carries no session. Returns the key as its host, and
 * the re-check to run inside the write's transaction under the App's anchor, where the host must still be the same one.
 */
export async function hostKeyEntry(ctx: Context, appRef: string): Promise<{ app: TaskApp; host: HostKey; authorize: (tx: Prisma.TransactionClient) => Promise<void> }> {
  const key = appKeyCaller(ctx);
  if (!key) {
    throw taskError('HOST_KEY_REQUIRED', "Only a host, with its App key's host:operate scope, does this.");
  }
  let app: TaskApp | null = null;
  try {
    const { id } = await resolveAppRef(ctx.db, appRef);
    app = id === key.appId ? await loadApp(ctx, id) : null;
  } catch {
    app = null;
  }
  if (!app || app.deletedAt || app.uninstalledAt) throw appNotFound(appRef);
  const hostId = await keyHostId(ctx.db, key);
  if (!hostId) throw scopeRequired();
  refuseSessionBound(ctx);
  if (currentActor().workerId) throw taskError('APP_KEY_SESSION_BOUND', 'A host key does not act as a worker. Send no session.');
  const host: HostKey = { ...key, hostId };
  const held = app;
  return {
    app: held,
    host,
    authorize: async (tx) => {
      await lockAuthorityAnchors(tx, appAnchors(held), 'shared');
      // The same host, still: a scope revoked, re-granted for another host, or a key revoked, while we waited, refuses.
      if ((await keyHostId(tx, key)) !== hostId) throw scopeRequired();
    },
  };
}

/** A host-key write: the gate, then one transaction holding the App's anchor shared, re-checked, with the use recorded by `body`. */
async function asHost<T>(
  ctx: Context,
  appRef: string,
  body: (tx: Prisma.TransactionClient, app: TaskApp, host: HostKey) => Promise<T>,
): Promise<T> {
  const { app, host, authorize } = await hostKeyEntry(ctx, appRef);
  return ctx.db.$transaction(async (tx) => {
    await authorize(tx);
    return body(tx, app, host);
  });
}

type RegisterHostInput = {
  appRef: string;
  label: string;
  pollIntervalSeconds: number;
  workers?: { worker: string; family: string; worktrees?: string[] | null }[] | null;
  /** #2162: the capability-gated operation types this host performs (cor:agt:070:01, Proposed). */
  capabilities?: string[] | null;
};

type HostOperationRow = Prisma.HostOperationGetPayload<Record<string, never>>;


/** A refusal's code, when it carries one the use record can hold. */
function refusalCode(e: unknown): string | null {
  const code = (e as { extensions?: { code?: unknown } } | null)?.extensions?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

/**
 * #1881 (cor:agt:070:07, Holger #10849): every host-key call is recorded, refusals included. A refused call made with
 * a key that is or was a host key records its use, with the refusal's code, in its own write after the refusal, so
 * rolling the refused call back cannot erase it. An accepted write records inside its own transaction, as before.
 */
export async function recordingRefusal<T>(ctx: Context, action: HostKeyAction, operationId: unknown, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const key = appKeyCaller(ctx);
    const code = refusalCode(e);
    if (key && code) {
      const opId = action === 'report' && typeof operationId === 'string' && isId(operationId) ? operationId : null;
      await recordHostKeyUseApart(ctx.db, key, action, { operationId: opId, refusedCode: code });
    }
    throw e;
  }
}

/** The pause sources that excuse a coordinator from the alarm verdict (cor:agt:100:02): its own pause, a stop, a team pause. */
const VERDICT_EXCUSES: ReadonlySet<PendingReason | null> = new Set<PendingReason | null>(['PAUSED', 'STOPPED', 'TEAM_PAUSED']);

/**
 * #2771 — the alarm verdict, computed from the rows just written and returned, never stored: the App's coordinators
 * (role `coordinator`, case-insensitive, not retired) that THIS host's registration lists and whose stored terminal is
 * `locked` or `dark`, leaving out a worker paused or stopped and a team paused or halted (`loadPendingReasons`, the
 * same sources the ticker uses). `noCoordinator` is App-wide and names no one. A coordinator registered on no reporting
 * host is in no verdict: that is the server-side alarm's (#2763), not this call's.
 */
async function terminalAlarmVerdict(
  tx: Prisma.TransactionClient,
  app: TaskApp,
  registrationId: string | null,
  now: Date,
): Promise<{ alarm: { worker: { id: string; urn: string }; status: string; reason: string | null }[]; noCoordinator: boolean }> {
  const coordinators = await tx.worker.findMany({
    where: { appId: app.id, retiredAt: null, role: { equals: 'coordinator', mode: 'insensitive' } },
    select: { id: true, slug: true, terminal: true },
    orderBy: { id: 'asc' },
  });
  if (!registrationId || coordinators.length === 0) return { alarm: [], noCoordinator: coordinators.length === 0 };
  const listed = new Set(
    (await tx.hostRegistrationWorker.findMany({ where: { registrationId, workerId: { in: coordinators.map((c) => c.id) } }, select: { workerId: true } })).map((l) => l.workerId),
  );
  const down = coordinators.filter((c) => listed.has(c.id) && ['locked', 'dark'].includes((c.terminal as StoredWorkerTerminal | null)?.status ?? ''));
  const pending = await loadPendingReasons(tx, app.id, down.map((c) => c.id), now);
  return {
    noCoordinator: false,
    alarm: down
      .filter((c) => {
        const reason = pending.get(c.id) ?? null;
        return !VERDICT_EXCUSES.has(reason);
      })
      .map((c) => {
        const t = c.terminal as unknown as StoredWorkerTerminal;
        return { worker: { id: c.id, urn: composeWorkerUrn(app.urn, c.slug) }, status: t.status, reason: t.reason };
      }),
  };
}

export const hostOperationMutations = {
  /**
   * cor:agt:070:01, :04 — a host registers, or refreshes, which of its App's workers it can launch, as which model
   * family, and in which existing worktrees. The host id is the key's; the request names none.
   */
  registerHost: async (_: unknown, { input }: { input: RegisterHostInput }, ctx: Context) => recordingRefusal(ctx, 'register', null, async () => {
    if (!input) throw badInput('input is required.');
    const { app, host, authorize } = await hostKeyEntry(ctx, input.appRef);
    const workers: { workerId: string; family: string; worktrees: string[] }[] = [];
    for (const w of input.workers ?? []) {
      // A worker of another App, or none at all, is refused by the writer like a retired one: by its ref, no oracle.
      const id = (await resolveTaskWorkerId(ctx, app.id, w.worker)) ?? w.worker;
      workers.push({ workerId: id, family: w.family, worktrees: w.worktrees ?? [] });
    }
    try {
      await registerHost(
        ctx.db,
        {
          appId: app.id, hostId: host.hostId, label: input.label, pollIntervalSeconds: input.pollIntervalSeconds, workers,
          capabilities: input.capabilities ?? [],
        },
        new Date(),
        {
          authorize,
          afterWrite: (tx, r) => recordHostKeyUse(tx, host, 'register', { count: r.workerCount }),
        },
      );
    } catch (e) {
      if (e instanceof HostRegistrationError) {
        if (e.code === 'APP_NOT_LIVE') throw appNotFound(input.appRef);
        throw taskError(e.code, e.message);
      }
      throw e;
    }
    // A registration can make a worker launchable, so a queued task may now match (cor:agt:060:06).
    await matchAfterChange(ctx.db, app.id);
    return loadRegistrationView(ctx, app.id, host.hostId);
  }),

  /**
   * cor:agt:070:04 S1 — the host collects its own operations, oldest first: every one still `issued`, which this marks
   * `collected`, and every one it collected before and has not reported (a restarted host resumes them). Only its own
   * host's, in its own App.
   */
  collectHostOperations: async (_: unknown, a: { appRef: string; first?: number | null }, ctx: Context) => recordingRefusal(ctx, 'collect', null, async () => {
    const first = Math.min(Math.max(a.first ?? 20, 1), PAGE_MAX);
    return asHost(ctx, a.appRef, async (tx, app, host) => {
      const now = new Date();
      const out: Array<HostOperationRow & { launchGrant: string | null }> = [];
      // #1928 (Diego P2): a start held back (its grant still live) or failed at collection takes no page slot, so the
      // page is refilled past it, oldest first, until `first` operations are delivered or the host has no more.
      // The cursor is the last row's id, compared through the row itself (no JS Date bound against a naive column).
      let afterId: string | null = null;
      while (out.length < first) {
        const want = first - out.length;
        const rows: { id: string }[] = await tx.$queryRaw`
          SELECT id FROM host_operations
          WHERE app_id = ${app.id} AND host_id = ${host.hostId} AND status IN ('issued', 'collected')
            ${afterId ? Prisma.sql`AND (issued_at, id) > (SELECT issued_at, id FROM host_operations WHERE id = ${afterId})` : Prisma.empty}
          ORDER BY issued_at, id
          LIMIT ${want}
          FOR UPDATE`;
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.id);
        await tx.hostOperation.updateMany({ where: { id: { in: ids }, status: 'issued' }, data: { status: 'collected', collectedAt: now } });
        // #1709 slice 2: each worker.start collected gets a fresh single-use launch grant, shown in this answer only.
        // One whose worker is no longer held fails here instead, and is left out. #1928: one whose grant is still live
        // is left out too, so a re-collect never revokes a launch in flight.
        const starts = await tx.hostOperation.findMany({ where: { id: { in: ids }, type: 'worker.start' } });
        const { grants, withheld } = await mintLaunchGrants(tx, starts, now);
        const ops = await tx.hostOperation.findMany({ where: { id: { in: ids }, status: 'collected' } });
        const byId = new Map(ops.filter((o) => !withheld.has(o.id)).map((o) => [o.id, o]));
        for (const id of ids) if (byId.has(id)) out.push({ ...byId.get(id)!, launchGrant: grants.get(id) ?? null });
        if (rows.length < want) break;
        afterId = rows[rows.length - 1]!.id;
      }
      await recordHostKeyUse(tx, host, 'collect', { count: out.length });
      return out;
    });
  }),

  /**
   * cor:agt:070:03 — the host reports an operation's final outcome: done, or failed with a reason. Only the host it was
   * issued to, and only once it collected it; another host's operation is "not found". Reporting the same outcome
   * again answers the operation as it is; a different one is refused. Writes `host.operation.succeeded` / `.failed`.
   */
  reportHostOperation: async (
    _: unknown,
    { input }: { input: { appRef: string; id: string; outcome: 'SUCCEEDED' | 'FAILED'; worktree?: string | null; failureReason?: string | null } },
    ctx: Context,
  ) => recordingRefusal(ctx, 'report', input?.id, async () => {
    if (!input) throw badInput('input is required.');
    if (input.outcome !== 'SUCCEEDED' && input.outcome !== 'FAILED') throw badInput('outcome is SUCCEEDED or FAILED.');
    const status = input.outcome === 'SUCCEEDED' ? 'succeeded' : 'failed';
    const reason = (input.failureReason ?? '').trim();
    if (status === 'failed' && (reason === '' || reason.length > HOST_FAILURE_REASON_MAX)) {
      throw badInput(`A failure says why, in 1 to ${HOST_FAILURE_REASON_MAX} characters.`);
    }
    if (status === 'succeeded' && input.failureReason != null) throw badInput('Only a failure carries a reason.');
    const endedSessions: string[] = [];
    const reported = await asHost(ctx, input.appRef, async (tx, app, host) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM host_operations WHERE id = ${input.id} FOR UPDATE`;
      const op = locked ? await tx.hostOperation.findUnique({ where: { id: input.id } }) : null;
      if (!op || op.appId !== app.id || op.hostId !== host.hostId) throw opNotFound(input.id);
      if (op.status === 'succeeded' || op.status === 'failed') {
        if (op.status === status) {
          // An idempotent re-report is still a use of the key (070:07; #1876 review, Diego P2-2). Nothing else changes.
          await recordHostKeyUse(tx, host, 'report', { operationId: op.id });
          return op;
        }
        throw taskError('HOST_OPERATION_ALREADY_REPORTED', `This operation was already reported ${op.status}.`, { id: op.id });
      }
      if (op.status !== 'collected') {
        throw taskError('HOST_OPERATION_NOT_COLLECTED', 'Collect an operation before reporting it.', { id: op.id });
      }
      if (status === 'failed' && input.worktree != null) throw badInput('A failure carries no result.');
      let result = status === 'succeeded' ? successResult(op.type as HostOperationType, input.worktree) : null;
      const now = new Date();
      let outcome = status;
      if (op.type === 'worker.start') {
        // #1709 slice 2: done means an agent runs in that worktree AND its worker session is bound (#1709's table: a
        // started terminal without a binding is not success). The server knows which: the session its grant bound.
        const bound = await tx.session.findUnique({ where: { launchOperationId: op.id }, select: { id: true } });
        if (status === 'succeeded' && !bound) {
          throw taskError('HOST_OPERATION_NOT_DONE', 'No worker session was bound with this start\'s grant yet; report SUCCEEDED once it is.', { id: op.id });
        }
        if (bound) {
          outcome = 'succeeded';
          result = { sessionId: bound.id };
        }
      }
      if (op.type === 'worker.end') {
        // cor:agt:020:10 / #1709: worker.end FAILS ONLY IF THE SESSION DID NOT END. A success ends the session if the
        // worker had not (a host-ended stint, recorded without a handoff); a reported failure on a session that did
        // end is recorded as the success it is. Either way the result says whether a handoff was written.
        const args = op.args as { workerId: string; sessionId: string };
        const [session] = await tx.$queryRaw<{ endedAt: Date | null }[]>`
          SELECT ended_at AS "endedAt" FROM sessions WHERE id = ${args.sessionId} FOR UPDATE`;
        if (status === 'succeeded' && session && !session.endedAt) {
          await tx.session.updateMany({ where: { id: args.sessionId, endedAt: null }, data: { endedAt: now, endReason: 'ended' } });
          endedSessions.push(args.sessionId);
        }
        const ended = status === 'succeeded' || Boolean(session?.endedAt);
        if (ended) {
          outcome = 'succeeded';
          result = { handoff: await sessionHasHandoff(tx, args.workerId, args.sessionId) };
        }
      }
      if (op.type === 'worker.reset-context') {
        // #2162: the reset's own outcome first. SUCCEEDED needs the agent relaunched; FAILED names its closed reason.
        try {
          await onContextResetReported(tx, op, status, status === 'failed' ? reason : null, now);
        } catch (e) {
          if (e instanceof ContextResetError) throw taskError(e.code === 'CONTEXT_RESET_WRONG_PHASE' ? 'HOST_OPERATION_NOT_DONE' : e.code, e.message, { id: op.id });
          throw e;
        }
      }
      const updated = await tx.hostOperation.update({
        where: { id: op.id },
        data: {
          status: outcome,
          finishedAt: now,
          result: result ?? Prisma.DbNull,
          failureReason: outcome === 'failed' ? reason : null,
        },
      });
      if (outcome === 'failed') {
        await tx.launchGrant.updateMany({ where: { operationId: op.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      }
      await appendHostOperationEvent(tx, {
        appId: app.id,
        type: outcome === 'succeeded' ? 'host.operation.succeeded' : 'host.operation.failed',
        operationId: op.id,
        hostId: host.hostId,
        operationType: op.type,
        workerId: op.workerId,
        createdAt: now,
      });
      await recordHostKeyUse(tx, host, 'report', { operationId: op.id });
      return updated;
    });
    // A session the host ended releases its memory keys once its end is durable, as every end does.
    for (const id of endedSessions) sessionKeyCache.evict(id);
    return reported;
  }),

  /**
   * cor:agt:060:08, the host's arm: a host marks a worker it registers unavailable, only as out of tokens or host down,
   * or clears a mark it set itself. It never clears or replaces anyone else's mark (a stall among them), and never a
   * worker it does not register.
   */
  setHostWorkerAvailability: async (
    _: unknown,
    { input }: { input: { appRef: string; worker: string } & AvailabilityInput },
    ctx: Context,
  ) => recordingRefusal(ctx, 'availability', null, async () => {
    if (!input) throw badInput('input is required.');
    const now = new Date();
    const { state, reason, until } = normalizeAvailability(input, now);
    if (state === 'unavailable' && reason !== 'out-of-tokens' && reason !== 'host-down') {
      throw taskError('AVAILABILITY_NOT_PERMITTED', 'A host marks a worker unavailable only as OUT_OF_TOKENS or HOST_DOWN.');
    }
    const notRegistered = () => taskError('WORKER_NOT_FOUND', 'This host does not register that worker.', { worker: input.worker });
    let workerId: string | null = null;
    // One gate (Greta P3-2): the host key's entry runs once, in asHost; the worker resolves after it.
    const app = await asHost(ctx, input.appRef, async (tx, freshApp, host) => {
      workerId = await resolveTaskWorkerId(ctx, freshApp.id, input.worker);
      if (!workerId) throw notRegistered();
      // #2162: the per-worker assignment lock before the worker row (src/lib/agentTasks/workerLock.ts).
      await lockWorkersForAssignment(tx, [workerId]);
      const [w] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null }[]>`
        SELECT app_id AS "appId", retired_at AS "retiredAt" FROM workers WHERE id = ${workerId} FOR UPDATE`;
      // FOR UPDATE, not SHARE (#1876 review, Diego P2-3): the worker row exists before any availability row, so it is
      // the per-worker lock for a FIRST mark too, where a FOR UPDATE on the absent availability row would lock nothing.
      // It conflicts with the FOR SHARE every other availability writer takes, in their order (worker, then record).
      //
      // Then the host's REGISTRATION row FOR SHARE, before reading whether it lists the worker (#1876 review, Riana
      // P2, #10733): registerHost replaces the worker list under that row FOR UPDATE, and a refresh to an empty list
      // locks no worker row, so without this fence it could drop the worker between the read and the mark. Lock order
      // worker, then registration, never the reverse: registerHost takes the workers it lists FOR SHARE before its
      // registration row, so the two orders never cycle.
      const [reg] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM host_registrations WHERE app_id = ${freshApp.id} AND host_id = ${host.hostId} FOR SHARE`;
      const listed = reg
        ? await tx.hostRegistrationWorker.findFirst({ where: { registrationId: reg.id, workerId }, select: { workerId: true } })
        : null;
      if (!w || w.appId !== freshApp.id || w.retiredAt || !listed) throw notRegistered();
      const [cur] = await tx.$queryRaw<{ state: string; reason: string | null; until: Date | null; setAt: Date; setBy: string; setByHostId: string | null }[]>`
        SELECT state, reason, until, set_at AS "setAt", set_by AS "setBy", set_by_host_id AS "setByHostId"
        FROM worker_availability WHERE worker_id = ${workerId} FOR UPDATE`;
      const ownMark = cur?.setBy === 'host' && cur.setByHostId === host.hostId;
      // #2162: a host marking the worker DOWN replaces a context reset's `resetting` mark and cancels the reset; the
      // worker stays unavailable at least until a granted stop's lease ends (cor:agt:050:27 §2.4).
      const overReset = state === 'unavailable' && reason === 'host-down' && cur?.reason === 'resetting' && cur.setBy === 'context-reset';
      const othersMarkInEffect = cur && cur.state === 'unavailable' && !ownMark && !overReset && recordInEffect(cur, now);
      if (state === 'unavailable' && othersMarkInEffect) {
        throw taskError('AVAILABILITY_NOT_PERMITTED', 'This worker is unavailable by someone else\'s mark; a host does not replace it.');
      }
      if (state === 'available' && !(ownMark && cur!.state === 'unavailable')) {
        throw taskError('AVAILABILITY_NOT_PERMITTED', 'A host clears only a mark it set itself.');
      }
      let markUntil = until;
      // #2255 review: a granted stop still outstanding (its reset live or already ended) floors every host write: the
      // host's own clear keeps the worker unavailable until the lease ends, and its mark lapses no earlier.
      const lease = overReset ? await cancelLiveReset(tx, workerId, 'HOST_LOST', now) : await outstandingStopLease(tx, workerId, now);
      if (lease && state === 'available') {
        await holdForStopLease(tx, { workerId, appId: freshApp.id }, lease, now);
        await recordHostKeyUse(tx, host, 'availability', { count: 1 });
        return freshApp;
      }
      if (lease && markUntil && markUntil.getTime() < lease.leaseEnd.getTime()) markUntil = lease.leaseEnd;
      const data = {
        state, reason, until: markUntil, setAt: now, setBy: 'host',
        setByUserId: null, setByWorkerId: null, setByAgentId: null, setByHostId: host.hostId, clearsOnActivityAfter: null,
        contextResetId: null,
      };
      await tx.workerAvailability.upsert({ where: { workerId }, create: { workerId, ...data }, update: data });
      await appendAvailabilityEvent(tx, {
        appId: freshApp.id,
        actor: PLATFORM_ACTOR,
        event: {
          kind: 'worker', workerId, state, reason: reason as 'out-of-tokens' | 'host-down' | null, until: markUntil, setBy: 'host', hostId: host.hostId,
        },
      });
      await recordHostKeyUse(tx, host, 'availability', { count: 1 });
      return freshApp;
    });
    await matchAfterChange(ctx.db, app.id);
    return ctx.db.workerAvailability.findUniqueOrThrow({ where: { workerId: workerId! } });
  }),

  /**
   * #2771 (proposed cor:agt:070:09) — a host reports the terminal state of workers it registers. The host key's gate
   * (cor:agt:070:04, #1749 order) runs once, in asHost. The WHOLE batch is validated before any lock, and a malformed
   * one refuses everything (BAD_USER_INPUT, nothing stored). A worker the host may not report is refused for that item
   * only, exactly `setHostWorkerAvailability`'s test (this App, not retired, listed in THIS host's registration; the
   * registration's `lostAt` is irrelevant), so a worker retired between the host's refresh and its sweep does not blank
   * the team's report. An older report than the stored one is skipped. Lock order: every batch worker FOR UPDATE in id
   * order, then the registration FOR SHARE once (workers before registration, as registerHost, so no cycle).
   *
   * The server builds what it stores (`buildWorkerTerminal`): `host` is the key's host and its registration's label,
   * `reportedAt` is the server's clock. The report decides nothing. The alarm verdict is computed from the stored
   * rows after the write and returned, never stored, and names only coordinators THIS host registers.
   */
  setHostWorkerTerminals: async (
    _: unknown,
    { input }: { input: { appRef: string; reports: TerminalReportInput[] } },
    ctx: Context,
  ) => recordingRefusal(ctx, 'terminal', null, async () => {
    if (!input) throw badInput('input is required.');
    const now = new Date();
    const checked = validateTerminalBatch(input.reports, now);
    if (!checked.ok) throw badInput(checked.message);
    return asHost(ctx, input.appRef, async (tx, app, host) => {
      const refs = new Map<string, string | null>();
      for (const r of checked.reports) refs.set(r.worker, await resolveTaskWorkerId(ctx, app.id, r.worker));
      // #2791 §10: the resolver spans every App, so a worker of ANOTHER tenant must read as absent BEFORE the duplicate
      // check; otherwise naming it twice answers BAD_USER_INPUT while an absent worker answers WORKER_NOT_FOUND twice.
      const resolved = [...refs.values()].filter((id): id is string => id !== null);
      const inApp = new Set(
        resolved.length
          ? (await tx.worker.findMany({ where: { id: { in: resolved }, appId: app.id }, select: { id: true } })).map((w) => w.id)
          : [],
      );
      for (const [k, id] of refs) if (id !== null && !inApp.has(id)) refs.set(k, null);
      // Two refs naming one worker (an id and its name) are one report twice: sender's bug, nothing stored.
      const named = [...refs.values()].filter((id): id is string => id !== null);
      if (new Set(named).size !== named.length) throw badInput('A worker is reported at most once per call.');
      const rows = new Map<string, { appId: string; retiredAt: Date | null; slug: string; terminal: StoredWorkerTerminal | null }>();
      for (const id of [...named].sort()) {
        const [w] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null; slug: string; terminal: StoredWorkerTerminal | null }[]>`
          SELECT app_id AS "appId", retired_at AS "retiredAt", slug, terminal FROM workers WHERE id = ${id} FOR UPDATE`;
        if (w) rows.set(id, w);
      }
      const [reg] = await tx.$queryRaw<{ id: string; label: string }[]>`
        SELECT id, label FROM host_registrations WHERE app_id = ${app.id} AND host_id = ${host.hostId} FOR SHARE`;
      const listed = new Set(
        reg && named.length
          ? (await tx.hostRegistrationWorker.findMany({ where: { registrationId: reg.id, workerId: { in: named } }, select: { workerId: true } })).map((l) => l.workerId)
          : [],
      );
      const stored: { id: string; urn: string }[] = [];
      const refused: { worker: string; code: string }[] = [];
      for (const r of checked.reports) {
        const id = refs.get(r.worker) ?? null;
        const w = id ? rows.get(id) : undefined;
        if (!id || !w || !reg || w.appId !== app.id || w.retiredAt || !listed.has(id)) {
          refused.push({ worker: r.worker, code: 'WORKER_NOT_FOUND' });
          continue;
        }
        if (w.terminal && new Date(w.terminal.checkedAt).getTime() > r.checkedAt.getTime()) {
          refused.push({ worker: r.worker, code: 'TERMINAL_REPORT_STALE' });
          continue;
        }
        const terminal = buildWorkerTerminal(r, { id: host.hostId, label: reg.label }, now);
        await tx.worker.update({ where: { id }, data: { terminal: terminal as unknown as Prisma.InputJsonObject } });
        stored.push({ id, urn: composeWorkerUrn(app.urn, w.slug) });
      }
      const verdict = await terminalAlarmVerdict(tx, app, reg?.id ?? null, now);
      await recordHostKeyUse(tx, host, 'terminal', { count: stored.length });
      return { stored, refused, alarm: verdict.alarm, noCoordinator: verdict.noCoordinator };
    });
  }),

  /**
   * cor:agt:070:05 — issue an operation to one of the App's registered hosts. This slice issues the worktree
   * operations: the worker's holder, the worker it reports to (through its session), or whoever manages the App. The
   * type is checked first: anything outside the closed set is refused HOST_OPERATION_TYPE_UNKNOWN (cor:agt:070:03).
   */
  issueHostOperation: async (
    _: unknown,
    { input }: { input: { appRef: string; hostId: string; worker: string; type: string; args?: Record<string, unknown> | null } },
    ctx: Context,
  ) => recordingRefusal(ctx, 'issue', null, async () => {
    if (!input) throw badInput('input is required.');
    if (appKeyCaller(ctx)) throw taskError('FORBIDDEN', 'An App key does not issue host operations.');
    // The type and the shape of the arguments first: a refusal here depends only on the caller's own input.
    let validated: { type: HostOperationType; args: Record<string, string> };
    try {
      if (input.args && Object.prototype.hasOwnProperty.call(input.args, 'workerId')) {
        throw new HostOperationArgsError('BAD_HOST_OPERATION_ARGS', 'Name the worker with `worker`, not inside args.');
      }
      validated = validateHostOperation(input.type, { ...(input.args ?? {}), workerId: 'placeholder' });
    } catch (e) {
      if (e instanceof HostOperationArgsError) throw taskError(e.code, e.message);
      throw e;
    }
    if (validated.type === 'worker.deliver') {
      throw taskError(
        'HOST_OPERATION_NOT_ISSUABLE',
        'worker.deliver is not issued until a host has a delivery path for it (hadron-cli#829).',
      );
    }
    if (validated.type === 'worker.reset-context') {
      // #2162 (cor:agt:050:27 §8): only a task's end requests a reset; nobody issues one by hand.
      throw taskError('HOST_OPERATION_NOT_ISSUABLE', 'worker.reset-context is issued only by the platform, when a task ends.');
    }
    const hostId = (input.hostId ?? '').trim();
    if (!HOST_ID_PATTERN.test(hostId)) throw badInput('hostId is a host token.');
    const { app, actor } = await resolveParticipatedApp(ctx, input.appRef);
    requireWritable(ctx, app);
    const workerId = await resolveTaskWorkerId(ctx, app.id, input.worker);
    const workerNotFound = () => taskError('WORKER_NOT_FOUND', 'Worker not found.', { worker: input.worker });
    if (!workerId) throw workerNotFound();
    const args: Record<string, string> = { ...validated.args, workerId };
    if (validated.type === 'worker.start') return issueWorkerStart(ctx, app, actor, hostId, workerId, args, input.appRef);
    const id = generateId();
    await inTaskWriteTx(ctx, app, actor, () => appNotFound(input.appRef), async (tx, txCtx, freshApp) => {
      // The worker under a lock (a release, a retire or a reportsTo change either committed first or waits; the
      // reportsTo graph lock is held shared by inTaskWriteTx).
      const [target] = await tx.$queryRaw<{ appId: string; heldByUserId: string | null; retiredAt: Date | null; reportsToWorkerId: string | null }[]>`
        SELECT app_id AS "appId", held_by_user_id AS "heldByUserId", retired_at AS "retiredAt",
               reports_to_worker_id AS "reportsToWorkerId"
        FROM workers WHERE id = ${workerId} FOR SHARE`;
      if (!target || target.appId !== freshApp.id) throw workerNotFound();
      if (target.retiredAt) throw taskError('WORKER_RETIRED', 'This worker is retired.', { workerId });
      if (validated.type === 'worker.end') {
        // Starting or ending a worker is whoever manages the App's (070:05); worktree authority alone is not enough.
        if (!(await actorManagesApp(txCtx, freshApp, actor))) {
          throw taskError('HOST_OPERATION_NOT_PERMITTED', "Only whoever manages the App ends a worker's session through its host.");
        }
        const [session] = await tx.$queryRaw<{ workerId: string | null; endedAt: Date | null; deletedAt: Date | null }[]>`
          SELECT worker_id AS "workerId", ended_at AS "endedAt", deleted_at AS "deletedAt" FROM sessions WHERE id = ${args.sessionId} FOR SHARE`;
        if (!session || session.workerId !== workerId || session.endedAt || session.deletedAt) {
          throw taskError('BAD_HOST_OPERATION_ARGS', 'worker.end names an open session of this worker.');
        }
      } else if (!(await mayIssueWorktreeOp(txCtx, freshApp, actor, target))) {
        throw taskError(
          'HOST_OPERATION_NOT_PERMITTED',
          "A worktree is created or removed by the worker's holder, the worker it reports to, or whoever manages the App.",
        );
      }
      const [reg] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM host_registrations WHERE app_id = ${freshApp.id} AND host_id = ${hostId} FOR SHARE`;
      if (!reg) throw taskError('HOST_NOT_FOUND', 'No host with that id is registered in this App.', { hostId });
      if (validated.type === 'worker.end') {
        const listed = await tx.hostRegistrationWorker.findFirst({ where: { registrationId: reg.id, workerId }, select: { workerId: true } });
        if (!listed) throw taskError('BAD_HOST_OPERATION_ARGS', 'That host does not register this worker.');
      }
      if (validated.type === 'worktree.remove') {
        const listed = await tx.hostRegistrationWorker.findFirst({
          where: { registrationId: reg.id, workerId, worktrees: { has: args.worktree } },
          select: { workerId: true },
        });
        if (!listed) throw taskError('BAD_HOST_OPERATION_ARGS', 'That host registers no such worktree for this worker.');
      }
      await tx.hostOperation.create({
        data: {
          id,
          appId: freshApp.id,
          hostId,
          type: validated.type,
          args,
          workerId,
          ...issuer(ctx, actor),
        },
      });
    });
    return ctx.db.hostOperation.findUniqueOrThrow({ where: { id } });
  }),

  // ── #2162 (cor:agt:050:27): a context reset's protocol steps, the host's own key only ──────────────────────
  // Each names the reset and its epoch; each is idempotent; each is recorded as a `reset` use of the key.

  /** Take the fence: the worker becomes `resetting` (§1.5). Refused steps end the reset and say why. */
  claimContextReset: (_: unknown, { input }: { input: ResetStepInput & { process: unknown } }, ctx: Context) =>
    resetStep(ctx, input, (tx, host, now) => claimContextReset(tx, host, input.resetId, input.epoch, input.process, now)),

  /** Register the durable checkpoint before any process control (§3.4). */
  registerContextResetRecovery: (
    _: unknown,
    { input }: { input: ResetStepInput & { checkpointNode: string; sessionId: string; taskId: string } },
    ctx: Context,
  ) => resetStep(ctx, input, (tx, host, now) => registerContextResetRecovery(tx, host, input.resetId, input.epoch, input, now)),

  /** The single stop grant (§2.1): the host signals only within `stopLeaseMs` of its own send time. */
  authorizeContextResetStop: (_: unknown, { input }: { input: ResetStepInput & { process: unknown } }, ctx: Context) =>
    resetStep(ctx, input, (tx, host, now) => authorizeContextResetStop(tx, host, input.resetId, input.epoch, input.process, now)),

  /** The old agent stopped: the mark now waits for the relaunched agent's first activity. */
  reportContextResetAgentStopped: (_: unknown, { input }: { input: ResetStepInput }, ctx: Context) =>
    resetStep(ctx, input, (tx, host, now) => reportContextResetAgentStopped(tx, host, input.resetId, input.epoch, now)),

  /** The agent was relaunched under its wrapper, with the new process. */
  reportContextResetRelaunched: (_: unknown, { input }: { input: ResetStepInput & { process: unknown } }, ctx: Context) =>
    resetStep(ctx, input, (tx, host, now) => reportContextResetRelaunched(tx, host, input.resetId, input.epoch, input.process, now)),

  /** A failure after the claim that the host saw; the reset ends and its mark is released under §2. */
  reportContextResetRelaunchFailed: (_: unknown, { input }: { input: ResetStepInput & { reason: string } }, ctx: Context) =>
    resetStep(ctx, input, (tx, host, now) => reportContextResetRelaunchFailed(tx, host, input.resetId, input.epoch, input.reason, now)),
};

type ResetStepInput = { appRef: string; resetId: string; epoch: number };

/**
 * One host step of a context reset: the host-key gate (cor:agt:070:04), one transaction under the App's anchor, the
 * step, and the key's use recorded with it. A refusal that changes nothing (a wrong id, a stale epoch, a step out of
 * order) is a typed error, recorded apart like every refused host call.
 */
async function resetStep(
  ctx: Context,
  input: ResetStepInput | null | undefined,
  run: (tx: Prisma.TransactionClient, host: ResetHost, now: Date) => Promise<ContextResetStep>,
) {
  return recordingRefusal(ctx, 'reset', null, async () => {
    if (!input) throw badInput('input is required.');
    try {
      const out = await asHost(ctx, input.appRef, async (tx, app, host) => {
        const result = await run(tx, { appId: app.id, hostId: host.hostId }, new Date());
        await recordHostKeyUse(tx, host, 'reset', { operationId: result.reset.hostOperationId ?? undefined });
        return result;
      });
      // A refusal or failure may have released the worker; a queued task may now match (cor:agt:060:06).
      if (out.refused) await matchAfterChange(ctx.db, out.reset.appId);
      return out;
    } catch (e) {
      if (e instanceof ContextResetError) throw taskError(e.code, e.message, { resetId: input.resetId });
      throw e;
    }
  });
}

/**
 * cor:agt:070:05 — start a worker: whoever manages the App, with a task or without (Holger via Vera #10774: a manager
 * assembles a team before committing to a mission). Worktree authority alone does not start a worker. The worker must
 * be held, with no live session and no start in flight; the host must be live and list it with that worktree and family.
 */
async function issueWorkerStart(
  ctx: Context, app: TaskApp, actor: TaskActor, hostId: string, workerId: string, args: Record<string, string>, appRef: string,
) {
  let id = '';
  try {
    await inTaskWriteTx(ctx, app, actor, () => appNotFound(appRef), async (tx, txCtx, freshApp) => {
      if (!(await actorManagesApp(txCtx, freshApp, actor))) {
        throw taskError('HOST_OPERATION_NOT_PERMITTED', 'Only whoever manages the App starts a worker through its host.');
      }
      const now = new Date();
      const hold = await lockStartableWorker(tx, freshApp.id, workerId, now);
      // Diego P2-2: the registration, its worktree and the lapse count hold still through the insert.
      await fenceHostDecision(tx, freshApp.id);
      const [reg] = await liveRegistrationsFor(tx, freshApp.id, workerId, now, hostId);
      if (!reg) throw taskError('HOST_NOT_FOUND', 'No live host with that id registers this worker.', { hostId });
      if (!reg.worktrees.includes(args.worktree!)) {
        throw taskError('BAD_HOST_OPERATION_ARGS', 'A worker starts only in a worktree that host registers for it (cor:agt:070:06).');
      }
      if (reg.family !== args.family) {
        throw taskError('BAD_HOST_OPERATION_ARGS', `That host launches this worker as ${reg.family}.`);
      }
      if (args.taskId) {
        const task = await tx.agentTask.findUnique({ where: { id: args.taskId }, select: { appId: true, assigneeWorkerId: true, status: true } });
        if (!task || task.appId !== freshApp.id || task.assigneeWorkerId !== workerId || !['pending', 'started'].includes(task.status)) {
          throw taskError('BAD_HOST_OPERATION_ARGS', "taskId names an open task of this App assigned to this worker.");
        }
      }
      const e = issuer(ctx, actor);
      id = await insertWorkerStart(tx, {
        appId: freshApp.id, hostId, workerId, worktree: args.worktree!, family: args.family!, taskId: args.taskId ?? null,
        issuer: { issuedBy: 'user', issuedByUserId: e.issuedByUserId!, issuedByAgentId: e.issuedByAgentId }, hold,
      });
    });
  } catch (e) {
    if (e instanceof LaunchRefusal) throw taskError(e.code, e.message, { workerId });
    throw e;
  }
  return ctx.db.hostOperation.findUniqueOrThrow({ where: { id } });
}

/** cor:agt:070:05 — create or remove a worktree: the holder, the worker it reports to, or whoever manages the App. */
async function mayIssueWorktreeOp(
  txCtx: Context,
  app: TaskApp,
  actor: TaskActor,
  target: { heldByUserId: string | null; reportsToWorkerId: string | null },
): Promise<boolean> {
  if (actor.kind === 'worker') return target.reportsToWorkerId !== null && target.reportsToWorkerId === actor.workerId;
  if (target.heldByUserId !== null && target.heldByUserId === actor.userId) return true;
  return actorManagesApp(txCtx, app, actor);
}

function issuer(ctx: Context, actor: TaskActor) {
  const e = eventActor(ctx.userId);
  return actor.kind === 'worker'
    ? { issuedBy: 'worker', issuedByUserId: e.userId, issuedByWorkerId: actor.workerId, issuedByAgentId: e.agentId }
    : { issuedBy: 'user', issuedByUserId: actor.userId, issuedByWorkerId: null, issuedByAgentId: null };
}

/** A success's typed result: the created worktree for `worktree.create`; nothing for the others in this slice. */
function successResult(type: HostOperationType, worktree: string | null | undefined): Prisma.InputJsonObject | null {
  if (type === 'worktree.create') {
    if (!isHostToken(worktree)) throw badInput('A created worktree reports its name: a host-operation token.');
    return { worktree };
  }
  if (worktree != null) throw badInput(`${type} reports no worktree.`);
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** The registration as the App's readers see it, with liveness derived now. */
async function loadRegistrationView(ctx: Context, appId: string, hostId: string) {
  const views = await loadRegistrationViews(ctx, appId, hostId);
  return views[0]!;
}

async function loadRegistrationViews(ctx: Context, appId: string, hostId?: string) {
  const regs = await ctx.db.hostRegistration.findMany({
    where: { appId, ...(hostId ? { hostId } : {}) },
    include: { workers: { orderBy: { workerId: 'asc' } } },
    orderBy: { hostId: 'asc' },
  });
  const schedule = await ctx.db.agentTaskStallSchedule.findUnique({ where: { appId }, select: { hostLapseCheckIns: true } });
  const checkIns = schedule?.hostLapseCheckIns ?? HOST_LAPSE_CHECK_INS_DEFAULT;
  const now = new Date();
  return regs.map((r) => ({
    hostId: r.hostId,
    label: r.label,
    pollIntervalSeconds: r.pollIntervalSeconds,
    registeredAt: r.registeredAt,
    refreshedAt: r.refreshedAt,
    live: isRegistrationLive(r, now, checkIns),
    capabilities: r.capabilities,
    workers: r.workers.map((w) => ({ workerId: w.workerId, family: w.family, worktrees: w.worktrees })),
  }));
}

export const hostOperationQueries = {
  /** The App's host registrations: whoever reads its tasks and events (cor:agt:050:21), the App's own key included. */
  hostRegistrations: (_: unknown, a: { appRef: string }, ctx: Context) =>
    recordingRefusal(ctx, 'read', null, async () => {
      const views = await withReadableApp(ctx, a.appRef, (c, app) => loadRegistrationViews(c, app.id));
      // #1881 (cor:agt:070:07): a host key's read is a use too, recorded apart from the read.
      const key = appKeyCaller(ctx);
      if (key) await recordHostKeyUseApart(ctx.db, key, 'read', { count: views.length });
      return views;
    }),

  /** The App's host operations, newest first: whoever reads its tasks and events (cor:agt:050:21). */
  hostOperations: (
    _: unknown,
    a: { appRef: string; hostId?: string | null; status?: string | null; worker?: string | null; first?: number | null; after?: string | null },
    ctx: Context,
  ) =>
    recordingRefusal(ctx, 'read', null, () => withReadableApp(ctx, a.appRef, async (c, app) => {
      // Ruling 0 (Holger via Vera #10955; cor:agt:070:04 S5): a host key does not read the App-wide listing; it sees
      // its own host's operations only by collecting them. Refused before any argument is read, so the answer is the
      // same whatever hostId, status, worker or cursor it passes: no oracle for another host's operations.
      if (await wasEverHostKey(c)) {
        throw taskError('FORBIDDEN', "A host key reads its own host's operations by collecting them, not from the App's listing.");
      }
      const first = Math.min(Math.max(a.first ?? 20, 1), PAGE_MAX);
      const status = a.status ? a.status.toLowerCase() : null;
      if (status && !['issued', 'collected', 'succeeded', 'failed'].includes(status)) {
        throw badInput('status is ISSUED, COLLECTED, SUCCEEDED or FAILED.');
      }
      let workerId: string | null = null;
      if (a.worker) {
        workerId = await resolveTaskWorkerId(c, app.id, a.worker);
        if (!workerId) return { items: [], hasNextPage: false, endCursor: null };
      }
      let cursor: { issuedAt: Date; id: string } | null = null;
      if (a.after) {
        const at = await c.db.hostOperation.findFirst({
          where: { id: a.after, appId: app.id },
          select: { issuedAt: true, id: true },
        });
        if (!at) throw badInput('after is not a cursor of this list.');
        cursor = at;
      }
      const rows: HostOperationRow[] = await c.db.hostOperation.findMany({
        where: {
          appId: app.id,
          ...(a.hostId ? { hostId: a.hostId } : {}),
          ...(status ? { status } : {}),
          ...(workerId ? { workerId } : {}),
          ...(cursor ? { OR: [{ issuedAt: { lt: cursor.issuedAt } }, { issuedAt: cursor.issuedAt, id: { lt: cursor.id } }] } : {}),
        },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: first + 1,
      });
      const items = rows.slice(0, first);
      return { items, hasNextPage: rows.length > first, endCursor: items.length ? items[items.length - 1]!.id : null };
    })),
};

/**
 * Is the caller an App key that has ever been granted host:operate, live or revoked? Such a key is a host key for the
 * listing's refusal, so revoking the scope never opens the App-wide read (#1894; it replaces #1884's host binding).
 */
async function wasEverHostKey(c: Context): Promise<boolean> {
  const key = appKeyCaller(c);
  return key ? keyEverHeldHostOperate(c.db, key.appKeyId) : false;
}

export const hostOperationFieldResolvers = {
  HostOperation: {
    type: (o: HostOperationRow) => o.type,
    status: (o: HostOperationRow) => o.status.toUpperCase(),
    issuedBy: (o: HostOperationRow) => o.issuedBy.toUpperCase(),
    worker: (o: HostOperationRow, _a: unknown, ctx: Context) => ctx.db.worker.findUnique({ where: { id: o.workerId } }),
  },
  HostRegistrationWorker: {
    worker: (w: { workerId: string }, _a: unknown, ctx: Context) => ctx.db.worker.findUnique({ where: { id: w.workerId } }),
  },
};

/**
 * cor:agt:070:07 S3 — a host key's use record: whoever manages the key's App only, like its scopes. Newest first.
 * An `AppKey` reaches callers through fields that do not re-check (App.keys), so this field does.
 */
export async function appKeyHostUses(key: { id: string; appId: string }, a: { first?: number | null }, ctx: Context) {
  const app = await ctx.db.app.findUnique({ where: { id: key.appId }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app || !(await managesApp(ctx, app))) {
    throw taskError('FORBIDDEN', "Only whoever manages this App can read what its keys did.");
  }
  const first = Math.min(Math.max(a.first ?? 20, 1), PAGE_MAX);
  return ctx.db.hostKeyUse.findMany({ where: { appKeyId: key.id }, orderBy: [{ usedAt: 'desc' }, { id: 'desc' }], take: first });
}
