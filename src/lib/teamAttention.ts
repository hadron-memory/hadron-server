/**
 * #1353 — worker-owned team-chat attention for the internal router pilot.
 *
 * The poll token is a signed, actor/App-bound snapshot. It NEVER advances
 * ChannelReadState. A router adopts the returned token only after every
 * listed nudge has been accepted; retaining the previous token after a
 * partial failure deliberately causes duplicates rather than loss.
 *
 * The feature is open to every ordinary user principal; what bounds it is
 * the caller's own live Worker session and current App participation. This
 * matters for `maybeAdvanceOwnChannelRead`: without a matching session an
 * ordinary transcript read is byte-for-byte the old read-only act.
 */

import { sessionKeyReleasedHint } from './sessionKeyCache.js';
import { createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { isAppParticipant } from '../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedTx } from '../api/graphql/schema/authorizedTx.js';
import type { AuthorityAnchor } from './auth/authorityAnchors.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { AppNotFoundError } from './entityRef/errors.js';
import { resolveChannelRefId } from './entityRef/channelRef.js';
import { composeWorkerUrn } from './entityRef/workerRef.js';
import { normalizeUrnForLookup } from './urn.js';
import { resolveRegister } from './resolveRegister.js';
import { advanceReadState, diagnoseNoStamp, readStateIncarnations, recordCheckMiss, stampChannelCheck } from './channelReadState.js';
import { raiseDeliveryMark, raiseReadIfMentionOnly } from './workerMarks.js';
import { mentionsWorkerOf } from './mentionsReadResolution.js';
import { mentionTokenOf } from './mentionToken.js';
import { mentionReach, mentionReachSql, reachEnvelopeOf } from './mentionReach.js';
import { escapePrismaLikePattern } from './literalLocPrefix.js';
import { safeEqual } from './constantTime.js';
import { decryptNodeFields } from './nodeCrypto.js';
import {
  maskEmpty, maskGet, maskSet, scopeDigest, signPageToken, verifyPageToken,
  MAX_PAGE_TOKEN_CHARS, PAGE_RESULT_PAIRS_DEFAULT, PAGE_RESULT_PAIRS_MAX,
  PAGE_SCAN_ROW_BUDGET_DEFAULT, PAGE_SCAN_ROW_BUDGET_MAX,
  type PageContinuation,
} from './teamAttentionPage.js';
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

// #1496: aligned with MAX_TARGETS/OPEN_SESSION_SCAN_CAP as the single scope
// guard. The v1 value (20) guarded per-REQUEST work; the paged v2 bounds
// work with limit/scanLimit, so a live Worker now costs one continuation
// dictionary entry and one freeze-time register read. A 23-live-Worker team
// is the production shape that the v1 cap refused outright (#4678).
const MAX_WORKERS = 200;
const MAX_TARGETS = 200;

/** #1496 test surface: the scope-guard constants, so tests pin their
 * alignment with OPEN_SESSION_SCAN_CAP (one guard, one value). */
export const MAX_WORKERS_PUBLIC = MAX_WORKERS;
export const MAX_TARGETS_PUBLIC = MAX_TARGETS;
const MAX_TOKEN_CHARS = 65_536;
const SWITCHOVER_PROOF_TTL_MS = 10 * 60 * 1000;
const ENCRYPTED_MESSAGE_PAGE_SIZE = 50;
/** #1779 — plaintext Channels are counted by per-target aggregate SQL over a
 * bounded seq window, not by streaming rows through JS. Their cost is one
 * indexed range query (no decryption), so they do not spend the decrypted-row
 * budget; the work one request can do is still bounded and still scales with
 * the caller's `scanLimit` (Codex P1 on #1428: an unbounded aggregate is
 * row-linear server work): each budget unit buys this many plaintext seqs per
 * Channel visit, and twice that per request. At the default 50 that is a
 * 10,000-seq window and 20,000 per request; a deeper backlog continues on the
 * next page. */
const PLAINTEXT_SEQS_PER_BUDGET_UNIT = 200;
const PLAINTEXT_REQUEST_WINDOWS = 2;

type AppRow = {
  id: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  defaultChannelId: string | null;
};

type LiveWorker = {
  id: string;
  name: string;
  urn: string | null;
};

type Target = {
  workerId: string;
  workerName: string;
  workerUrn: string | null;
  channelId: string;
  channelName: string;
  channelLoc: string;
  memoryId: string;
  registerId: string;
  mentionOnly: boolean;
  seen: number;
  head: number;
  mentionTokens: string[];
};

type AttentionSnapshot = {
  v: 1;
  kind: 'team-attention';
  appId: string;
  userId: string;
  workers: Array<{
    workerId: string;
    channels: Array<{
      channelId: string;
      registerId: string;
      mentionOnly: boolean;
      head: number;
    }>;
  }>;
};

type SwitchoverProof = {
  v: 1;
  kind: 'team-attention-switchover';
  appId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  targets: Array<{
    workerId: string;
    channelId: string;
    registerId: string;
    mentionOnly: boolean;
    from: number;
    through: number;
  }>;
};

type SignedPayload = AttentionSnapshot | SwitchoverProof;

export type TeamAttentionChannel = {
  channel: string;
  name: string;
  unread: number;
  unreadMentions: number;
  firstUnreadSeq: number | null;
  lastSeq: number;
};

export type TeamAttentionWorker = {
  worker: string;
  name: string;
  urn: string | null;
  live: true;
  channels: TeamAttentionChannel[];
};

export type TeamAttentionResult = {
  token: string;
  workers: TeamAttentionWorker[];
};

export type TeamAttentionSwitchoverWorker = {
  worker: string;
  name: string;
  urn: string | null;
  channels: Array<{
    channel: string;
    name: string;
    fromSeq: number;
    throughSeq: number;
    unread: number;
    unreadMentions: number;
  }>;
};

export type TeamAttentionSwitchoverPreview = {
  proof: string;
  expiresAt: Date;
  workers: TeamAttentionSwitchoverWorker[];
};

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

function tokenSigningKey(): Buffer {
  const secret = process.env.TEAM_ATTENTION_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) fail('The team-attention token signer is not configured.', 'TEAM_ATTENTION_NOT_CONFIGURED');
  // A deployment may intentionally fall back to JWT_SECRET, but tokens in
  // this protocol must not share the JWT signing domain. The derived key also
  // gives future team-attention formats an explicit version boundary.
  return createHmac('sha256', secret).update('hadron/team-attention/v1').digest();
}

/** The raw secret behind `tokenSigningKey`, for the v2 paged-attention codec
 * (its own HMAC domain derivation lives in teamAttentionPage.ts). */
export function attentionTokenSecret(): string {
  const secret = process.env.TEAM_ATTENTION_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) fail('The team-attention token signer is not configured.', 'TEAM_ATTENTION_NOT_CONFIGURED');
  return secret;
}

function sign(payload: SignedPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', tokenSigningKey()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verify(token: string): SignedPayload {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  }
  const parts = token.split('.');
  if (parts.length !== 2) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  const [body, supplied] = parts;
  const expected = createHmac('sha256', tokenSigningKey()).update(body).digest('base64url');
  if (!safeEqual(supplied, expected)) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SignedPayload>;
    if (
      value.v !== 1 ||
      (value.kind !== 'team-attention' && value.kind !== 'team-attention-switchover') ||
      typeof value.appId !== 'string' ||
      typeof value.userId !== 'string'
    ) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
    return value as SignedPayload;
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
  }
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

