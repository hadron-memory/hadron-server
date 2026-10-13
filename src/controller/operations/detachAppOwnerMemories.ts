import { Prisma } from '../../generated/prisma/index.js';

/**
 * DV-B: strict-owner holdings outlive an App; detach before any App cascade.
 *
 * Both scope columns are cleared, so a detached holding is the owner's own
 * FREE-STANDING memory (spec 034), owner-keyed on every surface. Keeping the
 * Agent would leave the legacy shape (`app_id` NULL, Agent set), which MCP
 * admits to any App installing that Agent and refuses to the owner in every
 * other App (Rook's §10 P1-1 on #1673). Re-attaching (attachMemoryToApp) sets
 * both columns again.
 *
 * Existing MemoryShares on a detached PERSONAL holding are KEPT, by design:
 * the owner granted them. With the Agent cleared, a share no longer needs the
 * grantee to subscribe to the former Agent (effectiveAccess's licence check
 * applies only to an agent-scoped row). Revoking them on detach would be a
 * product ruling, pending with Holger.
 */
export async function detachAppOwnerMemories(
  tx: Prisma.TransactionClient,
  appIds: string[],
  deletingUserId?: string,
): Promise<void> {
  if (appIds.length === 0) return;
  // Exclude concurrent FK attachments while detaching and deleting the Apps.
  await tx.$queryRaw`SELECT id FROM apps WHERE id IN (${Prisma.join([...appIds].sort())}) ORDER BY id FOR UPDATE`;
  await tx.memory.updateMany({
    where: {
      appId: { in: appIds },
      class: { in: ['personal', 'private'] },
      ...(deletingUserId ? { userId: { not: deletingUserId } } : {}),
    },
    data: { appId: null, userMemoryOfAgentId: null },
  });
}
