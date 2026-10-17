/**
 * #1956 — resume claims (cor:agt:020:03; Holger via Vera #11904, the 60-second window #12291).
 *
 * A worker session's own driver writes a claim before a deliberate context reset: a shed keeps the session open,
 * a rotation ends it with its handoff. The fresh context then recovers its worker with ONE call and no arguments,
 * and needs no binding file:
 *
 *  - exactly one live claim of the caller's: it is redeemed (consumed) and the caller is bound, to the claimed
 *    session when it is still open, otherwise to a new session for its worker;
 *  - several: they are listed for the human to pick, and nothing is consumed;
 *  - none: the fast path, the caller's own bound, LIVE sessions, exactly one of which binds, several of which list;
 *  - nothing at all: one typed refusal, `NOTHING_TO_RESUME`, and nothing is written or posted on anyone's behalf.
 *
 * The three invariants the gate (Xylon, issue #1956) names:
 *  (a) holder-only: a claim is judged by the caller's token, never by anything the caller presents. It carries no
 *      secret, and its id is never shown to anyone, so there is nothing to steal;
 *  (b) no enumeration: every read is keyed on the caller's own user id, so a non-holder's answer is the answer for a
 *      caller who has nothing, byte for byte;
 *  (c) single use: consumption is one guarded update on (unconsumed, unrevoked, unexpired, this holder), the #882
 *      pattern, never a read then a write. Of two racing redemptions exactly one wins; the loser is refused. Expiry
 *      is judged by the DATABASE clock at that update (#1966 review, Anne P2-3), so a redemption that paused
 *      between its read and its consume cannot spend a claim past its 60 seconds.
 *
 * A claim is recovery intent, never a waiver (#1966 review, Anne P2-1): resuming an open session goes through the
 * shared lifecycle gate (`resumeOwnLapsedSessionInTx`), and starting the next one through startSession's.
 */
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient, SessionType } from '../generated/prisma/index.js';
import { generateId } from './id.js';
import { isSessionLive, loadLastEventBySession, OPEN_SESSION_SCAN_CAP, recentlyTouchedFilter } from './sessionActivity.js';

/** Holger, 2026-10-15 (#12291 item 8): a claim is redeemable for 60 seconds from its write. */
export const RESUME_CLAIM_TTL_MS = 60_000;

/**
 * At most this many of the caller's own claims are listed: one page of choices for a human. It never decides
 * anything, since a page this full already holds more than one claim. The live-session pool is not capped this way.
 */
const CANDIDATE_CAP = 50;

type Db = PrismaClient | Prisma.TransactionClient;

/** The one refusal for "nothing to resume": absent, expired, used, someone else's and unauthenticated alike. */
export const nothingToResume = () =>
  new GraphQLError(
    'Nothing to resume: you have no unused resume claim and no live worker session. Start one by naming the worker ' +
      '(startSession with workerRef). Nothing was posted or recorded.',
    { extensions: { code: 'NOTHING_TO_RESUME' } },
  );

/** One choice in a CHOOSE answer: always one of the caller's own sessions. */
export type ResumeCandidate = {
  sessionId: string;
  workerId: string;
  workerName: string;
  description: string | null;
  source: 'CLAIM' | 'LIVE_SESSION';
  expiresAt: Date | null;
};

/**
 * Write a claim for a worker session the caller drives. Replaces (revokes) any unused claim already written for the
 * same session, so a session has at most one live claim. The caller's ownership is checked by the resolver; this
 * only writes.
 */
