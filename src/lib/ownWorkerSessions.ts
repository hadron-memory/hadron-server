/**
 * #1353 — the own-worker session/read machinery that the team wake and mark paths
 * share: the explicit `markOwnTeamChatRead`, the read-cursor advance behind a
 * served team-chat read (`maybeAdvanceOwnChannelRead`), the lapsed-session resume
 * rules (#1617 B), the Channel incarnation fence (#2181), `mayStillDriveWorkerApp`
 * and the wake-proof secret (`workerProofSecret`).
 *
 * The attention POLL this module used to be named for (#4509 renamed it) — the v1 one-shot `teamAttention`,
 * the #1384 paged successor and the switchover — was retired by #2027 S11; its scan
 * engine, signed tokens and continuation codec are gone. What bounds every door here
 * is still the caller's own live Worker session and current App participation. This
 * matters for `maybeAdvanceOwnChannelRead`: without a presented execution session, an
 * ordinary transcript read remains the old read-only act. #3818 deliberately refuses
 * an accepted principal presenting a superseded session.
 */

import { refuseSupersededSession } from './sessionSuperseded.js';
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { isAppParticipant } from '../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedTx } from '../api/graphql/schema/authorizedTx.js';
import type { AuthorityAnchor } from './auth/authorityAnchors.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { AppNotFoundError } from './entityRef/errors.js';
import { resolveChannelRefId } from './entityRef/channelRef.js';
import { resolveRegister } from './resolveRegister.js';
import { advanceReadState, diagnoseNoStamp, readStateIncarnations, recordCheckMiss, stampChannelCheck } from './channelReadState.js';
import { raiseDeliveryMark, raiseReadIfMentionOnly } from './workerMarks.js';
import { mentionsWorkerOf } from './mentionsReadResolution.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';
import {
  isSessionLive,
  loadLastEventBySession,
  OPEN_SESSION_SCAN_CAP,
  recentlyTouchedFilter,
  touchLiveSession,
  isSessionDormant,
  DEFAULT_SESSION_DORMANCY_DAYS,
  toNaiveUtc,
} from './sessionActivity.js';

function fail(message: string, code: string, extra: Record<string, unknown> = {}): never {
  throw new GraphQLError(message, { extensions: { code, ...extra } });
}

/**
 * #2181 — the typed refusal for a guarded read or mark whose Channel is no longer the incarnation the caller read.
 * The server never retargets: the caller reads the current incarnation and pages again.
 */
export function channelIncarnationChanged(channelId: string, currentIncarnation: number | null, expected?: number): GraphQLError {
  const pinned = expected != null ? `, you pinned ${expected}` : '';
  return new GraphQLError(
    `Channel ${channelId} was recreated since you read it (it is now incarnation ${currentIncarnation ?? 'unknown'}${pinned}). ` +
      'Read it again and pin the new incarnation; do not repeat this call.',
    { extensions: { code: 'CHANNEL_INCARNATION_CHANGED', channelId, currentIncarnation } },
  );
}

/**
 * #2181 — the deciding fence. Takes the Channel row `FOR SHARE` as the FIRST statement of the caller's transaction and
 * compares its live incarnation with the expected one (after any authorization anchors the caller's transaction
 * already took; no row lock of the read/ack protocols precedes it). Every supported delete / recreate / restore writer ends in an
 * `UPDATE channels` on this row, so it serializes with the guarded effects in both orders; read-state rows are only
 * ever locked after it (channel row, then read-state row). A mismatch throws and the caller's transaction writes nothing.
 */
export async function fenceChannelIncarnation(tx: Prisma.TransactionClient, channelId: string, expected: number): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ incarnation: number; deleted_at: Date | null }>>`
    SELECT incarnation, deleted_at FROM channels WHERE id = ${channelId} FOR SHARE`;
  const row = rows[0];
  if (!row || row.deleted_at) fail('No readable registered Channel matches.', 'CHANNEL_NOT_FOUND');
  if (row.incarnation !== expected) throw channelIncarnationChanged(channelId, row.incarnation, expected);
}

/** The raw secret behind the wake-proof and delivery-batch-proof HMAC keys
 * (`tickers/wakeProof.ts`): each derivation labels its own domain
 * (`hadron-wake-proof-v1`, `hadron-batch-proof-v1`), so the two never share a
 * key. The v2 paged-attention codec that also consumed this secret was retired
 * with the attention API (#2027 S11). */
export function workerProofSecret(): string {
  // #4509: the new name first, the old one for one deprecation cycle, then the existing JWT_SECRET fallback.
  const secret = process.env[PROOF_SECRET_ENV] || legacyProofSecret() || process.env.JWT_SECRET;
  if (!secret) fail('The team-attention token signer is not configured.', 'TEAM_ATTENTION_NOT_CONFIGURED');
  return secret;
}

/** The proof secret's env name since #4509. */
export const PROOF_SECRET_ENV = 'WORKER_PROOF_TOKEN_SECRET';
/** Its name before #4509, still read for one deprecation cycle (the follow-up drops it). */
export const LEGACY_PROOF_SECRET_ENV = 'TEAM_ATTENTION_TOKEN_SECRET';
let legacyEnvWarned = false;
/** For tests: let the once-per-process warning fire again. */
export function resetLegacyProofSecretWarning(): void {
  legacyEnvWarned = false;
}
/** The old name's value, with one warning per process (names only, never a value) when it is the one being used. */
function legacyProofSecret(): string | undefined {
  const value = process.env[LEGACY_PROOF_SECRET_ENV];
  if (value && !legacyEnvWarned) {
    legacyEnvWarned = true;
    console.warn(`[config] ${LEGACY_PROOF_SECRET_ENV} is deprecated: set ${PROOF_SECRET_ENV} instead; the old name is read for one more release cycle.`);
  }
  return value || undefined;
}

