import { admitRateInTx } from './rateLimit/index.js';
import { transportRateIdentity, type RateIdentity } from './rateLimit/identity.js';
import { createHash, randomBytes } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { resolveUserRef } from './entityRef/userRef.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';

export const MERGE_CONSENT_TTL_MS = 15 * 60 * 1000;
/** Live (unexpired, unconsumed) proofs one requester may hold (cor:api:010:02, #1770 ruling). */
export const MERGE_CONSENT_LIVE_CAP = 10;
/** A retired request is kept this long after the later of its expiry and consumption (cor:api:010:02). */
export const MERGE_CONSENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCOPE = 'FULL_CONSOLIDATION';
const digest = (proof: string) => createHash('sha256').update(proof).digest('hex');
const denied = () => new GraphQLError('Both accounts must approve this merge after a fresh login. Request new consent.',
  { extensions: { code: 'MERGE_CONSENT_REQUIRED' } });

/**
 * Begin an exact ordered-pair consent; only its SHA-256 digest is persisted.
 * Refuses `MERGE_CONSENT_LIMIT_REACHED`, writing nothing, when the requester
 * already holds {@link MERGE_CONSENT_LIVE_CAP} live proofs (cor:api:010:02).
 */
export async function beginUserMergeConsent(db: PrismaClient, sourceUserId: string, targetUserId: string, requestedBy: string, rateIdentity?: RateIdentity) {
  if (sourceUserId === targetUserId) throw denied();
  const proof = randomBytes(32).toString('hex');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id IN (${sourceUserId}, ${targetUserId}, ${requestedBy}) ORDER BY id FOR SHARE`;
    const [source, target, actor] = await Promise.all([sourceUserId, targetUserId, requestedBy].map(id => tx.user.findUnique({ where: { id } })));
    if (!source || source.deletedAt || !target || target.deletedAt || !actor || actor.deletedAt ||
      !actor.roles.some(r => r === 'ADMIN' || r === 'OWNER')) throw denied(); // Conceal invalid/deleted requester or parties with one refusal.
    // #1770: serialize one requester's begins so the count below and the
    // insert act as one step; concurrent begins cannot pass the cap together.
    // Taken after the authorization refusal, so only an authorized requester
    // learns its own count. Advisory, so it adds no row-lock order to the merge's.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('merge-consent-cap'), hashtext(${requestedBy}))`;
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
    const live = await tx.userMergeConsent.count({ where: { requestedBy, consumedAt: null, expiresAt: { gt: now } } });
    if (live >= MERGE_CONSENT_LIVE_CAP) throw new GraphQLError(
      `You already have ${MERGE_CONSENT_LIVE_CAP} merge requests waiting. Complete one or let it expire, then start another.`,
      { extensions: { code: 'MERGE_CONSENT_LIMIT_REACHED', limit: MERGE_CONSENT_LIVE_CAP } });
    await admitRateInTx(tx, 'CREDENTIALS', rateIdentity ?? transportRateIdentity({ userId: requestedBy }));
    const expiresAt = new Date(now.getTime() + MERGE_CONSENT_TTL_MS);
    await tx.userMergeConsent.create({ data: { proofHash: digest(proof), sourceUserId, targetUserId, requestedBy,
      scope: SCOPE, createdAt: now, expiresAt } });
    return { proof, expiresAt };
  });
}

/** A signed login callback claim, not JWT issuance/refresh, proves re-authentication. */
export async function approveUserMergeConsent(ctx: Context, proof: string, sourceRef: string, targetRef: string): Promise<boolean> {
  const login = ctx.login;
  if (!ctx.userId || ctx.apiKeyId || ctx.appId || ctx.impersonation || ctx.sessionId ||
    !login || !Number.isSafeInteger(login.at) || !['github', 'google', 'apple', 'email'].includes(login.method)) throw denied();
  const proofHash = digest(proof);
  const hint = await ctx.db.userMergeConsent.findUnique({ where: { proofHash } });
  if (!hint || (ctx.userId !== hint.sourceUserId && ctx.userId !== hint.targetUserId)) throw denied();
  // Only a party with signed login evidence reaches ref resolution. Conceal missing or
  // mismatched refs with the same consent refusal; reveal no account metadata.
  let sourceId: string, targetId: string;
  try {
    const [source, target] = await Promise.all([resolveUserRef(ctx.db, sourceRef), resolveUserRef(ctx.db, targetRef)]);
    sourceId = source.id;
    targetId = target.id;
  } catch { throw denied(); }
  if (sourceId !== hint.sourceUserId || targetId !== hint.targetUserId) throw denied();
  return ctx.db.$transaction(async tx => {
    // Same lock order as merging: accounts first, then consent. Neither a
    // merge nor a delete can invalidate a signer after this gate.
    await tx.$queryRaw`SELECT id FROM users WHERE id IN (${hint.sourceUserId}, ${hint.targetUserId}) ORDER BY id FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM user_merge_consents WHERE proof_hash = ${proofHash} FOR UPDATE`;
    const consent = await tx.userMergeConsent.findUnique({ where: { proofHash } });
    const accounts = await tx.user.findMany({ where: { id: { in: [hint.sourceUserId, hint.targetUserId] }, deletedAt: null } });
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
    if (!consent || consent.sourceUserId !== sourceId || consent.targetUserId !== targetId || accounts.length !== 2 || consent.consumedAt || consent.scope !== SCOPE ||
      consent.expiresAt <= now || login.at < consent.createdAt.getTime() || login.at > now.getTime()) throw denied();
    const source = ctx.userId === consent.sourceUserId;
    // First approval is sealed; a later call cannot replace its identity/time.
    if (source ? consent.sourceLoginAt : consent.targetLoginAt) return true;
    await tx.userMergeConsent.update({ where: { id: consent.id }, data: source
      ? { sourceLoginAt: new Date(login.at), sourceLoginMethod: login.method }
      : { targetLoginAt: new Date(login.at), targetLoginMethod: login.method } });
    return true;
  });
}

