import type { PrismaClient } from '../../generated/prisma/index.js';
import { deleteSecretsForOwner } from '../../lib/secrets.js';
import { deleteOwnerLimits, type OwnerLimitChange } from '../../lib/ownerLimits/changes.js';
import { revokeAllOrgInvitations } from '../../lib/auth/revokeOrgInvitations.js';
import { softDeleteChatToolConnections, type ChatToolTeardown } from '../../lib/chatToolTeardown.js';

/**
 * The ONE org soft-delete cascade (extracted from the `deleteOrganization`
 * resolver for #662 so `deleteUser`'s sole-member-org branch reuses it rather
 * than inventing a parallel path): soft-delete the Organization row,
 * hard-delete its org-scoped secrets (#677) and remove the link to it from its
 * credit ledger entries, which are kept (#5302, cor:dmo:170:08).
 *
 * App-/memory-scoped secrets under the org are cleaned up when those entities
 * are themselves deleted — this removes only the org's own secrets, mirroring
 * the non-cascading org soft-delete. The `updateMany` deletedAt-null guard
 * keeps the original `deletedAt` under a concurrent double-delete; the secret
 * sweep runs unconditionally (idempotent) so a straggler raced in during
 * deletion is still removed.
 *
 * `db` accepts a Prisma tx client — callers own the transaction boundary.
 * Returns the chat tool registrations this call removed, for the caller to tear down after commit (#4828).
 * `deletedBy` is recorded when provided (deleteUser passes the actor;
 * deleteOrganization historically records none and passes nothing).
 */
export async function softDeleteOrganizationCore(
  db: Pick<PrismaClient, 'organization' | 'secret' | 'userInvitation' | 'orgMemberInvitation' | 'ownerLimit' | '$queryRaw' | '$executeRaw'>,
  orgId: string,
  deletedBy?: string | null,
  /** Who the removed chat tool connections are recorded as deleted by; defaults to `deletedBy` (deleteOrganization stamps none on the org row, but knows its actor). */
  connectionDeletedBy?: string | null,
  /** #5009: collects the limit rows removed here; the CALLER logs them after its commit. */
  limitChanges?: OwnerLimitChange[],
): Promise<ChatToolTeardown[]> {
  await db.organization.updateMany({
    where: { id: orgId, deletedAt: null },
    data: { deletedAt: new Date(), ...(deletedBy != null ? { deletedBy } : {}) },
  });
  // #5302 (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, S2): the organization's credit ledger entries are kept, with the link to
  // it removed, in this transaction. Only the owner column changes; the append-only trigger admits exactly this, and only once
  // the organization has no live row (the update above). Unconditional, like the secret sweep: a repeat clears nothing new.
  await db.$executeRaw`UPDATE credit_ledger_entries SET organization_id = NULL WHERE organization_id = ${orgId}`;
  await revokeAllOrgInvitations(db, orgId, deletedBy ?? null);
  await deleteSecretsForOwner(db, 'org', orgId);
  // #5009: a limit is a setting and goes with its owner; the row is kept, so the FK cascade never fires.
  const removedLimits = await deleteOwnerLimits(db, { organizationId: orgId }, 'owner-deleted');
  limitChanges?.push(...removedLimits);
  // #4828: the organization's Telegram and Slack registrations go in the same transaction; the CALLER asks the tools to drop their
  // side after the commit (dispatchChatToolTeardown). A row already deleted is not returned, so a repeat asks nothing.
  return softDeleteChatToolConnections(db, { organizationId: orgId }, connectionDeletedBy ?? deletedBy ?? null);
}