/**
 * A LIVE App: not deleted, not uninstalled, and — when org-owned — in an org
 * that is not soft-deleted. `softDeleteOrganizationCore` stamps only the org
 * and keeps its membership rows, so the App row and `isAppParticipant` alone
 * would go on admitting a deleted org's former participants (#1362 review).
 */
const LIVE_APP_WHERE: Prisma.AppWhereInput = {
  deletedAt: null,
  uninstalledAt: null,
  OR: [{ organizationId: null }, { organization: { deletedAt: null } }],
};

/**
 * May this caller STILL drive a worker of `appId` (#1540, Codex-worker P1 on
 * #1542)? A session's `userId` is historical — stamped at bind, never revoked —
 * so keeping a session alive needs CURRENT eligibility, the rule
 * `ownLiveSessionWorker` and the MCP heartbeat already apply: a user must still
 * participate in the worker's live App (its org not deleted); a pure App-key
 * caller only for its own App. Impersonation never drives anything.
 */
export async function mayStillDriveWorkerApp(ctx: Context, appId: string): Promise<boolean> {
  if (ctx.impersonation) return false;
  if (!ctx.userId) return !!ctx.appId && ctx.appId === appId;
  const app = await ctx.db.app.findFirst({
    where: { id: appId, ...LIVE_APP_WHERE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  return !!app && (await isAppParticipant(ctx, app));
}

/**
 * The App gate the own-worker acts (the explicit mark-read, and before #2027 S11
 * the attention poll) share: an ordinary non-impersonated user, a live App, and
 * current participation. Existing-but-unreadable and absent Apps answer alike.
 */
async function resolvePilotApp(ctx: Context, appRef: string): Promise<{ id: string }> {
  if (!ctx.userId || ctx.impersonation) fail('This operation is available only to an ordinary user.', 'FORBIDDEN');
  let id: string;
  try {
    ({ id } = await resolveAppRef(ctx.db, appRef));
  } catch (error) {
    if (error instanceof AppNotFoundError) fail('App not found.', 'APP_NOT_FOUND');
    throw error;
  }
  const app = await ctx.db.app.findFirst({
    where: { id, ...LIVE_APP_WHERE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  // Existing-but-unreadable and absent Apps are indistinguishable.
  if (!app || !(await isAppParticipant(ctx, app))) fail('App not found.', 'APP_NOT_FOUND');
  return app;
}

/** The deciding columns a resume re-reads; one shape for the pre-check and the locked pass. */
const RESUME_SESSION_SELECT = {
  id: true, userId: true, appId: true, workerId: true, endedAt: true, deletedAt: true, expiresAt: true,
  type: true, startedAt: true, updatedAt: true, autoExpiredAt: true,
  worker: { select: { appId: true, heldByUserId: true, retiredAt: true, app: { select: { sessionDormancyDays: true } } } },
} as const;

/** What a lapsed-session resume would do: resume, refuse as DORMANT (DY-5), or refuse. */
export type ResumeVerdict = 'OK' | 'DORMANT' | 'REFUSED';

/** The principals that may resume at all: an ordinary user, or a pure App key (DY-1). */
function resumingPrincipal(ctx: Context): 'user' | 'appKey' | null {
  if (ctx.impersonation) return null;
  if (ctx.userId) return 'user';
  if (ctx.appId) return 'appKey';
  return null;
}

/**
 * Lapsed-session resume (rulings DA, DI, DY-1, DY-5), evaluated against one
 * database view (`db` is the client or the caller's transaction) for a
 * session that is NOT live:
 *
 *  (i)   open, not deleted, not past a hard `expiresAt` (a promise made at
 *        start is never extended);
 *  (ii)  the session is the caller's OWN, by the `bindSession` rule: a user's
 *        own session (no admin or impersonation resume), or, for a pure App
 *        key (DY-1), a person-less session of that key's App on a worker of
 *        that App. The caller must still be able to drive the worker's App NOW;
 *  (iii) the name: a user must HOLD it (cor:agt:020:09); an App key resumes
 *        only an UNHELD worker, since a held name is a person's;
 *  (iv)  no other session on that worker is live. A scan that hits the cap
 *        refuses rather than decide on a truncated set (#1625 review, P3);
 *  (v)   DY-5: the session is not DORMANT, meaning idle for less than its
 *        App's `sessionDormancyDays`. Past that, no agent act resumes it;
 *        only its human holder's explicit rebind brings the worker back.
 */
async function resumeVerdict(ctx: Context, db: Context['db'], sessionId: string, now: Date): Promise<ResumeVerdict> {
  const principal = resumingPrincipal(ctx);
  if (!principal) return 'REFUSED';
  const s = await db.session.findUnique({ where: { id: sessionId }, select: RESUME_SESSION_SELECT });
  if (
    !s || s.endedAt || s.deletedAt || !s.workerId || !s.worker ||
    (s.expiresAt && s.expiresAt.getTime() <= now.getTime()) ||
    s.worker.retiredAt
  ) return 'REFUSED';
  const owns = principal === 'user'
    ? s.userId === ctx.userId && s.worker.heldByUserId === ctx.userId
    : s.userId === null && s.appId === ctx.appId && s.worker.appId === ctx.appId && s.worker.heldByUserId === null;
  if (!owns) return 'REFUSED';
  if (!(await mayStillDriveWorkerApp({ ...ctx, db } as Context, s.worker.appId))) return 'REFUSED';
  const ownEvent = (await loadLastEventBySession(db as never, [s.id])).get(s.id);
  if (isSessionDormant(s, ownEvent, s.worker.app?.sessionDormancyDays ?? DEFAULT_SESSION_DORMANCY_DAYS, now)) return 'DORMANT';
  const others = await db.session.findMany({
    where: {
      workerId: s.workerId, id: { not: sessionId }, endedAt: null, deletedAt: null,
      ...recentlyTouchedFilter(now),
    },
    orderBy: [{ updatedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
    select: { id: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
    take: OPEN_SESSION_SCAN_CAP + 1,
  });
  if (others.length > OPEN_SESSION_SCAN_CAP) return 'REFUSED';
  const events = await loadLastEventBySession(db as never, others.map((o) => o.id));
  return others.some((o) => isSessionLive(o, events.get(o.id), now)) ? 'REFUSED' : 'OK';
}

/**
 * Lock-free: what WOULD this caller's next act do to this lapsed session?
 * Lets a gate refuse early (and say DORMANT when it is), and lets routing
 * decide. It writes nothing and guarantees nothing: the act itself resumes
 * through {@link resumeOwnLapsedSessionInTx}, which re-decides under the lock.
 */
export async function lapsedResumeVerdict(ctx: Context, sessionId: string): Promise<ResumeVerdict> {
  return resumeVerdict(ctx, ctx.db, sessionId, new Date());
}

/**
 * #1617 B: a lock-free answer to "WOULD this caller's next act resume this
 * lapsed session?". It lets a gate refuse early with SESSION_NOT_LIVE, and lets
 * monitor routing include the worker. It writes nothing and guarantees
 * nothing: the act itself must resume through {@link resumeOwnLapsedSessionInTx},
 * which re-decides under the lock.
 */
export async function mayResumeOwnLapsedSession(ctx: Context, sessionId: string): Promise<boolean> {
  return (await lapsedResumeVerdict(ctx, sessionId)) === 'OK';
}

/**
 * #1617 B: resume a lapsed session INSIDE the transaction of the act that
 * resumes it (#1625 review, Baloo P2-1), so an act refused anywhere later in
 * that transaction rolls the resume back with it. A post resumes in its append
 * transaction and a mark-read in its cursor write, never ahead of them.
 *
 * Fenced by the lifecycle locks a bind takes, in the same order (Baloo P2-2,
 * P2-3): the App `FOR SHARE` (an uninstall or delete waits, or is seen), then
 * the Worker `FOR UPDATE`, which every worker bind also takes, so a bind and a
 * resume of the same worker serialize. Every condition is re-read AFTER the
 * locks, and the write is guarded on the same columns, including the hard
 * expiry, so nothing decided before the lock wait is trusted.
 *
 * Returns false when a condition refuses. A database error propagates: it is
 * a failure of the act, not a business refusal (#1625 review, local P3).
 */
export async function resumeOwnLapsedSessionInTx(
  ctx: Context,
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<boolean> {
  const principal = resumingPrincipal(ctx);
  if (!principal) return false;
  const pre = await tx.session.findUnique({
    where: { id: sessionId },
    select: { userId: true, appId: true, workerId: true, worker: { select: { appId: true } } },
  });
  if (!pre?.workerId || !pre.worker) return false;
  // Refuse foreign refs before taking another tenant's lifecycle locks
  // (#1741, Rook P3). This is only an early rejection: resumeVerdict and the
  // guarded update still re-check ownership after the App/Worker lock wait.
  if (principal === 'user' ? pre.userId !== ctx.userId
    : pre.userId !== null || pre.appId !== ctx.appId || pre.worker.appId !== ctx.appId) return false;
  const [app] = await tx.$queryRaw<Array<{ deleted_at: Date | null; uninstalled_at: Date | null }>>`
    SELECT deleted_at, uninstalled_at FROM apps WHERE id = ${pre.worker.appId} FOR SHARE`;
  if (!app || app.deleted_at || app.uninstalled_at) return false;
  await tx.$queryRaw`SELECT id FROM workers WHERE id = ${pre.workerId} FOR UPDATE`;
  const now = new Date();
  const db = tx as unknown as Context['db'];
  if ((await resumeVerdict(ctx, db, sessionId, now)) !== 'OK') return false;
  const touched = await tx.session.updateMany({
    where: {
      id: sessionId, workerId: pre.workerId, endedAt: null, deletedAt: null,
      // The same ownership the verdict checked, re-guarded on the write.
      ...(ctx.userId ? { userId: ctx.userId } : { userId: null, appId: ctx.appId }),
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { updatedAt: now },
  });
  return touched.count === 1;
}

/** #1617 B: resume in a transaction of its own, for an act (a served read) that has no write to join. */
export async function reviveOwnLapsedSession(ctx: Context, sessionId: string): Promise<boolean> {
  return ctx.db.$transaction((tx) => resumeOwnLapsedSessionInTx(ctx, tx, sessionId));
}

/**
 * #1617 B: the Workers this user could RESUME in this App, meaning a lapsed own
 * session that {@link reviveOwnLapsedSession} would revive on the worker's next
 * attributed act. Monitor-mode routing includes them, so a worker left quiet
 * past its idle window is still woken by a mention. Observing never revives
 * anything: the worker's own read or post does that.
 *
 * Mirrors the revival conditions without the lock; a race that changes the
 * answer costs at most one nudge the worker's own act then refuses.
 */
export async function resumableOwnWorkerIds(
  ctx: Context,
  args: { userId: string; appId: string; workerId?: string; now: Date },
): Promise<Set<string>> {
  const db = ctx.db;
  // (ii)'s eligibility leg (#1625 review, local P3): every candidate is a
  // worker of `appId`, so one participation check covers them all. A driver
  // who lost the App is not routed, just as their act would not resume.
  if (!(await mayStillDriveWorkerApp(ctx, args.appId))) return new Set();
  const rows = await db.session.findMany({
    where: {
      userId: args.userId,
      workerId: args.workerId ?? { not: null },
      endedAt: null,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
      worker: { appId: args.appId, retiredAt: null, heldByUserId: args.userId },
    },
    orderBy: [{ updatedAt: { sort: 'desc' as const, nulls: 'last' as const } }, { startedAt: 'desc' as const }],
    select: {
      id: true, workerId: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true,
      worker: { select: { app: { select: { sessionDormancyDays: true } } } },
    },
    take: OPEN_SESSION_SCAN_CAP,
  });
  // DY-5: a DORMANT session is past what any agent act may resume, so it does
  // not keep its worker routed either. Only a rebind brings that worker back.
  const ownEvents = await loadLastEventBySession(db as never, rows.map((r) => r.id));
  const candidates = [...new Set(
    rows
      .filter((r) => !isSessionDormant(
        r, ownEvents.get(r.id), r.worker?.app?.sessionDormancyDays ?? DEFAULT_SESSION_DORMANCY_DAYS, args.now,
      ))
      .map((r) => r.workerId!)
      .filter(Boolean),
  )];
  if (candidates.length === 0) return new Set();
  // (iv): a worker with ANY live session is not resumed. If that session is
  // the caller's own, the worker is already a live target.
  const live = await db.session.findMany({
    where: {
      workerId: { in: candidates }, endedAt: null, deletedAt: null,
      ...recentlyTouchedFilter(args.now),
    },
    select: { id: true, workerId: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
    take: OPEN_SESSION_SCAN_CAP,
  });
  const events = await loadLastEventBySession(db as never, live.map((l) => l.id));
  const busy = new Set(live.filter((l) => isSessionLive(l, events.get(l.id), args.now)).map((l) => l.workerId!));
  return new Set(candidates.filter((w) => !busy.has(w)));
}

/**
 * Resolve one exact, live, caller-owned Worker session and its owning App. `readOnly` is the re-check under a lock
 * that holds the session row FOR SHARE (#2101, George P2): no heartbeat, since another reader may hold the same row
 * shared while waiting on a lock this caller holds. Resuming a lapsed session is the caller's write, never done here.
 */
async function ownLiveSessionWorker(
  ctx: Context,
  sessionRef: string,
  expectedAppId?: string,
  opts: { readOnly?: boolean } = {},
): Promise<{ workerId: string; appId: string; sessionId: string; lapsed: boolean } | null> {
  await refuseSupersededSession(ctx, sessionRef.trim());
  if (!ctx.userId || ctx.impersonation) return null;
  const session = await ctx.db.session.findFirst({
    where: {
      id: sessionRef.trim(),
      userId: ctx.userId,
      appId: expectedAppId,
      workerId: { not: null },
      endedAt: null,
      deletedAt: null,
      worker: { retiredAt: null },
    },
    select: {
      id: true,
      appId: true,
      workerId: true,
      type: true,
      startedAt: true,
      updatedAt: true,
      autoExpiredAt: true,
      endedAt: true,
      expiresAt: true,
      worker: { select: { appId: true } },
    },
  });
  if (
    !session?.workerId ||
    !session.appId ||
    session.worker?.appId !== session.appId
  ) return null;
  // A historical Session.userId proves who started the Worker, not who may
  // still drive it. Recheck current App participation before a read mutates
  // its cursor, including when the Channel is independently readable.
  const app = await ctx.db.app.findFirst({
    where: { id: session.appId, ...LIVE_APP_WHERE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app || !(await isAppParticipant(ctx, app))) return null;
  const events = await loadLastEventBySession(ctx.db as never, [session.id]);
  if (isSessionLive(session, events.get(session.id), new Date())) {
    // #1540 — a read or mark-read through the session is its driver driving it.
    // Owned, eligible and live are all established above, so keep it alive.
    if (!opts.readOnly) await touchLiveSession(ctx.db, session.id);
    return { workerId: session.workerId, appId: session.appId, sessionId: session.id, lapsed: false };
  }
  // #1617 B — a LAPSED session may be resumed by its holder-driver's act. This
  // only decides that it MAY; the caller resumes it as part of the act itself
  // (#1625 review, Baloo P2-1), so a refused act resumes nothing.
  if (!(await mayResumeOwnLapsedSession(ctx, session.id))) return null;
  return { workerId: session.workerId, appId: session.appId, sessionId: session.id, lapsed: true };
}

/**
 * Advance only a contiguous forward page. A skipped offset, cursor-less tail,
 * backward window, count-only read, or sinceSeq gap is not evidence that the
 * unseen interval was consumed. An unfiltered page moves the read position; an
 * own mentions page moves delivered-through instead (#2018, see
 * {@link advanceOwnMentionsRead}).
 */
export async function maybeAdvanceOwnChannelRead(
  ctx: Context,
  args: {
    channelId: string;
    capturedHead: number;
    sessionRef?: string | null;
    /** Only false defers acknowledgement; session ownership and heartbeat still run. */
    advanceReadState?: boolean | null;
    sinceSeq?: number | null;
    beforeSeq?: number | null;
    mentionsRef?: string | null;
    replyToSeq?: number | null;
    teamHeadRef?: string | null;
    teamHeadRefs?: string[] | null;
    untagged?: boolean | null;
    limit?: number | null;
    offset?: number | null;
    /** #2181: the incarnation the page was pinned to; when set, every effect below runs in ONE fenced transaction. */
    expectedIncarnation?: number | null;
    page: { items: Array<{ seq: number }>; total: number };
  },
): Promise<number | null> {
  const sessionRef = args.sessionRef?.trim() || ctx.sessionId?.trim();
  if (!sessionRef) return null;
  // #1540 (Codex P1 on #1542): EVERY successful read through an owned, live
  // session is its driver driving it, whether or not the page qualifies to
  // advance the cursor below. Resolving the session first runs the keep-alive
  // in `ownLiveSessionWorker` before the eligibility returns, so a driver that
  // reads only newest pages, mention filters or backward windows stays live.
  const session = await ownLiveSessionWorker(ctx, sessionRef);
  if (!session) {
    await recordCheckMiss(ctx.db, { channelId: args.channelId, sessionId: sessionRef, reason: 'SESSION_NOT_OWN_LIVE', via: 'read' });
    return null;
  }
  // #2181: a pinned read decides revive, check stamp and cursor/mentions advance in one transaction behind the
  // incarnation fence. The live-session heartbeat above is the one effect that stays independent of it.
  if (args.expectedIncarnation != null) return advanceOwnChannelReadFenced(ctx, session, args, args.expectedIncarnation);
  // #1617 B — the page has been served, so the read (the act) succeeded:
  // resume now. A refusal under the lock leaves the cursor where it was.
  // Placed BEFORE the #1628 opt-out: a read that declines the cursor advance
  // is still driving the session, so it still resumes it.
  if (session.lapsed && !(await reviveOwnLapsedSession(ctx, session.sessionId))) {
    await recordCheckMiss(ctx.db, { channelId: args.channelId, sessionId: session.sessionId, reason: 'SESSION_REVIVE_REFUSED', via: 'read' });
    return null;
  }
  // #2138 §3.1: a read of the team channel through the worker's OWN session is a check, whatever it returned and
  // whether or not it moves the cursor; another channel's read stamps nothing (stampChannelCheck).
  if (!(await stampChannelCheck(ctx.db, session.workerId, args.channelId))) {
    const why = await diagnoseNoStamp(ctx.db, session.workerId, args.channelId);
    if (why) await recordCheckMiss(ctx.db, { channelId: args.channelId, sessionId: session.sessionId, reason: why, via: 'read' });
  }
  // #1628: attribution is activity even when the caller will acknowledge only
  // after validating and delivering the page. Never skip the heartbeat above.
  if (args.advanceReadState === false) return null;
  // Team-tag and reply-filtered reads are partial windows, never a contiguous tail acknowledgement.
  if (args.replyToSeq != null || args.teamHeadRef != null || (args.teamHeadRefs?.length ?? 0) > 0 || args.untagged != null) return null;
  if (args.mentionsRef) return advanceOwnMentionsRead(ctx, session, args);
  if (args.beforeSeq != null || (args.offset ?? 0) !== 0 || (args.limit ?? 1) <= 0) return null;
  // #1536: no cursor and no offset now selects the newest page. Even when
  // total says it is complete, count and fetch are separate queries: a post
  // between them could make the fetched tail skip earlier unseen messages.
  if (args.sinceSeq == null && args.offset == null) return null;
  return advanceUnfilteredRead(ctx, ctx.db, session.workerId, args);
}

/** The unfiltered-page cursor advance; `db` is the fenced transaction for a pinned read. */
async function advanceUnfilteredRead(
  ctx: Context,
  db: Context['db'],
  workerId: string,
  args: {
    channelId: string; capturedHead: number; sinceSeq?: number | null; offset?: number | null;
    page: { items: Array<{ seq: number }>; total: number };
  },
): Promise<number | null> {
  const view = await resolveRegister(db, { attendee: { workerId }, actor: ctx });
  const row = view?.rows.find((r) => r.channel.id === args.channelId);
  if (!row || row.entry.role === 'POST' || !row.canRead || row.channel.deleted) return null;
  const seen = row.readState?.lastSeenSeq ?? 0;
  if (args.sinceSeq != null && args.sinceSeq > seen) return null;
  const exhausted = args.page.total <= args.page.items.length;
  const visible = args.page.items.reduce((max, item) => Math.max(max, item.seq), seen);
  let through = exhausted ? args.capturedHead : visible;
  // A backfilled pre-#919 Channel can hold DUPLICATE seq values, and a partial
  // page can end midway through one: advancing to it would hide the unread
  // sibling forever (#1362 review, Codex P1). Stop one short when the Channel
  // has more rows at the edge seq than this page returned.
  if (!exhausted && visible > seen && row.channel.hostMemoryId) {
    const returnedAtEdge = args.page.items.filter((item) => item.seq === visible).length;
    const atEdge = await db.node.count({
      where: {
        memoryId: row.channel.hostMemoryId,
        loc: { startsWith: escapePrismaLikePattern(`${row.channel.loc}:messages:`) },
        nodeType: 'chat-message',
        deletedAt: null,
        seq: visible,
      },
    });
    if (atEdge > returnedAtEdge) through = visible - 1;
  }
  through = Math.min(args.capturedHead, through);
  if (through <= seen) return seen;
  return advanceReadState(db as never, { workerId }, args.channelId, through);
}

/**
 * #2181 — a PINNED read's effects, decided in one transaction behind {@link fenceChannelIncarnation}: the lapsed-session
 * revive, the check stamp and the cursor / mentions advance commit together or not at all, so a refused read changes no
 * cursor, mark, stamp or revive. The live-session heartbeat already ran and stays independent.
 */
async function advanceOwnChannelReadFenced(
  ctx: Context,
  session: { workerId: string; appId: string; sessionId: string; lapsed?: boolean },
  args: Parameters<typeof maybeAdvanceOwnChannelRead>[1],
  expected: number,
): Promise<number | null> {
  if (args.advanceReadState !== false && args.replyToSeq == null && args.mentionsRef) {
    return advanceOwnMentionsRead(ctx, session, args, { expected });
  }
  const out = await ctx.db.$transaction(async (tx) => {
    const effects = await fencedCheckEffects(ctx, tx, session, args.channelId, expected);
    if (effects.refused || args.advanceReadState === false) return { effects, advanced: null as number | null };
    const advanced = args.replyToSeq != null || args.beforeSeq != null || (args.offset ?? 0) !== 0 || (args.limit ?? 1) <= 0 || (args.sinceSeq == null && args.offset == null)
      ? null
      : await advanceUnfilteredRead(ctx, tx as never, session.workerId, args);
    return { effects, advanced };
  });
  await recordFencedMisses(ctx, session, args.channelId, out.effects);
  return out.advanced;
}

type FencedEffects = { refused: boolean; stamped: boolean };

/**
 * #2181 — the deciding session check, inside the fenced transaction: a session that was live when the request arrived may
 * have ended while the transaction waited for the Channel row, so it is revalidated here (worker, then session rows
 * FOR SHARE, the lifecycle order the mentions mark uses) before any effect; a lapsed one is resumed here instead.
 */
async function sessionEligibleInTx(
  ctx: Context,
  tx: Prisma.TransactionClient,
  session: { workerId: string; appId: string; sessionId: string; lapsed?: boolean },
): Promise<boolean> {
  if (session.lapsed) return resumeOwnLapsedSessionInTx(ctx, tx, session.sessionId);
  await tx.$queryRaw`SELECT id FROM workers WHERE id = ${session.workerId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${session.sessionId} FOR SHARE`;
  const live = await ownLiveSessionWorker({ ...ctx, db: tx as never }, session.sessionId, session.appId, { readOnly: true });
  return !!live && !live.lapsed && live.workerId === session.workerId;
}

/**
 * Fence, then check (or revive) the session and, unless the caller stamps later, stamp the check, all inside the caller's
 * transaction. `stamp: false` is for a transaction that must take other locks first (the mentions mark takes the worker's
 * wake lock before it touches the read-state row, as every other writer does).
 */
async function fencedCheckEffects(
  ctx: Context,
  tx: Prisma.TransactionClient,
  session: { workerId: string; appId: string; sessionId: string; lapsed?: boolean },
  channelId: string,
  expected: number,
  opts: { stamp?: boolean } = {},
): Promise<FencedEffects> {
  await fenceChannelIncarnation(tx, channelId, expected);
  if (!(await sessionEligibleInTx(ctx, tx, session))) return { refused: true, stamped: false };
  if (opts.stamp === false) return { refused: false, stamped: false };
  return { refused: false, stamped: await stampChannelCheck(tx as never, session.workerId, channelId) };
}

/** The log-only diagnostics for a fenced read, after it committed (never inside the fenced transaction). */
async function recordFencedMisses(
  ctx: Context,
  session: { workerId: string; sessionId: string },
  channelId: string,
  effects: FencedEffects,
): Promise<void> {
  if (effects.refused) {
    await recordCheckMiss(ctx.db, { channelId, sessionId: session.sessionId, reason: 'SESSION_REVIVE_REFUSED', via: 'read' });
  } else if (!effects.stamped) {
    const why = await diagnoseNoStamp(ctx.db, session.workerId, channelId);
    if (why) await recordCheckMiss(ctx.db, { channelId, sessionId: session.sessionId, reason: why, via: 'read' });
  }
}

/**
 * #2018 (S2, D-2026-10-16-001; cor:agt:080:16 as V1 rewrites it): a worker's OWN mentions read counts as delivery of
 * what it returned. It raises delivered-through, and on a mention-only attendance the read position too (ruling A), in
 * one transaction under the worker's wake lock, ONLY when every one of these holds; otherwise nothing moves:
 * - the page was filtered by exactly this worker's reach (`mentionsWorkerOf`, recorded by the read itself);
 * - a forward read: `sinceSeq` given, no `beforeSeq`, offset 0, limit > 0 (the caller checked `advanceReadState`);
 * - the session is still this worker's own live session, and its driver still participates in the App;
 * - the register still gives the worker a readable, non-POST attendance of the channel;
 * - no gap: `sinceSeq` <= max(read, delivered) for this channel's live incarnation, the floor due-ness uses;
 * - a plaintext channel (R13/R43 exclude encrypted team chat from S1/S2), still the incarnation the page was read from;
 * - no ALL-relevance ticker covers a full attendance of the channel: there any message is due (`dueWakes` subAll), so a
 *   mentions page does not cover what is due.
 * It raises to the highest seq the page returned, or to the captured head when the page holds every reaching message
 * above `sinceSeq`, never past the head captured before the read, and one short at a duplicate-seq edge.
 *
 * Decided under the mark's own locks (Dara P2-1 on #2101), the #2102 self-arm fence: the App's authority anchors
 * shared (register writers hold them exclusively), the caller's membership, worker and session rows FOR SHARE (session
 * end), the App's `tickers:` lock shared (ticker create/edit/settings) and its live ticker rows FOR SHARE (subscribe;
 * no ticker writer takes a wake lock), then the wake lock. Every condition is re-read after the wake lock, so a change that committed after the
 * preflight is seen and one that arrives later waits for these marks. The preflight only shapes `through`.
 */
async function advanceOwnMentionsRead(
  ctx: Context,
  session: { workerId: string; appId: string; sessionId: string; lapsed?: boolean },
  args: {
    channelId: string; capturedHead: number; sinceSeq?: number | null; beforeSeq?: number | null;
    limit?: number | null; offset?: number | null; page: { items: Array<{ seq: number }>; total: number };
  },
  /**
   * #2181: a PINNED read. The fence, the lapsed-session revive and the check stamp then run in this method's own
   * transaction (or, when the page does not qualify, in a plain fenced one), so a refused read changes nothing.
   */
  fence?: { expected: number },
): Promise<number | null> {
  const { workerId, appId } = session;
  const bail = async (): Promise<null> => {
    if (!fence) return null;
    const effects = await ctx.db.$transaction((tx) => fencedCheckEffects(ctx, tx, session, args.channelId, fence.expected));
    await recordFencedMisses(ctx, session, args.channelId, effects);
    return null;
  };
  if (mentionsWorkerOf(args.page) !== workerId) return bail();
  if (args.sinceSeq == null || args.beforeSeq != null || (args.offset ?? 0) !== 0 || (args.limit ?? 1) <= 0) return bail();
  const read = await ctx.db.channel.findFirst({
    where: { id: args.channelId, deletedAt: null },
    select: { incarnation: true, memoryId: true, loc: true },
  });
  const app = await ctx.db.app.findUnique({ where: { id: appId }, select: { organizationId: true, ownerUserId: true } });
  if (!read || !app) return bail();
  const exhausted = args.page.total <= args.page.items.length;
  const visible = args.page.items.reduce((max, item) => Math.max(max, item.seq), 0);
  let through = exhausted ? args.capturedHead : visible;
  if (!exhausted && visible > 0) {
    // A duplicate seq at the page edge (a backfilled pre-#919 Channel): stop one short, as the unfiltered path does.
    // Only shapes `through`; whether the worker may read the channel at all is decided under the locks below.
    const returnedAtEdge = args.page.items.filter((item) => item.seq === visible).length;
    const atEdge = await ctx.db.node.count({
      where: {
        memoryId: read.memoryId,
        loc: { startsWith: escapePrismaLikePattern(`${read.loc}:messages:`) },
        nodeType: 'chat-message', deletedAt: null, seq: visible,
      },
    });
    if (atEdge > returnedAtEdge) through = visible - 1;
  }
  through = Math.min(args.capturedHead, through);
  const sinceSeq = args.sinceSeq;
  const anchors: AuthorityAnchor[] = [
    { kind: 'app', id: appId },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    { kind: 'memory', id: read.memoryId },
  ];

  let fencedEffects: FencedEffects | null = null;
  try {
    const advanced = await withAuthorizedTx(ctx, anchors, async () => undefined, async (tx, txCtx) => {
      if (fence) {
        fencedEffects = await fencedCheckEffects(ctx, tx, session, args.channelId, fence.expected, { stamp: false });
        if (fencedEffects.refused) return null;
      }
      if (ctx.userId) {
        await tx.$queryRaw`SELECT user_id FROM app_members WHERE app_id = ${appId} AND user_id = ${ctx.userId} FOR SHARE`;
        if (app.organizationId) {
          await tx.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ${app.organizationId} AND user_id = ${ctx.userId} FOR SHARE`;
        }
      }
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${workerId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${session.sessionId} FOR SHARE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`tickers:${appId}`}, 0))`;
      await tx.$queryRaw`SELECT id FROM tickers WHERE app_id = ${appId} AND deleted_at IS NULL FOR SHARE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + workerId}, 0))`;
      // #2181: the check stamp locks the read-state row, so it comes only after the wake lock (wake lock, then read-state
      // row, as acknowledgeDeliveryBatches and the unpinned mentions mark take them).
      if (fence && fencedEffects) fencedEffects = { refused: false, stamped: await stampChannelCheck(tx as never, workerId, args.channelId) };

      // Read-only: the heartbeat already ran outside (maybeAdvanceOwnChannelRead); an UPDATE of the session row here
      // would wait on another reader's FOR SHARE while that reader waits on this wake lock (George P2 on 8ed33339).
      const live = await ownLiveSessionWorker(txCtx, session.sessionId, appId, { readOnly: true });
      if (!live || live.lapsed || live.workerId !== workerId) return null;
      const view = await resolveRegister(tx as never, { attendee: { workerId }, actor: txCtx });
      const row = view?.rows.find((r) => r.channel.id === args.channelId);
      if (!row || row.entry.role === 'POST' || !row.canRead || row.channel.deleted) return null;
      const channel = await tx.channel.findFirst({
        where: { id: args.channelId, deletedAt: null },
        select: { incarnation: true, memory: { select: { isEncrypted: true } } },
      });
      if (!channel || channel.incarnation !== read.incarnation || channel.memory.isEncrypted) return null;
      if (!row.entry.mentionOnly) {
        const allTicker = await tx.tickerSubscription.findFirst({
          where: {
            workerId, endedAt: null,
            ticker: { deletedAt: null, enabled: true, relevance: { not: 'MENTIONS' }, OR: [{ channelIds: { isEmpty: true } }, { channelIds: { has: args.channelId } }] },
          },
          select: { id: true },
        });
        if (allTicker) return null;
      }
      const d = await tx.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId, channelId: args.channelId } } });
      const delivered = d && d.channelIncarnation === channel.incarnation ? d.deliveredThroughSeq : 0;
      const seen = (await tx.channelReadState.findFirst({ where: { workerId, channelId: args.channelId }, select: { lastSeenSeq: true } }))?.lastSeenSeq ?? 0;
      if (sinceSeq > Math.max(seen, delivered)) return null;
      if (through <= delivered) return seen;
      const s = await tx.session.findUnique({ where: { id: session.sessionId }, select: { userId: true } });
      await raiseDeliveryMark(tx, { workerId, channelId: args.channelId, incarnation: channel.incarnation, through }, toNaiveUtc(new Date()), {
        ackedByUserId: s?.userId ?? ctx.userId ?? null, ackedByWorkerId: workerId, ackedByAppKeyId: null,
      });
      await raiseReadIfMentionOnly(tx, { workerId, channelId: args.channelId, through });
      return (await tx.channelReadState.findFirst({ where: { workerId, channelId: args.channelId }, select: { lastSeenSeq: true } }))?.lastSeenSeq ?? seen;
    });
    if (fencedEffects) await recordFencedMisses(ctx, session, args.channelId, fencedEffects);
    return advanced;
  } catch (e) {
    // Authority gone under the anchors (an App, org, memory or user deleted): the page stands, no mark moves.
    if (e instanceof Error && e.message === 'Forbidden') return null;
    throw e;
  }
}

export async function markOwnTeamChatRead(
  ctx: Context,
  args: { appRef: string; channelRef?: string | null; sessionRef: string; seq: number; expectedIncarnation?: number | null },
): Promise<{ workerId: string; channelId: string; lastSeenSeq: number; channelIncarnation: number; cursorIncarnation: number | null }> {
  const app = await resolvePilotApp(ctx, args.appRef);
  const session = await ownLiveSessionWorker(ctx, args.sessionRef, app.id);
  if (!session) {
    // DY-5: say so when the reason is dormancy, keeping the code clients rebind on.
    if ((await lapsedResumeVerdict(ctx, args.sessionRef.trim())) === 'DORMANT') {
      fail(
        'That session is DORMANT: idle past its App\'s dormancy threshold, so no agent act resumes it. ' +
          'Its holder must start a new session for this worker.',
        'SESSION_NOT_LIVE',
        { reason: 'DORMANT' },
      );
    }
    fail('That session is not one of your live Worker sessions in this App.', 'SESSION_NOT_LIVE');
  }
  const { workerId } = session;
  // The caller names the Channel. The MCP tool resolves an OMITTED channel to
  // the one its convenience read serves (locateTeamChatChannel), which need
  // not be App.defaultChannel; defaulting to that here marked the wrong
  // Channel after a read of the other one (#1362 review, Copilot).
  const channelRef = args.channelRef?.trim();
  const channelId = channelRef ? await resolveChannelRefId(ctx.db, channelRef) : null;
  if (!channelId) fail('No readable registered Channel matches.', 'CHANNEL_NOT_FOUND');
  const view = await resolveRegister(ctx.db, { attendee: { workerId }, actor: ctx });
  const row = view?.rows.find((r) => r.channel.id === channelId);
  if (!row || row.entry.role === 'POST' || !row.canRead || row.channel.deleted) {
    fail('No readable registered Channel matches.', 'CHANNEL_NOT_FOUND');
  }
  if (!Number.isInteger(args.seq) || args.seq < 0) fail('seq must be a non-negative integer.', 'BAD_USER_INPUT');
  // A pinned mark decides the watermark under the Channel lock (below), after the incarnation compare, so a recreated
  // Channel's lower watermark cannot turn a stale mark into SEQ_BEYOND_WATERMARK.
  if (args.expectedIncarnation == null && args.seq > row.channel.lastSeq) {
    fail(`seq ${args.seq} is beyond the Channel watermark (${row.channel.lastSeq}).`, 'SEQ_BEYOND_WATERMARK', { lastSeq: row.channel.lastSeq });
  }
  // #2181: a PINNED mark decides everything in one transaction behind the Channel-row fence: the register right and the
  // watermark are re-read under the lock, the lapsed session resumes, the cursor moves and the check is stamped, or
  // nothing happens. An OMITTED expectedIncarnation keeps the unfenced path below (documented, not a safe mode).
  if (args.expectedIncarnation != null) {
    const expected = args.expectedIncarnation;
    const done = await ctx.db.$transaction(async (tx) => {
      await fenceChannelIncarnation(tx, row.channel.id, expected);
      const locked = await resolveRegister(tx as never, { attendee: { workerId }, actor: ctx });
      const lockedRow = locked?.rows.find((r) => r.channel.id === channelId);
      if (!lockedRow || lockedRow.entry.role === 'POST' || !lockedRow.canRead || lockedRow.channel.deleted) {
        fail('No readable registered Channel matches.', 'CHANNEL_NOT_FOUND');
      }
      if (args.seq > lockedRow.channel.lastSeq) {
        fail(`seq ${args.seq} is beyond the Channel watermark (${lockedRow.channel.lastSeq}).`, 'SEQ_BEYOND_WATERMARK', { lastSeq: lockedRow.channel.lastSeq });
      }
      if (!(await sessionEligibleInTx(ctx, tx, session))) {
        fail('That session is not one of your live Worker sessions in this App.', 'SESSION_NOT_LIVE');
      }
      const lastSeenSeq = await advanceReadState(tx as never, { workerId }, row.channel.id, args.seq);
      const stamped = await stampChannelCheck(tx as never, workerId, row.channel.id);
      const label = await tx.$queryRaw<Array<{ channel_incarnation: number | null }>>`
        SELECT channel_incarnation FROM channel_read_states WHERE worker_id = ${workerId} AND channel_id = ${row.channel.id}`;
      return { lastSeenSeq, stamped, cursorIncarnation: label[0]?.channel_incarnation ?? null };
    });
    if (!done.stamped) {
      const why = await diagnoseNoStamp(ctx.db, workerId, row.channel.id);
      if (why) await recordCheckMiss(ctx.db, { channelId: row.channel.id, sessionId: session.sessionId, reason: why, via: 'mark' });
    }
    return { workerId, channelId: row.channel.id, lastSeenSeq: done.lastSeenSeq, channelIncarnation: expected, cursorIncarnation: done.cursorIncarnation };
  }
  // #1617 B — a lapsed session resumes in the SAME transaction as the cursor
  // write (#1625 review, Baloo P2-1): both commit, or neither does.
  const lastSeenSeq = session.lapsed
    ? await ctx.db.$transaction(async (tx) => {
        if (!(await resumeOwnLapsedSessionInTx(ctx, tx, session.sessionId))) {
          fail('That session is not one of your live Worker sessions in this App.', 'SESSION_NOT_LIVE');
        }
        return advanceReadState(tx as never, { workerId }, row.channel.id, args.seq);
      })
    : await advanceReadState(ctx.db, { workerId }, row.channel.id, args.seq);
  // #2138 §3.1: a mark-read through the worker's own session is a check (even one that moves nothing). Stamped last, so a
  // refused call above, or a resume refused inside its transaction, is not one.
  if (!(await stampChannelCheck(ctx.db, workerId, row.channel.id))) {
    const why = await diagnoseNoStamp(ctx.db, workerId, row.channel.id);
    if (why) await recordCheckMiss(ctx.db, { channelId: row.channel.id, sessionId: session.sessionId, reason: why, via: 'mark' });
  }
  const state = await readStateIncarnations(ctx.db, { workerId }, row.channel.id);
  return { workerId, channelId: row.channel.id, lastSeenSeq, ...state };
}
