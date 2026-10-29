import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { generateId } from '../lib/id.js';
import { verifyJwt, type HadronJwtPayload } from './jwt.js';

/**
 * #1897 / R66 — the revocable sign-in root.
 *
 * A factor-protected sign-in is a `SignIn` row. Its id is the JWT `sid` claim and the immutable
 * root of every handoff code, authorization code and key that descends from it, so ending it
 * (the first-passkey cancel link, cor:aut:030:02) ends exactly that lineage and nothing else.
 *
 * Lock order for every writer here, matching the cancel path: user authority anchor → credential
 * row → SignIn rows by id → handoff/auth-code rows → key rows by id.
 */

type Db = Pick<PrismaClient, 'signIn'>;

/** The sign-in is ended, absent, or belongs to someone else: indistinguishable to a caller. */
export class SignInNotLive extends Error {
  constructor() {
    super('Sign-in is not live');
    this.name = 'SignInNotLive';
  }
}

/**
 * Record a completed sign-in. Called only from the deciding transaction of a completed factor
 * (slice B); never from a request that merely carries a token.
 */
export async function createSignIn(
  tx: Pick<Prisma.TransactionClient, 'signIn'>,
  input: { userId: string; method: string; passkeyId: string | null; expiresAt?: Date },
) {
  return tx.signIn.create({
    data: {
      id: generateId(),
      userId: input.userId,
      method: input.method,
      completedByPasskeyId: input.passkeyId,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
}

/**
 * Verify a Hadron JWT AND consult the database for its sign-in.
 *
 * A token without `sid` is a pre-cutover or identity-provider token and keeps the old contract
 * (S6, S11). A token WITH `sid` must name a live sign-in of the same owner: a crypto-valid sid
 * naming an absent row is invalid, never classed legacy. Every authentication call site uses this;
 * the bare `verifyJwt` is reserved for it (pinned by a static inventory in signIn.test.ts).
 */
export async function verifyAuthenticatedJwt(token: string, db: Db): Promise<HadronJwtPayload> {
  const payload = await verifyJwt(token);
  if (payload.sid === undefined) return payload;
  if (typeof payload.sid !== 'string' || !payload.sid) throw new SignInNotLive();
  // Without an owner the where below would drop its userId predicate (Bindi P3-1, #2116).
  if (typeof payload.sub !== 'string' || !payload.sub) throw new SignInNotLive();
  const row = await db.signIn.findFirst({
    where: { id: payload.sid, userId: payload.sub, endedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (!row) throw new SignInNotLive();
  return payload;
}

/**
 * Take a share lock on a live sign-in of `userId`, inside a transaction that already holds the
 * user authority anchor. Refuses when it is ended, absent or another owner's. Expiry of the sign-in
 * token does not bound descendants: a code or key minted later still inherits the root (R66).
 */
export async function lockLiveSignInRoot(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  signInId: string,
  userId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sign_ins WHERE id = ${signInId} AND user_id = ${userId} AND ended_at IS NULL FOR SHARE`;
  if (!rows[0]) throw new SignInNotLive();
}

/**
 * End every sign-in a passkey completed, with everything that descends from them (R66 A).
 *
 * Called by #1631 PR2's cancel handler in the SAME transaction that marks the credential revoked,
 * after it holds the outer user authority anchor and the credential row. Internal-only and
 * idempotent: no nested transaction, no post-commit callback. It re-reads the credential and
 * refuses an unknown or not-yet-revoked one (a silent no-op would let a cancel leave sessions
 * live). Zero completed sign-ins is a valid empty lineage. Unrelated sign-ins, direct keys and
 * identity-provider sessions are untouched; revocation timestamps already set are kept.
 */
export async function endSignInsCompletedBy(
  tx: Prisma.TransactionClient,
  passkeyId: string,
): Promise<void> {
  const probe = await tx.passkeyCredential.findUnique({ where: { id: passkeyId }, select: { ownerId: true } });
  if (!probe) throw new Error('endSignInsCompletedBy: unknown passkey');
  await lockAuthorityAnchors(tx, [{ kind: 'user', id: probe.ownerId }], 'exclusive');
  const cred = await tx.$queryRaw<Array<{ owner_id: string; revoked_at: Date | null }>>`
    SELECT owner_id, revoked_at FROM passkey_credentials WHERE id = ${passkeyId} FOR SHARE`;
  if (!cred[0] || cred[0].owner_id !== probe.ownerId) throw new Error('endSignInsCompletedBy: passkey changed owner');
  if (!cred[0].revoked_at) throw new Error('endSignInsCompletedBy: passkey is not revoked');

  const roots = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sign_ins WHERE completed_by_passkey_id = ${passkeyId} ORDER BY id FOR UPDATE`;
  if (roots.length === 0) return;
  const ids = roots.map((r) => r.id);
  const now = new Date();
  await tx.signIn.updateMany({
    where: { id: { in: ids }, endedAt: null },
    data: { endedAt: now, endReason: 'passkey-cancelled' },
  });
  await tx.authHandoffCode.updateMany({ where: { signInId: { in: ids }, redeemedAt: null }, data: { redeemedAt: now } });
  await tx.authCode.updateMany({ where: { signInId: { in: ids }, redeemedAt: null }, data: { redeemedAt: now } });
  await tx.$queryRaw`SELECT id FROM user_api_keys WHERE origin_sign_in_id = ANY(${ids}) ORDER BY id FOR UPDATE`;
  await tx.userApiKey.updateMany({ where: { originSignInId: { in: ids }, revokedAt: null }, data: { revokedAt: now } });
}
