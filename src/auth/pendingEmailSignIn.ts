/**
 * #1897 slice B1: an email sign-in waiting for its passkey.
 *
 * A claimed magic link for a user who has a passkey creates ONE pending row and publishes nothing: no handoff
 * code, no JWT, no cookie, no key. The row is found by the SHA-256 of the pending cookie (the cookie value is
 * never stored), lives ten minutes by the database clock, and completes once, together with the sign-in it
 * produced. A SIGN_IN ceremony bound to the same browser hash is the only way to complete it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw'> | Prisma.TransactionClient;

export const PENDING_EMAIL_SIGN_IN_TTL_SECONDS = 10 * 60;
/** A flow that must first add a passkey (a second emailed link, then the registration) needs more room. */
export const PENDING_ENROLLMENT_TTL_SECONDS = 30 * 60;
/** Rows are disposable after this; swept lazily from the verify route. */
export const PENDING_EMAIL_SIGN_IN_RETENTION_HOURS = 24;

export type PendingContinuation =
  | { kind: 'PORTAL'; clientStateHash: string | null; redirect: string; isNew: boolean }
  | { kind: 'OAUTH'; returnTo: string };

export const sha256Hex = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

export interface PendingRow {
  id: string;
  userId: string;
  continuation: 'PORTAL' | 'OAUTH';
  clientStateHash: string | null;
  redirect: string | null;
  isNew: boolean | null;
  returnTo: string | null;
  browserHash: string;
  ceremonyId: string | null;
}

/** Create a pending flow; returns the RAW cookie secret, the only copy that exists. */
export async function createPendingEmailSignIn(
  db: Db,
  input: { userId: string; continuation: PendingContinuation; ttlSeconds?: number },
): Promise<{ id: string; cookieSecret: string }> {
  const id = generateId();
  const cookieSecret = randomBytes(32).toString('base64url');
  const c = input.continuation;
  const ttl = input.ttlSeconds ?? PENDING_EMAIL_SIGN_IN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > PENDING_ENROLLMENT_TTL_SECONDS) throw new Error('ttlSeconds must be a positive integer within the enrollment limit');
  if (c.kind === 'PORTAL' && c.clientStateHash !== null && !HEX64.test(c.clientStateHash)) throw new Error('client state hash must be 64 lowercase hex');
  await db.$executeRaw`INSERT INTO pending_email_sign_ins
      (id, user_id, continuation, client_state_hash, redirect, is_new, return_to, browser_hash, expires_at)
    VALUES (${id}, ${input.userId}, ${c.kind},
      ${c.kind === 'PORTAL' ? c.clientStateHash : null}, ${c.kind === 'PORTAL' ? c.redirect : null},
      ${c.kind === 'PORTAL' ? c.isNew : null}, ${c.kind === 'OAUTH' ? c.returnTo : null},
      ${sha256Hex(cookieSecret)},
      (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${ttl}))`;
  return { id, cookieSecret };
}

/**
 * The live, uncompleted pending flow this cookie names, or null. Missing, expired, completed and foreign cookie are
 * the same null: the caller must not tell them apart. `forUpdate` locks the row for the deciding transaction.
 */
export async function loadLivePending(db: Db, cookieSecret: string | null, opts: { forUpdate?: boolean } = {}): Promise<PendingRow | null> {
  if (!cookieSecret || cookieSecret.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cookieSecret)) return null;
  const hash = sha256Hex(cookieSecret);
  const rows = opts.forUpdate
    ? await db.$queryRaw<PendingRow[]>`SELECT id, user_id AS "userId", continuation, client_state_hash AS "clientStateHash", redirect,
        is_new AS "isNew", return_to AS "returnTo", browser_hash AS "browserHash", ceremony_id AS "ceremonyId"
      FROM pending_email_sign_ins WHERE browser_hash = ${hash} AND completed_at IS NULL
        AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE`
    : await db.$queryRaw<PendingRow[]>`SELECT id, user_id AS "userId", continuation, client_state_hash AS "clientStateHash", redirect,
        is_new AS "isNew", return_to AS "returnTo", browser_hash AS "browserHash", ceremony_id AS "ceremonyId"
      FROM pending_email_sign_ins WHERE browser_hash = ${hash} AND completed_at IS NULL
        AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')`;
  return rows[0] ?? null;
}

/** Point the pending flow at its current ceremony. Does not consume the earlier one: the caller does, in the same transaction. */
export async function setPendingCeremony(db: Db, pendingId: string, ceremonyId: string): Promise<void> {
  await db.$executeRaw`UPDATE pending_email_sign_ins SET ceremony_id = ${ceremonyId} WHERE id = ${pendingId} AND completed_at IS NULL`;
}

/** Complete once, with the sign-in it produced. False when it was already completed or expired. */
export async function completePending(db: Db, pendingId: string, signInId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`UPDATE pending_email_sign_ins
      SET completed_at = (clock_timestamp() AT TIME ZONE 'UTC'), sign_in_id = ${signInId}
    WHERE id = ${pendingId} AND completed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING id`;
  return rows.length === 1;
}

/** Delete rows older than the retention window. */
export async function sweepPendingEmailSignIns(db: Db): Promise<void> {
  await db.$executeRaw`DELETE FROM pending_email_sign_ins
    WHERE created_at < (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(hours => ${PENDING_EMAIL_SIGN_IN_RETENTION_HOURS}::int)`;
}
