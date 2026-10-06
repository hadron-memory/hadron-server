import { Prisma } from '../../generated/prisma/index.js';

/** DV-B: strict-owner holdings outlive an App; detach before any App cascade. */
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
    data: { appId: null },
  });
}
