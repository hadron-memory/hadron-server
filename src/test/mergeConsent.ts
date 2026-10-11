import type { PrismaClient } from '../generated/prisma/index.js';
import { randomBytes, createHash } from 'node:crypto';
import { mergeUsers as consolidate, type MergeUsersArgs } from '../controller/operations/mergeUsers.js';

/** Synthetic pre-approved proof for tests of pre-existing transfer behavior, not auth tests. */
export async function approvedMergeProof(db: PrismaClient, sourceUserId: string, targetUserId: string, requestedBy = targetUserId): Promise<string> {
  const proof = randomBytes(32).toString('hex');
  const at = new Date();
  await db.userMergeConsent.create({ data: {
    proofHash: createHash('sha256').update(proof).digest('hex'), sourceUserId, targetUserId,
    requestedBy, createdAt: at, expiresAt: new Date(at.getTime() + 900_000),
    sourceLoginAt: at, sourceLoginMethod: 'email', targetLoginAt: at, targetLoginMethod: 'email',
  } });
  return proof;
}

/** Preserve each old test's actor/role semantics while supplying the new prerequisite. */
export async function mergeUsers(db: PrismaClient, args: MergeUsersArgs) {
  const actorUserId = args.actorUserId ?? args.targetUserId;
  return consolidate(db, { ...args, actorUserId, consentProof: args.consentProof ?? await approvedMergeProof(db, args.sourceUserId, args.targetUserId, actorUserId) });
}