export async function writeResumeClaim(
  db: Db,
  s: { sessionId: string; appId: string; workerId: string; holderUserId: string },
  now = new Date(),
): Promise<{ expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + RESUME_CLAIM_TTL_MS);
  const write = async (tx: Prisma.TransactionClient) => {
    // Serialize writers per session (#1966 review, Anne P3): without the row lock two first writes both see no
    // claim to revoke and both create one, breaking "at most one live claim per session".
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${s.sessionId} FOR UPDATE`;
    await tx.resumeClaim.updateMany({
      where: { sessionId: s.sessionId, consumedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.resumeClaim.create({
      data: { id: generateId(), appId: s.appId, sessionId: s.sessionId, workerId: s.workerId, holderUserId: s.holderUserId, issuedAt: now, expiresAt },
    });
  };
  if ('$transaction' in db) await (db as PrismaClient).$transaction(write);
  else await write(db as Prisma.TransactionClient);
  return { expiresAt };
}

/** The caller's own redeemable claims, newest first. Keyed on the holder: never anyone else's. */
export async function liveClaimsOf(db: Db, holderUserId: string, now: Date) {
  return db.resumeClaim.findMany({
    where: { holderUserId, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { issuedAt: 'desc' },
    take: CANDIDATE_CAP,
  });
}

/**
 * Consume one claim: the single-use guard. True only for the one call that won; a used, revoked, expired or foreign
 * claim (the holder is part of the guard) consumes nothing.
 *
 * LOCK FIRST, THEN JUDGE (#1966 review, Anne P2-3 and its delta): the claim row is locked before expiry is read, and
 * expiry is then judged by the database clock in a statement that cannot wait. A single guarded UPDATE is not enough:
 * when it blocks on a row lock that is released WITHOUT a change, PostgreSQL keeps the WHERE result it computed
 * before the wait, so a claim held past its deadline by another locker would still be consumed, stamped with a
 * pre-deadline time. Columns are UTC `timestamp(3)`, hence `AT TIME ZONE 'UTC'`.
 *
 * Lock order: the claim is the LAST row an act locks. The writer takes Session then Claim, and an open redemption
 * runs the lifecycle gate (App, Worker, Session) before consuming, so the two never wait on each other in a cycle
 * (Anne P2-4). Pass the caller's transaction to join it; a client runs the pair in a transaction of its own.
 */
export async function consumeResumeClaim(db: Db, claimId: string, holderUserId: string): Promise<boolean> {
  const run = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM resume_claims WHERE id = ${claimId} FOR UPDATE`;
    const n = await tx.$executeRaw`
      UPDATE resume_claims SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE id = ${claimId} AND holder_user_id = ${holderUserId}
        AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')`;
    return n === 1;
  };
  return '$transaction' in db ? (db as PrismaClient).$transaction(run) : run(db as Prisma.TransactionClient);
}

/** The fast path cannot decide: more possibly-live sessions than one scan holds. */
export const tooManyToResume = () =>
  new GraphQLError(
    'You have too many recently driven worker sessions to pick one without a resume claim. Name the worker ' +
      '(startSession with workerRef) instead. Nothing was bound.',
    { extensions: { code: 'RESUME_AMBIGUOUS' } },
  );

/**
 * The caller's own open, worker-bound sessions that read LIVE now (the fast path's pool), newest first.
 *
 * The WHOLE pool decides (Anne P2-2): rows that cannot be live are filtered in the query by the same type-aware
 * predicate the bind gate uses (`recentlyTouchedFilter`), and a pool larger than one scan refuses rather than
 * deciding uniqueness on a page, the `resumeVerdict` discipline (#1625 review, P3). A page cap that ran BEFORE the
 * liveness filter let 50 quiet sessions hide a second live one, and the fast path then auto-bound a guess.
 */
export async function liveWorkerSessionsOf(db: Db, userId: string, now: Date) {
  const open = await db.session.findMany({
    where: { userId, endedAt: null, deletedAt: null, workerId: { not: null }, ...recentlyTouchedFilter(now) },
    orderBy: { startedAt: 'desc' },
    take: OPEN_SESSION_SCAN_CAP + 1,
    select: { id: true, workerId: true, plan: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
  });
  if (open.length > OPEN_SESSION_SCAN_CAP) throw tooManyToResume();
  const lastEvents = await loadLastEventBySession(db as never, open.map((s) => s.id));
  return open.filter((s) => isSessionLive({ ...s, type: s.type as SessionType }, lastEvents.get(s.id), now));
}

/** Label each candidate with its worker's name. */
export async function toCandidates(
  db: Db,
  rows: { sessionId: string; workerId: string; source: ResumeCandidate['source']; expiresAt: Date | null }[],
): Promise<ResumeCandidate[]> {
  const sessions = new Map(
    (await db.session.findMany({ where: { id: { in: rows.map((r) => r.sessionId) } }, select: { id: true, plan: true } })).map((s) => [s.id, s]),
  );
  const workers = new Map(
    (await db.worker.findMany({ where: { id: { in: rows.map((r) => r.workerId) } }, select: { id: true, name: true } })).map((w) => [w.id, w]),
  );
  return rows.map((r) => ({
    sessionId: r.sessionId,
    workerId: r.workerId,
    workerName: workers.get(r.workerId)?.name ?? r.workerId,
    description: sessions.get(r.sessionId)?.plan ?? null,
    source: r.source,
    expiresAt: r.expiresAt,
  }));
}
