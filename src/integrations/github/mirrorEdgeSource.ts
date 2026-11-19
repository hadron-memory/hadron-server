/**
 * An Edge is serialized inside its source Node's Git file. Edge CRUD therefore
 * announces the source after commit, just as a Node write does. The ordinary
 * subscriber re-reads the committed Node plus outgoing edges. An encrypted
 * memory never syncs to Git (R206, cor:sec:040:05), so the subscriber records
 * a typed skip for it and there is no key-carrying alternative export.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { publishNodeWritten } from '../../lib/events/nodeWritten.js';

export async function mirrorEdgeSourceAfterCommit(
  _db: PrismaClient,
  source: { id: string; memoryId: string; ownerRepo?: string | null },
  clientId?: string | null,
): Promise<void> {
  void publishNodeWritten({
    nodeId: source.id,
    memoryId: source.memoryId,
    ownerRepo: source.ownerRepo ?? '',
    clientId,
  });
}
