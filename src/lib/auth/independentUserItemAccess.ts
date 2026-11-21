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
 *
 * #3326: `candidateIds` narrows the SAME four predicates to the memories a caller is about to judge (an Agent's
 * item memories), so the work is bounded by them and not by everything the user can reach. The answer is exactly the
 * complete answer restricted to those ids: nothing is added, nothing is cached between calls, and every call reads
 * the user's authority afresh. An empty list judges nothing and issues no query. Omitted, it is the complete set.
 */
export async function independentUserItemAccess(
  db: PrismaClient,
  userId: string,
  candidateIds?: readonly string[],
): Promise<Map<string, string>> {
  if (!userId) return new Map();
  const candidates = candidateIds ? [...new Set(candidateIds)] : undefined;
  if (candidates && candidates.length === 0) return new Map();
  const [readable, writable, subscribedWrites, owned] = await Promise.all([
    getOrgReadableMemoryIds(db, userId, candidates),
    getOrgWritableMemoryIds(db, userId, candidates),
    getSubscribedWritableMemoryIds(db, userId, candidates),
    db.memory.findMany({
      where: {
        ...(candidates ? { id: { in: candidates } } : {}),
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