async function resolvePilotApp(ctx: Context, appRef: string): Promise<AppRow> {
  if (!ctx.userId || ctx.impersonation) fail('Team attention is available only to an ordinary user.', 'FORBIDDEN');
  let id: string;
  try {
    ({ id } = await resolveAppRef(ctx.db, appRef));
  } catch (error) {
    if (error instanceof AppNotFoundError) fail('App not found.', 'APP_NOT_FOUND');
    throw error;
  }
  const app = await ctx.db.app.findFirst({
    where: { id, ...LIVE_APP_WHERE },
    select: { id: true, urn: true, organizationId: true, ownerUserId: true, defaultChannelId: true },
  });
  // Existing-but-unreadable and absent Apps are indistinguishable.
  if (!app || !(await isAppParticipant(ctx, app))) fail('App not found.', 'APP_NOT_FOUND');
  // #1353: the two-dimensional pilot allowlist that used to refuse here is
  // removed; every guard around it — ordinary non-impersonated user, live
  // App/org, current participation, concealment parity — stays.
  return app;
}

/**
 * Whether `resolvePilotApp` would admit this caller and App — the SAME checks,
 * as a boolean, for the capability probe (#1362 review, Codex P2): advertising
 * on the allowlists alone would have claimed the capability for an App that had
 * since been uninstalled, deleted or left.
 */
