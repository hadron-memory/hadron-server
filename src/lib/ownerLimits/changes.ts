/** Removing an owner's limit rows with the owner, and the `owner.limits.changed` line every change writes (#5009). */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { AuthoritySnapshotStale } from '../auth/authorityAnchors.js';
import { ownerId, ownerType, type OwnerRef } from '../owner.js';
import { ownerLimitWhere } from './gate.js';

/** One row's change. A limit is `none` (no row, so the default applies), `unlimited` (a null row) or a base-10 number. */
export interface OwnerLimitChange {
  owner: OwnerRef;
  key: string;
  oldLimit: string;
  newLimit: string;
  origin: { sourceType: string; sourceId: string } | { reason: 'owner-deleted' | 'account-merge' };
}

export const NO_ROW = 'none';
export const limitText = (limitValue: bigint | null): string => (limitValue === null ? 'unlimited' : limitValue.toString());

/** Call AFTER the commit, so a rolled-back or retried attempt logs nothing. Ids and numbers only; the note is never logged. */
export function logOwnerLimitChanges(actorId: string | null, changes: readonly OwnerLimitChange[]): void {
  for (const c of changes) {
    console.log(JSON.stringify({
      event: 'owner.limits.changed', actorId, ownerType: ownerType(c.owner), ownerId: ownerId(c.owner), key: c.key,
      oldLimit: c.oldLimit, newLimit: c.newLimit, ...c.origin,
    }));
  }
}

/**
 * Delete every limit row of an owner that is going away, in the caller's transaction. The owner's own row is kept (soft delete), so the
 * foreign key's cascade never fires. Returns the changes for the caller to log after its commit.
 */
export async function deleteOwnerLimits(
  tx: Pick<PrismaClient, 'ownerLimit'>,
  owner: OwnerRef,
  reason: 'owner-deleted' | 'account-merge',
): Promise<OwnerLimitChange[]> {
  const where = ownerLimitWhere(owner);
  const rows = await tx.ownerLimit.findMany({ where, orderBy: { key: 'asc' } });
  if (rows.length > 0) await tx.ownerLimit.deleteMany({ where });
  return rows.map((r) => ({ owner, key: r.key, oldLimit: limitText(r.limitValue), newLimit: NO_ROW, origin: { reason } }));
}

/**
 * A SERIALIZABLE deletion that waited at the owner's anchor can hold a snapshot from before a setOwnerLimits committed, and would leave
 * that row behind. Compare with a fresh connection while the anchor keeps new writers out; a mismatch retries the whole transaction.
 */
export async function assertOwnerLimitSnapshotFresh(
  tx: Prisma.TransactionClient,
  db: PrismaClient,
  owners: readonly OwnerRef[],
): Promise<void> {
  const read = async (client: Pick<PrismaClient, 'ownerLimit'>) =>
    (await client.ownerLimit.findMany({ where: { OR: owners.map(ownerLimitWhere) }, select: { id: true }, orderBy: { id: 'asc' } }))
      .map((r) => r.id).join(',');
  if ((await read(tx)) !== (await read(db))) throw new AuthoritySnapshotStale();
}
