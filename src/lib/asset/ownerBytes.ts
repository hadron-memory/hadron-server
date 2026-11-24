/**
 * #5017 (Billing A10): the `assetBytes` owner limit at the doors that add live bytes (cor:acl:150:02, :04). One place builds the owner of a
 * memory and the caller the refusal is shaped for, so every door asks the same question the same way.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { OwnerRef } from '../owner.js';
import { requireOwnerHeadroom } from '../ownerLimits/gate.js';

/** The owner a memory row names (organization XOR person), or null for a row naming neither (never stored; counts for nobody). */
export function memoryOwnerRef(row: { organizationId: string | null; ownerUserId: string | null }): OwnerRef | null {
  if (row.ownerUserId) return { userId: row.ownerUserId };
  if (row.organizationId) return { organizationId: row.organizationId };
  return null;
}

/** The person whose act this is, for the refusal's disclosure form: null under impersonation or for an unattended writer. */
export const assetLimitCaller = (caller: { userId?: string | null; impersonation?: unknown }): { userId: string } | null =>
  caller.userId && !caller.impersonation ? { userId: caller.userId } : null;

/** Refuse with OWNER_LIMIT_REACHED when the owner has no room for `bytes` more of files. Inside the writing transaction, before the write. */
export async function requireAssetBytesHeadroom(
  tx: Prisma.TransactionClient,
  owner: OwnerRef | null,
  bytes: number | bigint,
  caller: { userId: string } | null,
): Promise<void> {
  if (!owner) return;
  await requireOwnerHeadroom(tx, { owner, key: 'assetBytes', amount: BigInt(bytes), caller });
}

/**
 * The early answer at begin and before a stored file's bytes are written: a short transaction that reads the memory's owner under a
 * FOR SHARE lock and checks the headroom, then ends. It reserves nothing; the final check runs where the row is written.
 */
/** The owner of a live memory, read under a FOR SHARE lock so a transfer's FOR UPDATE and the write that follows are ordered. */
export async function lockMemoryOwner(tx: Prisma.TransactionClient, memoryId: string): Promise<{ found: boolean; owner: OwnerRef | null }> {
  const [row] = await tx.$queryRaw<Array<{ organization_id: string | null; owner_user_id: string | null }>>`
    SELECT organization_id, owner_user_id FROM memories WHERE id = ${memoryId} AND deleted_at IS NULL FOR SHARE`;
  if (!row) return { found: false, owner: null };
  return { found: true, owner: memoryOwnerRef({ organizationId: row.organization_id, ownerUserId: row.owner_user_id }) };
}

export async function checkAssetBytesHeadroom(
  db: Pick<PrismaClient, '$transaction'>,
  memoryId: string,
  bytes: number | bigint,
  caller: { userId: string } | null,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const { found, owner } = await lockMemoryOwner(tx, memoryId);
    if (!found) return; // the door has judged the memory's existence and access; a missing row counts for nobody
    await requireAssetBytesHeadroom(tx, owner, bytes, caller);
  });
}