/** Consume BOTH fresh-login approvals under the merge's account locks, before any transfer. */
export async function consumeUserMergeConsent(tx: Prisma.TransactionClient, proof: string | undefined,
  sourceUserId: string, targetUserId: string, actorUserId: string | null | undefined) {
  if (!proof || !actorUserId) throw denied();
  const proofHash = digest(proof);
  // clock_timestamp (not transaction-start now()) checks expiry after a wait.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE user_merge_consents SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE proof_hash = ${proofHash} AND source_user_id = ${sourceUserId} AND target_user_id = ${targetUserId}
      AND requested_by = ${actorUserId}
      AND scope = ${SCOPE} AND consumed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
      AND source_login_at >= created_at AND target_login_at >= created_at
      AND source_login_method IS NOT NULL AND target_login_method IS NOT NULL
    RETURNING id`;
  if (rows.length !== 1) throw denied();
  const c = await tx.userMergeConsent.findUniqueOrThrow({ where: { id: rows[0].id } });
  return { consentHash: proofHash, consentReceipt: {
    scope: c.scope, sourceUserId, targetUserId, requestedBy: c.requestedBy, createdAt: c.createdAt.toISOString(), expiresAt: c.expiresAt.toISOString(),
    sourceLoginAt: c.sourceLoginAt!.toISOString(), sourceLoginMethod: c.sourceLoginMethod!,
    targetLoginAt: c.targetLoginAt!.toISOString(), targetLoginMethod: c.targetLoginMethod!, consumedAt: c.consumedAt!.toISOString(),
  } };
}

/**
 * True when `proof` was spent by a committed merge of exactly this ordered pair
 * that `actorUserId` requested. Only the proof's holder and requester can make
 * this true, so it reveals nothing about anyone else's proofs. #1770 uses it to
 * tell a concurrent merge's loser that the merge happened (`MERGE_ALREADY_APPLIED`).
 */
export async function mergeConsentAlreadyApplied(db: PrismaClient, proof: string, sourceUserId: string,
  targetUserId: string, actorUserId: string | null | undefined): Promise<boolean> {
  if (!actorUserId) return false;
  const merge = await db.userMerge.findUnique({ where: { consentHash: digest(proof) } });
  const receipt = merge?.consentReceipt as { requestedBy?: unknown } | null | undefined;
  return !!merge && merge.sourceUserId === sourceUserId && merge.targetUserId === targetUserId && receipt?.requestedBy === actorUserId;
}

/**
 * One bounded retention pass (cor:api:010:02, #1770): delete at most
 * `batchSize` retired requests whose later of expiry and consumption is at
 * least {@link MERGE_CONSENT_RETENTION_MS} before `now`, oldest first.
 * A live proof always expires after `now`, so it is never eligible; a merge's
 * sealed receipt lives in `user_merges` and is never touched. Returns the
 * number deleted; repeated passes converge to 0.
 */
export async function sweepRetiredMergeConsents(db: PrismaClient,
  { now = new Date(), batchSize = 500 }: { now?: Date; batchSize?: number } = {}): Promise<number> {
  const cutoff = new Date(now.getTime() - MERGE_CONSENT_RETENTION_MS);
  const eligible = { expiresAt: { lte: cutoff }, OR: [{ consumedAt: null }, { consumedAt: { lte: cutoff } }] };
  const batch = await db.userMergeConsent.findMany({ where: eligible, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: batchSize, select: { id: true } });
  if (batch.length === 0) return 0;
  // Re-apply the predicate at delete time, so a pass deletes nothing it did not select as eligible.
  const { count } = await db.userMergeConsent.deleteMany({ where: { ...eligible, id: { in: batch.map(r => r.id) } } });
  return count;
}
