import type { PrismaClient } from '../generated/prisma/index.js';
import { decryptNodeFieldsWithKey, type EncryptedNodeFields } from './nodeCrypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';

/** Decrypt only authorized snapshot rows, using each row's capture memory. */
export async function decryptReadableRevisions<
  T extends Partial<EncryptedNodeFields> & { memoryId: string | null },
>(db: PrismaClient, revisions: T[], fallbackMemoryId: string): Promise<T[]> {
  if (revisions.length === 0) return revisions;
  const memoryIds = [...new Set(revisions.map((revision) => revision.memoryId ?? fallbackMemoryId))];
  const memories = await db.memory.findMany({
    where: { id: { in: memoryIds } },
    select: { id: true, isEncrypted: true },
  });
  const encrypted = new Set(memories.filter((memory) => memory.isEncrypted).map((memory) => memory.id));
  return revisions.map((revision) => {
    const memoryId = revision.memoryId ?? fallbackMemoryId;
    if (!encrypted.has(memoryId)) return revision;
    // E1: retained approval values are inapplicable even when a key is held.
    const projected = { ...revision, approvedBy: null,
      approvedByInfo: null, approvedAt: null, approvalHash: null };
    const key = sessionKeyCache.getByMemoryId(memoryId);
    if (key) return decryptNodeFieldsWithKey(projected, key);
    // A marker-shaped old plaintext value is indistinguishable from an
    // envelope without the key. Conceal every encrypted field while locked;
    // otherwise an interrupted conversion can expose that plaintext.
    const locked = projected;
    locked.content = null;
    locked.abstract = null;
    locked.data = null;
    return locked;
  });
}
