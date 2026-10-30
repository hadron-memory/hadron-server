/**
 * #2015 — admission of a worker's team-chat post: the one clock, the per-worker lock, and the duplicate lookup.
 *
 * The refusal itself lives in `postToChannelRoot`; this module is what that function (and, later, #2014's rolling
 * windows, which reuse the SAME lock and clock rather than deriving their own) asks.
 *
 *  - ONE admission instant. `admissionTime` reads the database's `clock_timestamp()` after the Channel's lock and the
 *    worker's lock are both held, and the caller stamps it into the new message's `createdAt`. The cutoff a later
 *    admission counts against therefore reads the same column the earlier one wrote, from the same clock, at the moment
 *    it was actually admitted. (Prisma stamps `@default(now())` on the engine side at insert; that is the app host's
 *    clock, not the database's, and nothing ties it to the lock.)
 *  - ONE per-worker lock. The Channel's lock serializes posts to one Channel; the worker posts to many, and a window
 *    that spans Channels needs them serialized per worker. It is a leaf: taken after the Channel lock and before the
 *    App team-graph lock and the Worker row lock the post takes next, and no other code takes it.
 *  - Duplicate: the worker's own live chat-message in this Channel, newer than the cutoff, with exactly this body and
 *    the same reply identity (a `replies-to` edge to the same target, or none on both sides). Reply identity is read
 *    from the edge, never from the envelope, so it needs no decryption.
 *
 * An encrypted memory's body is stored as ciphertext, so an equality read can never match there; the caller skips the
 * lookup rather than decrypting (R13/R43: no session-key plumbing here; the legacy encrypted-Channel gap is tracked on
 * its own issue).
 */

import type { Prisma } from '@prisma/client';

/** A message blocks an identical one for this long after it was admitted. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/** An earlier message blocks iff `createdAt > cutoff`: a message exactly ten minutes old no longer does. */
export const duplicateCutoff = (admittedAt: Date): Date => new Date(admittedAt.getTime() - DUPLICATE_WINDOW_MS);

/** Serialize this worker's admissions across every Channel, for the rest of the transaction. */
export async function lockWorkerPostAdmission(tx: Prisma.TransactionClient, workerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'worker-post-admission:' + workerId}))`;
}

/** The admission instant: the database clock, read now (after the locks), never the request's or the app host's. */
export async function admissionTime(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return rows[0]!.now;
}

/**
 * The seq of this worker's most recent live message in this Channel that an identical post would duplicate, or null.
 * `replyTargetId` is the node the new post replies to (null for none).
 */
export async function findEarlierDuplicate(
  tx: Prisma.TransactionClient,
  args: { memoryId: string; channelId: string; workerId: string; body: string; replyTargetId: string | null; admittedAt: Date },
): Promise<number | null> {
  const candidates = await tx.node.findMany({
    where: {
      memoryId: args.memoryId,
      nodeType: 'chat-message',
      messageChannelId: args.channelId,
      createdByWorkerId: args.workerId,
      deletedAt: null,
      content: args.body,
      createdAt: { gt: duplicateCutoff(args.admittedAt) },
    },
    orderBy: { seq: 'desc' },
    select: { id: true, seq: true },
  });
  if (candidates.length === 0) return null;
  const replyEdges = await tx.edge.findMany({
    where: { memoryId: args.memoryId, sourceId: { in: candidates.map((c: { id: string }) => c.id) }, name: 'replies-to', deletedAt: null },
    select: { sourceId: true, targetId: true },
  });
  const targetOf = new Map(replyEdges.map((e: { sourceId: string; targetId: string }) => [e.sourceId, e.targetId] as const));
  for (const c of candidates) {
    const target = targetOf.get(c.id) ?? null;
    if (target === args.replyTargetId && c.seq != null) return c.seq;
  }
  return null;
}
