import type { PrismaClient } from '../../generated/prisma/index.js';
import { getOrgReadableMemoryIds } from './orgReadableMemory.js';
import { getOrgWritableMemoryIds, getSubscribedWritableMemoryIds } from './orgWritableMemory.js';

/**
 * #3280 / cor:dmo:050:09 / ruling0105 A: a user's own level for item-eligible
 * memories, with NO App membership or Agent-item fold. Uses the same org,
 * PUBLIC, MemoryMember and subscription predicates as getAccessibleMemoryIds
 * with excludeAppDerived, plus its non-personal ownership clause.
 *
 * Personal/private and per-user holdings never enter an ordinary item fold;
 * their owner/share rules remain at the existing strict gates. This map is a
 * ceiling on an item, not an additive grant and not a run's complete read set.
 */
export async function independentUserItemAccess(
  db: PrismaClient,
  userId: string,
): Promise<Map<string, string>> {
  if (!userId) return new Map();
  const [readable, writable, subscribedWrites, owned] = await Promise.all([
    getOrgReadableMemoryIds(db, userId),
    getOrgWritableMemoryIds(db, userId),
    getSubscribedWritableMemoryIds(db, userId),
    db.memory.findMany({
      where: {
        ownerUserId: userId, class: { notIn: ['personal', 'private'] },
        isInstallMemory: false, deletedAt: null,
      },
      select: { id: true },
    }),
  ]);
  const access = new Map(readable.map(id => [id, 'READ_ONLY']));
  for (const id of [...writable, ...subscribedWrites]) if (access.has(id)) access.set(id, 'READ_WRITE');
  for (const { id } of owned) access.set(id, 'READ_WRITE');
  return access;
}
