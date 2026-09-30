/**
 * An Edge is serialized inside its source Node's Git file. Edge CRUD therefore
 * announces the source after commit, just as a Node write does. The ordinary
 * subscriber re-reads the committed Node plus outgoing edges. Encrypted
 * memories need a request-time direct export because the subscriber has no
 * session key and deliberately skips them.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { publishNodeWritten } from '../../lib/events/nodeWritten.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { decryptNodeFieldsWithKey } from '../../lib/nodeCrypto.js';
import { deserializeTags } from '../db/provider.js';
import { writeNodeToGit } from './writeNodeToGit.js';

export async function mirrorEdgeSourceAfterCommit(
  db: PrismaClient,
  source: { id: string; memoryId: string; ownerRepo?: string | null },
  clientId?: string | null,
): Promise<void> {
  void publishNodeWritten({
    nodeId: source.id,
    memoryId: source.memoryId,
    ownerRepo: source.ownerRepo ?? '',
    clientId,
  });

  try {
    const memory = await db.memory.findUnique({
      where: { id: source.memoryId },
      select: { isEncrypted: true },
    });
    if (!memory?.isEncrypted) return;
    // Build plaintext while this request is still active. A per-request key
    // cannot be captured by a fire-and-forget callback after the response.
    const node = await db.node.findUnique({
      where: { id: source.id },
      include: { outgoingEdges: { include: { target: true } } },
    });
    if (!node || node.deletedAt || node.memoryId !== source.memoryId) return;
    const key = sessionKeyCache.getByMemoryId(source.memoryId);
    if (!key) {
      console.warn(`[edge-mirror] encrypted source ${source.id} has no active session key; skipping direct Git mirror`);
      return;
    }
    decryptNodeFieldsWithKey(node, key);
    void writeNodeToGit({
      id: node.id,
      loc: node.loc,
      name: node.name,
      nodeType: node.nodeType,
      objectType: node.objectType,
      alias: node.alias,
      description: node.description,
      abstract: node.abstract,
      abstractOriginHash: node.abstractOriginHash,
      contentHash: node.contentHash,
      content: node.content,
      tags: deserializeTags(node.tags) as string[],
      seq: node.seq,
      data: node.data,
      properties: node.properties,
      role: node.role ?? null,
      isRunnable: node.isRunnable ?? null,
      isPlaceholder: node.isPlaceholder,
      outgoingEdges: node.outgoingEdges,
      mirrorRevSeq: node.revSeq,
    }, source.ownerRepo ?? '', clientId, source.memoryId).catch((error) => {
      console.error('[edge-mirror] encrypted source Git write error:', error);
    });
  } catch (error) {
    // The Edge transaction has committed. Mirror preparation must never
    // convert that success into a reported mutation failure.
    console.error('[edge-mirror] encrypted source Git write error:', error);
  }
}
