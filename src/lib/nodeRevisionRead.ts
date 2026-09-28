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
    const key = sessionKeyCache.getByMemoryId(memoryId);
    // Node reads retain ciphertext when the memory is locked. Revision reads
    // have the same response shape and never persist the decrypted copy.
    return key ? decryptNodeFieldsWithKey({ ...revision }, key) : revision;
  });
}