export async function teamAttentionAvailable(ctx: Context, appId: string): Promise<boolean> {
  if (!ctx.userId || ctx.impersonation) return false;
  const app = await ctx.db.app.findFirst({
    where: { id: appId, ...LIVE_APP_WHERE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  return !!app && (await isAppParticipant(ctx, app));
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

async function liveOwnWorkers(ctx: Context, app: AppRow): Promise<LiveWorker[]> {
  const now = new Date();
  const rows = await ctx.db.session.findMany({
    where: {
      userId: ctx.userId!,
      appId: app.id,
      workerId: { not: null },
      endedAt: null,
      deletedAt: null,
      worker: { appId: app.id, retiredAt: null },
      ...recentlyTouchedFilter(now),
    },
    orderBy: [{ updatedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
    select: {
      id: true,
      type: true,
      startedAt: true,
      updatedAt: true,
      autoExpiredAt: true,
      endedAt: true,
      expiresAt: true,
      worker: { select: { id: true, name: true, slug: true } },
    },
    take: OPEN_SESSION_SCAN_CAP + 1,
  });
  if (rows.length > OPEN_SESSION_SCAN_CAP) {
    fail(`More than ${OPEN_SESSION_SCAN_CAP} recent Worker sessions match.`, 'TEAM_ATTENTION_SCOPE_TOO_LARGE');
  }
  const events = await loadLastEventBySession(ctx.db as never, rows.map((r) => r.id));
  const byId = new Map<string, LiveWorker>();
  for (const row of rows) {
    if (!row.worker || !isSessionLive(row, events.get(row.id), now)) continue;
    let urn: string | null = null;
    try {
      urn = composeWorkerUrn(normalizeUrnForLookup(app.urn), row.worker.slug);
    } catch {
      urn = null;
    }
    byId.set(row.worker.id, { id: row.worker.id, name: row.worker.name, urn });
  }
  // #1617 B: a worker whose own session merely LAPSED is still routed — its
  // next read or post resumes it — so a quiet night does not make it unwakeable.
  const resumable = [...(await resumableOwnWorkerIds(ctx, { userId: ctx.userId!, appId: app.id, now }))]
    .filter((id) => !byId.has(id));
  if (resumable.length > 0) {
    const resumed = await ctx.db.worker.findMany({
      where: { id: { in: resumable } },
      select: { id: true, name: true, slug: true },
    });
    for (const w of resumed) {
      let urn: string | null = null;
      try {
        urn = composeWorkerUrn(normalizeUrnForLookup(app.urn), w.slug);
      } catch {
        urn = null;
      }
      byId.set(w.id, { id: w.id, name: w.name, urn });
    }
  }
  const workers = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (workers.length > MAX_WORKERS) fail(`More than ${MAX_WORKERS} live Workers match.`, 'TEAM_ATTENTION_SCOPE_TOO_LARGE');
  return workers;
}

async function attentionTargets(ctx: Context, app: AppRow): Promise<Target[]> {
  const workers = await liveOwnWorkers(ctx, app);
  const targets: Target[] = [];
  for (const worker of workers) {
    const view = await resolveRegister(ctx.db, { attendee: { workerId: worker.id }, actor: ctx });
    for (const row of view?.rows ?? []) {
      if (row.entry.role === 'POST' || !row.canRead || row.channel.deleted || !row.channel.hostMemoryId) continue;
      const token = mentionTokenOf(worker.name);
      targets.push({
        workerId: worker.id,
        workerName: worker.name,
        workerUrn: worker.urn,
        channelId: row.channel.id,
        channelName: row.channel.name,
        channelLoc: row.channel.loc,
        memoryId: row.channel.hostMemoryId,
        registerId: row.entry.id,
        mentionOnly: row.entry.mentionOnly,
        seen: row.readState?.lastSeenSeq ?? 0,
        head: row.channel.lastSeq,
        // #2020: the worker's own token only — a broadcast counts through the
        // post-time stamp (mentionReach), never by its token alone.
        mentionTokens: token ? [token] : [],
      });
    }
  }
  targets.sort((a, b) => a.workerId.localeCompare(b.workerId) || a.channelLoc.localeCompare(b.channelLoc) || a.channelId.localeCompare(b.channelId));
  if (targets.length > MAX_TARGETS) fail(`More than ${MAX_TARGETS} Worker/Channel targets match.`, 'TEAM_ATTENTION_SCOPE_TOO_LARGE');
  return targets;
}

/** One row fetched by the paged scan's inner SELECT — already filtered to
 * live chat-messages of the one Channel (the partial-index predicate), so the
 * row budget counts exactly the rows examined. */
type EncryptedCandidateRow = {
  memory_id: string;
  seq: number;
  loc: string;
  data: unknown;
};

function decryptRoutingEnvelope(candidate: EncryptedCandidateRow): Record<string, unknown> {
  try {
    const decrypted = decryptNodeFields(
      { data: candidate.data },
      { id: candidate.memory_id, isEncrypted: true },
    );
    return (decrypted.data && typeof decrypted.data === 'object')
      ? decrypted.data as Record<string, unknown>
      : {};
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SESSION_EXPIRED')) {
      fail(`SESSION_EXPIRED: memory ${candidate.memory_id} is encrypted but no active session key is available. ${sessionKeyReleasedHint()}`, 'SESSION_EXPIRED', { memoryId: candidate.memory_id });
    }
    throw error;
  }
}

// ── #1384/#1421 paged (v2) scan engine ───────────────────────────────────────
//
// The retired v1 poll decrypted an encrypted Channel's whole unread backlog
// inside one request (its doors now answer UPGRADE_REQUIRED; the exhaustive
// unreadCounts loop is deleted). The v2 engine below performs a bounded
// amount of work per call and hands the private progress back in a signed
// continuation (codec in teamAttentionPage.ts). In-memory state mirrors the
// continuation payload; entry/exit points serialize it. Channels are indexed
// in sorted-id order so the round-robin schedule is deterministic across
// pulls.

/** Mutable scan state, isomorphic to the signed continuation payload. */
export interface PagedScanState {
  /** Channel index → frozen span [cMin, cMax] over its targets. */
  cMin: number[];
  cMax: number[];
  /** Seq-first keyset cursor per channel: (seq, locSuffix). seq -1 = not
   * started. The scan walks (message_channel_id, seq, loc) on the partial
   * C-collation index — the seq range IS the frozen bound (post-freeze
   * rows have seq > cMax and cannot enter the range; no separate
   * frozen-upper-loc lookup needed). */
  cCursorSeq: number[];
  cCursorLoc: string[];
  /** Last COUNTED-message suffix ('' until one counted) — the stale-frontier
   * check row, independent of the raw cursor (#1430 decoupling). */
  cFrontNum: string[];
  /** Channel index → frozen incarnation, compared on every resume (#3111). */
  cInc: number[];
  cDone: boolean[];
  /** Target index → private partial accumulators (never surfaced as exact
   * until the target's channel is done and the item is emitted). */
  aUnread: number[];
  aMent: number[];
  aFirst: number[]; // 0 = none seen yet
  aLast: number[]; // 0 = none
  /** Target indices awaiting delivery, in completion-visit order. */
  pending: number[];
  emitted: boolean[];
  /** Round-robin scheduler position (channel index). */
  next: number;
}

type PlaintextTarget = {
  index: number;
  seen: number;
  head: number;
  workerId: string;
  mentionOnly: boolean;
  tokens: string[];
};

type PlaintextWindowResult = {
  perTarget: Array<{
    index: number;
    unread: number;
    mentions: number;
    first: number;
    lastRelevant: number | null;
  }>;
  /** Last row of the window (seq, then C-collated loc) — the keyset position. */
  cursor: { seq: number; loc: string } | null;
  /** Loc of a row at the highest seq any target counted — the stale-frontier check row. */
  frontierLoc: string | null;
};

/**
 * #1779 — the counts the row walk produced, computed in the database.
 *
 * For one plaintext Channel and the seq window (lo, hi], each target's unread
 * is the rows above ITS seen cursor and at or below ITS frozen head, skipping
 * its own posts; a row mentions it when it reaches it (#2020: one of its tokens,
 * or a broadcast stamped at post time — `mentionReachSql`, the twin of the
 * row walk's `mentionReach`). The ranges are the
 * ones the walk already used, so this reads nothing it did not: only integer
 * aggregates leave SQL, never a message body, and a target is counted against
 * its own register's cursor and head alone.
 */
export async function aggregatePlaintextWindow(
  db: Context['db'],
  channelId: string,
  lo: number,
  hi: number,
  targets: PlaintextTarget[],
): Promise<PlaintextWindowResult> {
  // A VALUES list needs a row: with no targets there is nothing to count.
  if (targets.length === 0) return { perTarget: [], cursor: null, frontierLoc: null };
  const values = Prisma.join(
    targets.map((t) => Prisma.sql`(${t.index}::int, ${t.seen}::int, ${t.head}::int, ${t.workerId}::text, ${t.mentionOnly}::boolean, ${t.tokens}::text[])`),
  );
  const rows = await db.$queryRaw<Array<{
    idx: number; unread: number; mentions: number; first_seq: number; last_relevant: number | null; last_counted: number;
  }>>(Prisma.sql`
    WITH t(idx, seen, head, worker_id, mention_only, tokens) AS (VALUES ${values}),
    m AS (
      SELECT n.seq::int AS seq, n.data
      FROM nodes n
      WHERE n.message_channel_id = ${channelId}
        AND n.node_type = 'chat-message'
        AND n.deleted_at IS NULL
        AND n.seq > ${lo}
        AND n.seq <= ${hi}
    ),
    j AS (
      SELECT t.idx, t.mention_only, m.seq,
        ${mentionReachSql(Prisma.sql`m.data`, Prisma.sql`t.tokens`, Prisma.sql`ARRAY[t.worker_id]::text[]`)} AS mentioned
      FROM m
      JOIN t ON m.seq > t.seen AND m.seq <= t.head
        AND COALESCE(m.data ->> 'authorWorkerId', '') <> t.worker_id
    )
    SELECT idx,
      count(*)::int AS unread,
      (count(*) FILTER (WHERE mentioned))::int AS mentions,
      min(seq)::int AS first_seq,
      (max(seq) FILTER (WHERE NOT mention_only OR mentioned))::int AS last_relevant,
      max(seq)::int AS last_counted
    FROM j
    GROUP BY idx
  `);
  const last = await db.$queryRaw<Array<{ seq: number; loc: string }>>(Prisma.sql`
    SELECT n.seq::int AS seq, n.loc
    FROM nodes n
    WHERE n.message_channel_id = ${channelId}
      AND n.node_type = 'chat-message'
      AND n.deleted_at IS NULL
      AND n.seq > ${lo}
      AND n.seq <= ${hi}
    ORDER BY n.seq DESC, n.loc COLLATE "C" DESC
    LIMIT 1
  `);
  let frontierLoc: string | null = null;
  const frontierSeq = rows.reduce((m, r) => Math.max(m, r.last_counted), 0);
  if (frontierSeq > 0) {
    // The row walk only advanced its counted frontier on a row some target
    // COUNTED; with duplicate seqs (pre-#919) the highest loc at that seq can be
    // an uncounted own post, so pick the highest-loc row a target counted.
    const found = await db.$queryRaw<Array<{ loc: string }>>(Prisma.sql`
      WITH t(idx, seen, head, worker_id) AS (VALUES ${Prisma.join(
        targets.map((t) => Prisma.sql`(${t.index}::int, ${t.seen}::int, ${t.head}::int, ${t.workerId}::text)`),
      )})
      SELECT n.loc FROM nodes n
      WHERE n.message_channel_id = ${channelId}
        AND n.node_type = 'chat-message'
        AND n.deleted_at IS NULL
        AND n.seq = ${frontierSeq}
        AND EXISTS (
          SELECT 1 FROM t
          WHERE n.seq > t.seen AND n.seq <= t.head
            AND COALESCE(n.data ->> 'authorWorkerId', '') <> t.worker_id
        )
      ORDER BY n.loc COLLATE "C" DESC
      LIMIT 1
    `);
    frontierLoc = found[0]?.loc ?? null;
  }
  return {
    perTarget: rows.map((r) => ({
      index: r.idx, unread: r.unread, mentions: r.mentions, first: r.first_seq, lastRelevant: r.last_relevant,
    })),
    cursor: last[0] ?? null,
    frontierLoc,
  };
}

/** One bounded work step. `budget` is the GLOBAL decrypted-row allowance for
 * this request; plaintext channels complete in one aggregate visit without
 * charging the budget (their cost is one indexed query, not row decryption).
 * Returns the number of decrypted rows consumed. */
async function pagedScanStep(
  db: Context['db'],
  targets: Target[],
  channelIndexOf: Map<string, number>,
  /** Channel index → live geometry rehydrated this pull; plaintext channels
   * aggregate in bounded seq windows (row-linear SQL work would otherwise
   * escape the request budget — Codex P1 on #1428). */
  channelGeometry: Map<number, { memoryId: string; locPrefix: string; encrypted: boolean; channelId: string }>,
  mentionTokensByTarget: string[][],
  state: PagedScanState,
  budget: number,
): Promise<number> {
  const channelCount = state.cDone.length;
  const targetsOfChannel = new Map<number, number[]>();
  targets.forEach((_t, i) => {
    const c = channelIndexOf.get(targets[i].channelId)!;
    const list = targetsOfChannel.get(c) ?? [];
    list.push(i);
    targetsOfChannel.set(c, list);
  });

  let spent = 0;
  let plainSpent = 0;
  let visits = 0;
  // Guard against a pathological loop when channels keep drifting away: a
  // full lap that only retires vanished channels still counts as visits.
  while (spent < budget && visits < channelCount * 2) {
    visits++;
    // Advance to the next not-done channel, round-robin; stop when a full
    // lap finds only done channels.
    let k = -1;
    for (let step = 0; step < channelCount; step++) {
      const candidate = (state.next + step) % channelCount;
      if (!state.cDone[candidate]) { k = candidate; break; }
    }
    if (k === -1) break;
    state.next = (k + 1) % channelCount;

    const geometry = channelGeometry.get(k);
    if (!geometry) {
      state.cDone[k] = true;
      continue;
    }
    if (!geometry.encrypted) {
      // #1779 — plaintext Channel: aggregate a bounded seq window in SQL.
      const plainWindow = budget * PLAINTEXT_SEQS_PER_BUDGET_UNIT;
      const plainRequest = plainWindow * PLAINTEXT_REQUEST_WINDOWS;
      if (plainSpent >= plainRequest) continue; // ceiling reached; resume next page
      const list = targetsOfChannel.get(k) ?? [];
      if (list.length === 0) { state.cDone[k] = true; continue; } // no target to count for
      const lo = state.cCursorSeq[k] === -1 ? state.cMin[k] : Math.max(state.cCursorSeq[k], state.cMin[k]);
      const hi = Math.min(state.cMax[k], lo + Math.min(plainWindow, plainRequest - plainSpent));
      if (hi > lo) {
        const aggregated = await aggregatePlaintextWindow(db, geometry.channelId, lo, hi, list.map((ti) => ({
          index: ti, seen: targets[ti].seen, head: targets[ti].head, workerId: targets[ti].workerId,
          mentionOnly: targets[ti].mentionOnly, tokens: mentionTokensByTarget[ti],
        })));
        for (const row of aggregated.perTarget) {
          state.aUnread[row.index] += row.unread;
          state.aMent[row.index] += row.mentions;
          state.aFirst[row.index] = state.aFirst[row.index] === 0 ? row.first : Math.min(state.aFirst[row.index], row.first);
          if (row.lastRelevant != null) state.aLast[row.index] = Math.max(state.aLast[row.index], row.lastRelevant);
        }
        // Keep the keyset cursor valid should this Channel turn encrypted
        // mid-scan, and the counted frontier valid for the resume check.
        state.cCursorSeq[k] = aggregated.cursor?.seq ?? hi;
        state.cCursorLoc[k] = aggregated.cursor ? aggregated.cursor.loc.slice(geometry.locPrefix.length) : '';
        if (aggregated.frontierLoc) state.cFrontNum[k] = aggregated.frontierLoc.slice(geometry.locPrefix.length);
        plainSpent += hi - lo;
      }
      if (hi >= state.cMax[k]) {
        state.cDone[k] = true;
        list.sort((a, b) => targets[a].workerId.localeCompare(targets[b].workerId));
        state.pending.push(...list);
      }
      continue;
    }
    // Fairness quantum (#3051 finding 7): no single channel may consume the
    // whole request budget — each active channel gets at most an equal share
    // of the remaining budget per visit, so 200 backlogged channels each get
    // a visit within ceil(active / floor(budget / active)) rounds (≤4 pulls
    // at the contract's 50/200 numbers), instead of the first channel eating
    // all 50 rows and the last waiting 200 pulls.
    const activeChannels = state.cDone.filter((done) => !done).length;
    const share = Math.max(1, Math.floor((budget - spent) / Math.max(1, activeChannels)));
    const take = Math.min(budget - spent, share, ENCRYPTED_MESSAGE_PAGE_SIZE);
    const prefix = geometry.locPrefix;
    // #1430 seq-first scan on the partial (message_channel_id, seq, loc C)
    // index. The inner SELECT carries the index predicate VERBATIM
    // (node_type / deleted_at; `seq > cMin` proves seq IS NOT NULL), so the
    // planner can use nodes_msg_channel_seq_loc_c_idx as the access path —
    // without predicate proof it must scan/sort the wider nodes table despite
    // the LIMIT (Andi #3277; Chip's #3282 EXPLAIN measured 20k rows examined
    // for LIMIT 2 when the predicate was applied only in JS). The frozen seq
    // range IS the bound: post-freeze rows (seq > cMax) cannot enter the
    // index range, so sustained traffic cannot prevent completion. The
    // (seq, loc) keyset handles duplicate seqs; loc order inversions
    // (999/1000) are irrelevant because seq leads. Every RETURNED row has
    // passed every predicate, so examined work per page is ≤ take (the only
    // extra rows the index walk can touch are same-seq duplicates at the
    // cursor's seq — a finite pre-#919 artifact, paid once per step).
    const cursorLoc = state.cCursorLoc[k] ? prefix + state.cCursorLoc[k] : '';

    // Continuation keyset as TWO single-range index descents (Chip #3305):
    // a disjunctive `(seq > cs OR (seq = cs AND loc > cl))` cannot become a
    // btree bound, so the planner kept the cursor as a FILTER over
    // `seq > cMin` — a continuation after seq 9000 re-examined all 9,000
    // already-scanned rows (measured: 231 buffer hits for LIMIT 2). Each
    // UNION arm is one clean range on (message_channel_id, seq, loc C) —
    // arm 1 the duplicate-seq remainder at the cursor's seq, arm 2 the rest
    // of the frozen span — so the cursor participates as an Index Cond on
    // every page, not just the first.
    const rows = state.cCursorSeq[k] === -1
      ? await db.$queryRaw<EncryptedCandidateRow[]>(Prisma.sql`
        SELECT n.seq::int AS seq, n.loc, n.data, n.memory_id
        FROM nodes n
        WHERE n.message_channel_id = ${geometry.channelId}
          AND n.node_type = 'chat-message'
          AND n.deleted_at IS NULL
          AND n.seq > ${state.cMin[k]}
          AND n.seq <= ${state.cMax[k]}
        ORDER BY n.seq, n.loc COLLATE "C"
        LIMIT ${take}
      `)
      : await db.$queryRaw<EncryptedCandidateRow[]>(Prisma.sql`
        SELECT merged.seq, merged.loc, merged.data, merged.memory_id FROM (
          (SELECT n.seq::int AS seq, n.loc, n.data, n.memory_id
           FROM nodes n
           WHERE n.message_channel_id = ${geometry.channelId}
             AND n.node_type = 'chat-message'
             AND n.deleted_at IS NULL
             AND n.seq = ${state.cCursorSeq[k]}
             AND n.loc COLLATE "C" > ${cursorLoc} COLLATE "C"
           ORDER BY n.seq, n.loc COLLATE "C"
           LIMIT ${take})
          UNION ALL
          (SELECT n.seq::int AS seq, n.loc, n.data, n.memory_id
           FROM nodes n
           WHERE n.message_channel_id = ${geometry.channelId}
             AND n.node_type = 'chat-message'
             AND n.deleted_at IS NULL
             AND n.seq > ${state.cCursorSeq[k]}
             AND n.seq <= ${state.cMax[k]}
           ORDER BY n.seq, n.loc COLLATE "C"
           LIMIT ${take})
        ) merged
        ORDER BY merged.seq, merged.loc COLLATE "C"
        LIMIT ${take}
      `);

    const list = targetsOfChannel.get(k) ?? [];
    for (const row of rows) {
      spent++; // every returned row passed all predicates — charge it
      const envelope = geometry.encrypted
        ? decryptRoutingEnvelope(row)
        : ((row.data && typeof row.data === 'object') ? row.data as Record<string, unknown> : {});
      const reach = reachEnvelopeOf(envelope);
      let anyCounted = false;
      for (const ti of list) {
        const target = targets[ti];
        if (row.seq <= target.seen || row.seq > target.head || envelope.authorWorkerId === target.workerId) continue;
        anyCounted = true;
        state.aUnread[ti]++;
        state.aFirst[ti] = state.aFirst[ti] === 0 ? row.seq : Math.min(state.aFirst[ti], row.seq);
        const mentioned = mentionReach(reach, mentionTokensByTarget[ti], [target.workerId]) !== null;
        if (mentioned) state.aMent[ti]++;
        if (!target.mentionOnly || mentioned) {
          state.aLast[ti] = Math.max(state.aLast[ti], row.seq);
        }
      }
      state.cCursorSeq[k] = row.seq;
      state.cCursorLoc[k] = row.loc.slice(prefix.length);
      // The COUNTED frontier only advances when ≥1 target actually counted
      // this row — an own post after a counted message must not weaken the
      // deletion check (#3153 finding 3).
      if (anyCounted) state.cFrontNum[k] = state.cCursorLoc[k];
    }

    // Done when the frozen seq range is exhausted (fewer than `take`
    // qualifying rows). Post-freeze traffic never enters the index range —
    // no seq inference, no padding-boundary hazard.
    if (rows.length < take) {
      state.cDone[k] = true;
      list.sort((a, b) => targets[a].workerId.localeCompare(targets[b].workerId));
      state.pending.push(...list);
    }
  }
  return spent;
}

// ── #1384/#1421 paged (v2) public surface ────────────────────────────────────

export interface TeamAttentionPageItem {
  worker: string;
  workerName: string;
  workerUrn: string | null;
  channel: string;
  channelName: string;
  unread: number;
  unreadMentions: number;
  firstUnreadSeq: number | null;
  lastRelevantSeq: number | null;
  lastSeq: number; // the frozen Channel head this page's counts are exact for
}

export interface TeamAttentionPageResult {
  items: TeamAttentionPageItem[];
  scanComplete: boolean;
  /** Present while any Channel is unfinished or queued items remain
   * undelivered. Absent (null) on the final page. */
  nextPage: string | null;
  /** Present ONLY on the final page: a v1-shaped `since` head snapshot the
   * router adopts under the unchanged no-loss rule (every listed nudge
   * accepted first). Routers migrate without discarding a watermark. */
  adoptableSince: string | null;
}

export interface TeamAttentionPreviewPageResult {
  items: TeamAttentionPageItem[];
  scanComplete: boolean;
  nextPage: string | null;
  /** Present ONLY on the final page: the existing short-lived switchover
   * proof, bound to the complete frozen target scope and from/through heads.
   * An incomplete preview NEVER carries a proof, so a capped/partial preview
   * can never become a silent backlog-discard path. */
  proof: string | null;
  expiresAt: Date | null;
}

function stateToContinuation(
  op: 'poll' | 'preview',
  appId: string,
  userId: string,
  targets: Target[],
  channelIds: string[],
  state: PagedScanState,
  priorFloors: number[],
  channelIncarnations: number[],
): PageContinuation {
  const workerIds = [...new Set(targets.map((t) => t.workerId))].sort();
  const workerIndex = new Map(workerIds.map((id, i) => [id, i]));
  const registerIds = [...new Set(targets.map((t) => t.registerId))].sort();
  const registerIndex = new Map(registerIds.map((id, i) => [id, i]));
  const payload: PageContinuation = {
    v: 2,
    kind: 'team-attention-page',
    // Era marker 's' = seq-first Channel-local scan. The loc-ordered era
    // minted 'c'; verifyPageToken restarts those typed rather than
    // reinterpreting their cursor (Andi #3281).
    o: 's',
    op,
    appId,
    userId,
    ts: Date.now(),
    W: workerIds,
    C: channelIds,
    R: registerIds,
    t_w: targets.map((t) => workerIndex.get(t.workerId)!),
    t_c: targets.map((t) => channelIds.indexOf(t.channelId)),
    t_r: targets.map((t) => registerIndex.get(t.registerId)!),
    t_mo: targets.map((t) => (t.mentionOnly ? 1 : 0)),
    t_seen: targets.map((t) => t.seen),
    t_head: targets.map((t) => t.head),
    t_prior: priorFloors,
    c_done: channelIds.reduce((m, _id, k) => (state.cDone[k] ? maskSet(m, k) : m), maskEmpty()),
    c_seq: state.cCursorSeq,
    c_loc: state.cCursorLoc,
    c_front: state.cFrontNum,
    c_inc: channelIncarnations,
    c_min: state.cMin,
    c_max: state.cMax,
    u_unread: state.aUnread,
    u_ment: state.aMent,
    u_first: state.aFirst,
    u_last: state.aLast,
    e_emitted: targets.reduce((m, _t, i) => (state.emitted[i] ? maskSet(m, i) : m), maskEmpty()),
    q: state.pending,
    next: state.next,
    dg: '',
  };
  payload.dg = scopeDigest(payload, attentionTokenSecret());
  return payload;
}

function continuationToState(page: PageContinuation): PagedScanState {
  const channelCount = page.C.length;
  const state: PagedScanState = {
    cMin: page.c_min,
    cMax: page.c_max,
    cCursorSeq: page.c_seq,
    cCursorLoc: page.c_loc,
    cFrontNum: page.c_front,
    cInc: page.c_inc,
    cDone: Array.from({ length: channelCount }, (_v, k) => maskGet(page.c_done, k)),
    aUnread: page.u_unread,
    aMent: page.u_ment,
    aFirst: page.u_first,
    aLast: page.u_last,
    pending: page.q,
    emitted: page.t_w.map((_v, i) => maskGet(page.e_emitted, i)),
    next: page.next,
  };
  return state;
}

/**
 * The paged attention poll (#1384 v2). Each call performs bounded work — at
 * most `scanLimit` decrypted rows and `limit` emitted Worker/Channel pairs —
 * and returns either a continuation or, when every frozen Channel is scanned
 * AND every queued item delivered, the final page with the adoptable v1-shaped
 * `since` snapshot. `since` (a v1 token) is accepted on the FIRST page only,
 * carrying the router's committed watermark forward; `page` continues a scan.
 * Never advances ChannelReadState; drift answers a typed stale-page refusal.
 */
async function runPagedAttention(
  ctx: Context,
  appRef: string,
  args: { since?: string | null; page?: string | null; limit?: number | null; scanLimit?: number | null },
  op: 'poll' | 'preview',
): Promise<{ items: TeamAttentionPageItem[]; scanComplete: boolean; nextPage: string | null; adoptableSince: string | null; proof: string | null; proofExpiresAt: Date | null; frozenSeen: number[]; frozenHead: number[] }> {
  const app = await resolvePilotApp(ctx, appRef);
  if (args.since === 'now') {
    fail('since:"now" is intentionally unavailable: preview and explicitly confirm a switchover instead.', 'SWITCHOVER_CONFIRMATION_REQUIRED');
  }
  if (args.since && args.page) {
    fail('Pass either since (start a scan) or page (continue one), not both.', 'BAD_USER_INPUT');
  }
  if (op === 'preview' && args.since) {
    fail('The paged preview takes no since token.', 'BAD_USER_INPUT');
  }
  // Integer budgets: GraphQL coerces Int and MCP validates via zod .int(),
  // but direct resolver callers bypass both — a fractional budget must fail
  // loudly rather than reach a SQL LIMIT (Codex P2 on #1428).
  for (const [name, value] of [['limit', args.limit], ['scanLimit', args.scanLimit]] as const) {
    if (value != null && !Number.isInteger(value)) {
      fail(`${name} must be an integer.`, 'BAD_USER_INPUT');
    }
  }
  const limit = Math.max(1, Math.min(args.limit ?? PAGE_RESULT_PAIRS_DEFAULT, PAGE_RESULT_PAIRS_MAX));
  const scanLimit = Math.max(1, Math.min(args.scanLimit ?? PAGE_SCAN_ROW_BUDGET_DEFAULT, PAGE_SCAN_ROW_BUDGET_MAX));

  let targets = await attentionTargets(ctx, app);
  const secret = attentionTokenSecret();
  const liveIncarnations = new Map(
    (await ctx.db.channel.findMany({
      where: { id: { in: [...new Set(targets.map((t) => t.channelId))] } },
      select: { id: true, incarnation: true },
    })).map((c) => [c.id, c.incarnation]),
  );

  // The frozen channel dictionary is sorted-id: deterministic round-robin.
  let channelIds = [...new Set(targets.map((t) => t.channelId))].sort();
  let channelIndexOf = new Map(channelIds.map((id, k) => [id, k]));

  let state: PagedScanState;
  /** True when this request STARTED the scan (no continuation) — the only
   * point where the membership completeness gate (#3257) runs. */
  let freshScan = false;
  /** Frozen Channel incarnations — captured at freeze, compared on every
   * resume INCLUDING unstarted and done channels (#3111 lifecycle gate). */
  let channelIncarnations: number[] = [];
  let priorHeads: Map<string, number> | null = null;
  // Per-target relevance floor (the ORIGINAL since head this scan started
  // from, 0 when none) — frozen into the continuation so a resumed page
  // keeps emitting against the original watermark (#3051 finding 6).
  let priorFloors: number[] = [];
  // Frozen per-target spans — the FROZEN head (not the live one) is what the
  // final preview proof and the emitted lastSeq describe; live heads may sit
  // above them by the time the last page is pulled.
  let frozenSeen: number[];
  let frozenHead: number[];

  if (args.page) {
    const decoded = verifyPageToken(args.page, secret);
    if (decoded.op !== op) fail('That page token belongs to the other attention operation.', 'INVALID_ATTENTION_PAGE');
    if (decoded.appId !== app.id || decoded.userId !== ctx.userId) {
      fail('That page token belongs to another operator or App.', 'INVALID_ATTENTION_PAGE');
    }
    if (decoded.dg !== scopeDigest(decoded, secret)) {
      fail('The page token scope does not match; poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
    }
    state = continuationToState(decoded);
    frozenSeen = decoded.t_seen;
    frozenHead = decoded.t_head;
    priorFloors = decoded.t_prior;
    channelIncarnations = decoded.c_inc;
    // Lifecycle gate FIRST, covering every frozen channel — unstarted and
    // done included. A same-address recreate preserves Channel/register IDs
    // and only increments incarnation (#3111; Chip reproduced old-token
    // acceptance through the supported deleteChannel + ensureChannelWithRoot
    // path), so identity and head comparisons alone cannot see it.
    for (let k = 0; k < decoded.C.length; k++) {
      if (liveIncarnations.get(decoded.C[k]) !== decoded.c_inc[k]) {
        fail('A Channel was recreated since this scan started; poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
      }
    }
    // Rehydrate by REBUILDING the working target list FROM THE FROZEN
    // ARRAYS (#3046 finding 2): the frozen set and order drive scan,
    // emission, snapshot and continuation for the rest of this request;
    // live rows only prove liveness/participation and supply display
    // metadata plus the register behind the (worker, channel, mentionOnly)
    // identity. EXACT set-and-order equality is required — a count
    // difference or any unmatched entry answers a typed stale restart, so a
    // target that appeared between pages can never slip into the final
    // snapshot unscanned. A forward READ-cursor move does NOT stale the
    // scan (the frozen span stays exact for its captured range; redundant
    // nudges allowed, loss impossible); a head moving backward does.
    if (decoded.t_w.length !== targets.length) {
      fail('The scan scope drifted (target set changed size); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
    }
    const liveAtFreeze = targets;
    const claimed = new Set<Target>();
    const rebuilt: Target[] = [];
    for (let i = 0; i < decoded.t_w.length; i++) {
      const workerId = decoded.W[decoded.t_w[i]];
      const channelId = decoded.C[decoded.t_c[i]];
      const registerId = decoded.R[decoded.t_r[i]];
      const match = liveAtFreeze.find(
        (t) => t.workerId === workerId
          && t.channelId === channelId
          && t.registerId === registerId
          && decoded.t_mo[i] === (t.mentionOnly ? 1 : 0)
          && !claimed.has(t)
          && decoded.t_head[i] <= t.head,
      );
      if (!match) {
        fail('The scan scope drifted (register, participation or head changed); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
      }
      claimed.add(match);
      rebuilt.push({ ...match, seen: decoded.t_seen[i], head: decoded.t_head[i] });
    }
    targets = rebuilt;
    channelIds = [...new Set(targets.map((t) => t.channelId))].sort();
    channelIndexOf = new Map(channelIds.map((id, k) => [id, k]));
    if (channelIds.length !== decoded.C.length || channelIds.some((id, k) => id !== decoded.C[k])) {
      fail('The scan scope drifted (channel dictionary changed); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
    }
    // Boundary check: the frontier row of every still-active channel must
    // still exist undeleted — deletion of the scan frontier is the mutation
    // we CAN detect cheaply; interior edits are the documented residual.
    for (let k = 0; k < channelIds.length; k++) {
      // Stale-frontier check uses the COUNTED frontier — the raw cursor may
      // legitimately sit on a residual-rejected row (#1430 decoupling).
      if (state.cDone[k] || state.cFrontNum[k] === '') continue;
      const target = targets.find((t) => t.channelId === channelIds[k]);
      const frontierLoc = `${target?.channelLoc ?? ''}:messages:${state.cFrontNum[k]}`;
      const frontier = await ctx.db.node.findFirst({
        where: { memoryId: target?.memoryId, loc: frontierLoc, deletedAt: null },
        select: { id: true },
      });
      if (!frontier) {
        fail('A Channel\'s scanned history changed (frontier row removed); poll again without page.', 'TEAM_ATTENTION_STALE_PAGE');
      }
    }
  } else {
    let prior: AttentionSnapshot | null = null;
    if (args.since) {
      const decoded = verify(args.since);
      if (decoded.kind !== 'team-attention') fail('That token is not an attention poll token.', 'INVALID_ATTENTION_TOKEN');
      if (decoded.appId !== app.id || decoded.userId !== ctx.userId) {
        fail('That attention token belongs to another operator or App.', 'INVALID_ATTENTION_TOKEN');
      }
      prior = decoded;
    }
    priorHeads = previousHeads(prior);
    for (const target of targets) {
      const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
      const priorHead = priorHeads.get(key);
      if (priorHead != null && priorHead > target.head) {
        fail('A Channel watermark moved behind the supplied token; poll again without since.', 'ATTENTION_TOKEN_STALE');
      }
    }
    // The idle short-circuit survives from v1 (poll only — a preview always
    // accounts for the full backlog): when every current target was in the
    // prior scope and no head moved, nothing relevant can be newer than the
    // token — no message-table touch, final page immediately.
    if (
      op === 'poll' &&
      prior &&
      targets.every((target) => {
        const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
        return priorHeads!.get(key) === target.head;
      })
    ) {
      return { items: [], scanComplete: true, nextPage: null, adoptableSince: sign(snapshot(app.id, ctx.userId!, targets)), proof: null, proofExpiresAt: null, frozenSeen: targets.map((t) => t.seen), frozenHead: targets.map((t) => t.head) };
    }
    frozenSeen = targets.map((t) => t.seen);
    frozenHead = targets.map((t) => t.head);
    channelIncarnations = channelIds.map((id) => liveIncarnations.get(id) ?? 0);
    priorFloors = targets.map((target) => {
      const key = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}`;
      return priorHeads?.get(key) ?? 0;
    });
    freshScan = true;
    state = {
      cMin: channelIds.map((id) => Math.min(...targets.filter((t) => t.channelId === id).map((t) => t.seen))),
      cMax: channelIds.map((id) => Math.max(...targets.filter((t) => t.channelId === id).map((t) => t.head))),
      cCursorSeq: channelIds.map(() => -1),
      cCursorLoc: channelIds.map(() => ''),
      cFrontNum: channelIds.map(() => ''),
      cInc: channelIds.map((id) => liveIncarnations.get(id) ?? 0),
      cDone: channelIds.map(() => false),
      aUnread: targets.map(() => 0),
      aMent: targets.map(() => 0),
      aFirst: targets.map(() => 0),
      aLast: targets.map(() => 0),
      pending: [],
      emitted: targets.map(() => false),
      next: 0,
    };
  }

  // Encryption split feeds the scan step: encrypted channels decrypt under
  // the row budget; plaintext channels aggregate in bounded seq windows
  // inside the same round-robin (one giant aggregate would be row-linear
  // server work — Codex P1 on #1428).
  const memories = await ctx.db.memory.findMany({
    where: { id: { in: [...new Set(targets.map((t) => t.memoryId))] } },
    select: { id: true, isEncrypted: true },
  });
  const encryptedMemoryIds = new Set(memories.filter((m) => m.isEncrypted).map((m) => m.id));

  // Encrypted channels: one bounded round-robin step.
  const channelGeometry = new Map<number, { memoryId: string; locPrefix: string; encrypted: boolean; channelId: string }>();
  for (let k = 0; k < channelIds.length; k++) {
    const target = targets.find((t) => t.channelId === channelIds[k]);
    if (target) {
      channelGeometry.set(k, {
        memoryId: target.memoryId,
        locPrefix: `${target.channelLoc}:messages:`,
        encrypted: encryptedMemoryIds.has(target.memoryId),
        channelId: channelIds[k],
      });
    }
  }
  // #3257 rollout completeness gate — freeze only. The paged reader trusts
  // Node.messageChannelId for membership; an unstamped live chat-message
  // under a Channel's messages prefix (an old binary still appending after
  // the backfill migration, or an off-road generic-surface create) would be
  // INVISIBLE to the scan, so a fresh scan refuses until adoption completes
  // instead of silently missing messages. Runs once per Channel per scan
  // start, never on resume: post-freeze appends allocate seq above every
  // row the freeze saw, so they sit outside the frozen span and the next
  // scan's gate re-checks them. seq IS NOT NULL is included explicitly so
  // the planner can prove the partial-index predicate and serve this from
  // nodes_msg_channel_seq_loc_c_idx (the NULL membership partition is empty
  // once adoption has run — the check is O(log n) in steady state).
  if (freshScan) {
    for (let k = 0; k < channelIds.length; k++) {
      const geometry = channelGeometry.get(k)!;
      const unstamped = await ctx.db.$queryRaw<Array<{ loc: string }>>(Prisma.sql`
        SELECT n.loc FROM nodes n
        WHERE n.memory_id = ${geometry.memoryId}
          AND n.node_type = 'chat-message'
          AND n.deleted_at IS NULL
          AND n.seq IS NOT NULL
          AND n.message_channel_id IS NULL
          AND starts_with(n.loc, ${geometry.locPrefix})
        LIMIT 1
      `);
      if (unstamped.length > 0) {
        fail(
          `Channel ${geometry.locPrefix.slice(0, -':messages:'.length)} has live chat-message rows without Channel membership (for example ${unstamped[0].loc}); an older writer or an off-road create left them unstamped. Re-run Channel adoption, then poll again — your committed watermark is untouched.`,
          'TEAM_ATTENTION_MEMBERSHIP_INCOMPLETE',
          { channel: channelIds[k], exampleLoc: unstamped[0].loc },
        );
      }
    }
  }

  await pagedScanStep(ctx.db, targets, channelIndexOf, channelGeometry, targets.map((t) => t.mentionTokens), state, scanLimit);

  // Emission: deliver completed targets in completion-visit order. The poll
  // applies v1's relevance rule (lastRelevant > priorHead; priorHead 0 when
  // this scan started without a since token); the preview accounts for the
  // full backlog and emits every completed target.
  const items: TeamAttentionPageItem[] = [];
  while (items.length < limit && state.pending.length > 0) {
    const i = state.pending[0];
    state.pending = state.pending.slice(1);
    state.emitted[i] = true;
    const target = targets[i];
    const priorHead = priorFloors[i] ?? 0;
    if (op === 'poll' && state.aLast[i] <= priorHead) continue; // nothing relevant since the watermark
    items.push({
      worker: target.workerId,
      workerName: target.workerName,
      workerUrn: target.workerUrn,
      channel: target.channelId,
      channelName: target.channelName,
      unread: state.aUnread[i],
      unreadMentions: state.aMent[i],
      firstUnreadSeq: state.aFirst[i] || null,
      lastRelevantSeq: state.aLast[i] || null,
      lastSeq: frozenHead[i],
    });
  }

  const scanComplete = state.cDone.every(Boolean) && state.pending.length === 0;
  if (scanComplete) {
    if (op === 'preview') {
      // The proof starts its short life only now — the final page of a FULL
      // preview — and binds the frozen from/through heads; messages arriving
      // after the freeze remain unread.
      const issuedAt = Date.now();
      const expiresAt = issuedAt + SWITCHOVER_PROOF_TTL_MS;
      const proof: SwitchoverProof = {
        v: 1,
        kind: 'team-attention-switchover',
        appId: app.id,
        userId: ctx.userId!,
        issuedAt,
        expiresAt,
        targets: targets.map((t, i) => ({
          workerId: t.workerId,
          channelId: t.channelId,
          registerId: t.registerId,
          mentionOnly: t.mentionOnly,
          from: frozenSeen[i],
          through: frozenHead[i],
        })),
      };
      return { items, scanComplete: true, nextPage: null, adoptableSince: null, proof: sign(proof), proofExpiresAt: new Date(expiresAt), frozenSeen, frozenHead };
    }
    return { items, scanComplete: true, nextPage: null, adoptableSince: sign(snapshot(app.id, ctx.userId!, targets)), proof: null, proofExpiresAt: null, frozenSeen, frozenHead };
  }
  // #3053 compaction: delivered targets' accumulators are final and already
  // emitted — zero them in the continuation so token size decreases
  // monotonically as results deliver (the emitted mask prevents re-emission
  // and their channels are done, so nothing reads these values again).
  for (let i = 0; i < state.emitted.length; i++) {
    if (state.emitted[i]) {
      state.aUnread[i] = 0; state.aMent[i] = 0; state.aFirst[i] = 0; state.aLast[i] = 0;
    }
  }
  const payload = stateToContinuation(op, app.id, ctx.userId!, targets, channelIds, state, priorFloors, channelIncarnations);
  payload.t_seen = frozenSeen;
  payload.t_head = frozenHead;
  const signed = signPageToken(payload, secret);
  if ('tooLarge' in signed) {
    fail(
      `The scan continuation would not fit the ${MAX_PAGE_TOKEN_CHARS}-character transport ceiling (${signed.actualChars} needed); poll again without page to restart from your committed watermark.`,
      'TEAM_ATTENTION_PAGE_TOO_LARGE',
    );
  }
  return { items, scanComplete: false, nextPage: signed.token, adoptableSince: null, proof: null, proofExpiresAt: null, frozenSeen, frozenHead };
}

/** The paged attention poll (#1384 v2). See `runPagedAttention`. */
export async function teamAttentionPage(
  ctx: Context,
  appRef: string,
  args: { since?: string | null; page?: string | null; limit?: number | null; scanLimit?: number | null },
): Promise<TeamAttentionPageResult> {
  const run = await runPagedAttention(ctx, appRef, args, 'poll');
  return { items: run.items, scanComplete: run.scanComplete, nextPage: run.nextPage, adoptableSince: run.adoptableSince };
}

/** The paged switchover preview (#1384 v2): same bounded scan and paged
 * result contract; the short-lived apply proof exists ONLY on the final page
 * of a fully completed preview. `confirmTeamAttentionSwitchover` (apply) is
 * unchanged. */
export async function teamAttentionPreviewPage(
  ctx: Context,
  appRef: string,
  args: { page?: string | null; limit?: number | null; scanLimit?: number | null },
): Promise<TeamAttentionPreviewPageResult> {
  const run = await runPagedAttention(ctx, appRef, args, 'preview');
  return { items: run.items, scanComplete: run.scanComplete, nextPage: run.nextPage, proof: run.proof, expiresAt: run.proofExpiresAt };
}

function snapshot(appId: string, userId: string, targets: Target[]): AttentionSnapshot {
  const workers = new Map<string, AttentionSnapshot['workers'][number]>();
  for (const t of targets) {
    let worker = workers.get(t.workerId);
    if (!worker) {
      worker = { workerId: t.workerId, channels: [] };
      workers.set(t.workerId, worker);
    }
    worker.channels.push({
      channelId: t.channelId,
      registerId: t.registerId,
      mentionOnly: t.mentionOnly,
      head: t.head,
    });
  }
  return { v: 1, kind: 'team-attention', appId, userId, workers: [...workers.values()] };
}

function previousHeads(value: AttentionSnapshot | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const worker of value?.workers ?? []) {
    if (!worker || typeof worker.workerId !== 'string' || !Array.isArray(worker.channels)) {
      fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
    }
    for (const channel of worker.channels) {
      if (
        !channel ||
        typeof channel.channelId !== 'string' ||
        typeof channel.registerId !== 'string' ||
        typeof channel.mentionOnly !== 'boolean' ||
        !Number.isInteger(channel.head) ||
        channel.head < 0
      ) fail('Invalid team-attention token.', 'INVALID_ATTENTION_TOKEN');
      out.set(`${worker.workerId}:${channel.channelId}:${channel.registerId}:${channel.mentionOnly}`, channel.head);
    }
  }
  return out;
}

export async function getTeamAttention(ctx: Context, appRef: string, since?: string | null): Promise<TeamAttentionResult> {
  // #1384 v2 retirement: the v1 poll decrypts an encrypted Channel's whole
  // unread backlog inside one request. It is refused everywhere so no
  // deployment can expose unbounded work; routers migrate by passing their
  // existing since token to teamAttentionPage (the watermark carries over).
  void ctx; void appRef; void since;
  fail(
    'Team attention v1 is retired: use the paged teamAttentionPage operation (your existing since token is accepted there).',
    'UPGRADE_REQUIRED',
  );
}

export async function previewTeamAttentionSwitchover(
  ctx: Context,
  appRef: string,
): Promise<TeamAttentionSwitchoverPreview> {
  // #1384 v2 retirement: the unbounded v1 preview shares the v1 poll's scan.
  // The paged teamAttentionPreviewPage replaces it; apply
  // (confirmTeamAttentionSwitchover) is unchanged and honors existing
  // unexpired proofs to expiry.
  void ctx; void appRef;
  fail(
    'Switchover preview v1 is retired: use the paged teamAttentionPreviewPage operation; the proof it issues on its final page feeds the unchanged apply.',
    'UPGRADE_REQUIRED',
  );
}

function targetIdentity(t: Pick<Target, 'workerId' | 'channelId' | 'registerId' | 'mentionOnly' | 'seen'>): string {
  return `${t.workerId}:${t.channelId}:${t.registerId}:${t.mentionOnly}:${t.seen}`;
}

export async function confirmTeamAttentionSwitchover(
  ctx: Context,
  appRef: string,
  proofToken: string,
): Promise<{ applied: true; workersAdvanced: number; channelsAdvanced: number }> {
  const app = await resolvePilotApp(ctx, appRef);
  const decoded = verify(proofToken);
  if (decoded.kind !== 'team-attention-switchover') fail('That token is not a switchover proof.', 'INVALID_SWITCHOVER_PROOF');
  if (decoded.appId !== app.id || decoded.userId !== ctx.userId || !Array.isArray(decoded.targets)) {
    fail('That switchover proof belongs to another operator or App.', 'INVALID_SWITCHOVER_PROOF');
  }
  if (!Number.isInteger(decoded.expiresAt) || Date.now() > decoded.expiresAt) {
    fail('That switchover preview has expired; preview again.', 'SWITCHOVER_PROOF_EXPIRED');
  }
  if (decoded.targets.length > MAX_TARGETS) fail('Invalid switchover proof.', 'INVALID_SWITCHOVER_PROOF');

  try {
    await ctx.db.$transaction(
      async (tx) => {
        const txCtx = { ...ctx, db: tx as unknown as PrismaClient };
        // Re-asked INSIDE the serializable transaction, on its own connection
        // (#1362 review, Copilot): the entry check can go stale before these
        // writes, and an App uninstalled or a participation revoked since then
        // must not still advance cursors. A revocation racing these writes
        // surfaces as a serialization abort, mapped to stale below.
        if (!(await teamAttentionAvailable(txCtx, app.id))) {
          fail('Access to this App changed after preview; preview again.', 'SWITCHOVER_PROOF_STALE');
        }
        const current = await attentionTargets(txCtx, app);
        const currentByIdentity = new Map(current.map((t) => [targetIdentity(t), t]));
        const proofIdentities = new Set<string>();
        for (const target of decoded.targets) {
          if (
            !target ||
            typeof target.workerId !== 'string' ||
            typeof target.channelId !== 'string' ||
            typeof target.registerId !== 'string' ||
            typeof target.mentionOnly !== 'boolean' ||
            !Number.isInteger(target.from) || target.from < 0 ||
            !Number.isInteger(target.through) || target.through < 0
          ) fail('Invalid switchover proof.', 'INVALID_SWITCHOVER_PROOF');
          const identity = `${target.workerId}:${target.channelId}:${target.registerId}:${target.mentionOnly}:${target.from}`;
          proofIdentities.add(identity);
          const live = currentByIdentity.get(identity);
          if (!live || live.head < target.through) {
            fail('The Worker/register/read-state scope changed after preview; preview again.', 'SWITCHOVER_PROOF_STALE');
          }
        }
        if (proofIdentities.size !== currentByIdentity.size || [...currentByIdentity.keys()].some((k) => !proofIdentities.has(k))) {
          fail('The live Worker/register scope changed after preview; preview again.', 'SWITCHOVER_PROOF_STALE');
        }
        for (const target of decoded.targets) {
          await advanceReadState(tx, { workerId: target.workerId }, target.channelId, target.through);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
      fail('The Worker/register or access scope changed during apply; preview again.', 'SWITCHOVER_PROOF_STALE');
    }
    throw e;
  }
  return {
    applied: true,
    workersAdvanced: new Set(decoded.targets.map((t) => t.workerId)).size,
    channelsAdvanced: decoded.targets.length,
  };
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
    teamHeadRef?: string | null;
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
  // S3: a team-head filtered read is a window, not the contiguous tail: it never advances the mark.
  if (args.teamHeadRef != null || args.untagged != null) return null;
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
  if (args.advanceReadState !== false && args.mentionsRef) {
    return advanceOwnMentionsRead(ctx, session, args, { expected });
  }
  const out = await ctx.db.$transaction(async (tx) => {
    const effects = await fencedCheckEffects(ctx, tx, session, args.channelId, expected);
    if (effects.refused || args.advanceReadState === false) return { effects, advanced: null as number | null };
    const advanced = args.beforeSeq != null || (args.offset ?? 0) !== 0 || (args.limit ?? 1) <= 0 || (args.sinceSeq == null && args.offset == null)
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
