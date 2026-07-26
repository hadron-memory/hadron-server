import type { PrismaClient } from '../../generated/prisma/index.js';
import { deleteSecretsForOwner } from '../../lib/secrets.js';

/**
 * The ONE org soft-delete cascade (extracted from the `deleteOrganization`
 * resolver for #662 so `deleteUser`'s sole-member-org branch reuses it rather
 * than inventing a parallel path): soft-delete the Organization row and
 * hard-delete its org-scoped secrets (#677).
 *
 * App-/memory-scoped secrets under the org are cleaned up when those entities
 * are themselves deleted — this removes only the org's own secrets, mirroring
 * the non-cascading org soft-delete. The `updateMany` deletedAt-null guard
 * keeps the original `deletedAt` under a concurrent double-delete; the secret
 * sweep runs unconditionally (idempotent) so a straggler raced in during
 * deletion is still removed.
 *
 * `db` accepts a Prisma tx client — callers own the transaction boundary.
 * `deletedBy` is recorded when provided (deleteUser passes the actor;
 * deleteOrganization historically records none and passes nothing).
 */
export async function softDeleteOrganizationCore(
  db: Pick<PrismaClient, 'organization' | 'secret'>,
  orgId: string,
  deletedBy?: string | null,
): Promise<void> {
  await db.organization.updateMany({
    where: { id: orgId, deletedAt: null },
    data: { deletedAt: new Date(), ...(deletedBy != null ? { deletedBy } : {}) },
  });
  await deleteSecretsForOwner(db, 'org', orgId);
}
