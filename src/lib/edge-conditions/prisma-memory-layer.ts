/**
 * Prisma adapter that builds a `MemoryLayerHandle` for the edge-condition
 * evaluator. Lives next to the rest of the edge-conditions module but
 * is NOT re-exported from `index.ts` — call sites that want the pure
 * evaluator contract should not see Prisma types.
 *
 * Per spec FR-008/FR-009: walks the source-node's parent chain in a
 * single memory, deepest-wins. Per FR-014: when the memory is encrypted
 * and the active session has no key, every read returns
 * `{ ok: false, error: { reason: 'key_unavailable' } }` so the
 * evaluator surfaces MEMORY_ENCRYPTED_NO_KEY.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import type { MemoryLayerHandle } from './scope-resolver.js';

export async function buildPrismaMemoryLayer(
  db: PrismaClient,
  layerName: string,
  memoryId: string,
  sourceLoc: string,
): Promise<MemoryLayerHandle> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { id: true, isEncrypted: true, urn: true },
  });
  const isEncrypted = memory?.isEncrypted ?? false;
  const memoryUrn = memory?.urn ?? memoryId;

  if (isEncrypted) {
    const key = sessionKeyCache.getByMemoryId(memoryId);
    if (!key) {
      // Encrypted memory with no key → fail loud per spec FR-014.
      return {
        layerName,
        async read() {
          return {
            ok: false,
            error: { reason: 'key_unavailable' as const, memoryUrn },
          };
        },
      };
    }
  }

  // Build the ancestor loc list from root toward source. The bare
  // `data` node is always at the root — matches the legacy behavior
  // where conditions read from `loc: 'data'`.
  const ancestors: string[] = ['data'];
  if (sourceLoc) {
    const parts = sourceLoc.split(':');
    for (let i = 1; i <= parts.length; i++) {
      ancestors.push(parts.slice(0, i).join(':'));
    }
  }
  const nodes = await db.node.findMany({
    where: { memoryId, loc: { in: ancestors }, deletedAt: null },
    select: { loc: true, data: true },
  });
  if (isEncrypted) {
    for (const n of nodes) {
      decryptNodeFields(n, { id: memoryId, isEncrypted: true });
    }
  }
  const orderedData: Array<Record<string, unknown> | null> = ancestors.map((loc) => {
    const n = nodes.find((x) => x.loc === loc);
    return (n?.data as Record<string, unknown> | null) ?? null;
  });

  return {
    layerName,
    async read(path: string) {
      let value: unknown = undefined;
      for (const data of orderedData) {
        if (data === null) continue;
        const v = readDottedPath(data, path);
        if (v !== undefined) value = v;
      }
      return { ok: true, value };
    },
  };
}

function readDottedPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
