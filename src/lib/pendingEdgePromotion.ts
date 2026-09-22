import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { deriveEdgeLoc } from './edgeLoc.js';
import { lockEdgeEndpointMemories } from './edgeEndpointLock.js';
import { generateId } from './id.js';
import { acquireLockSet, ancestorLocs } from './nodeSubtreeLock.js';

class PendingEdgePromotionPreflightStale extends Error {}

const MAX_PENDING_EDGE_PROMOTION_RETRIES = 3;
const INITIAL_PENDING_EDGE_RETRY_DELAY_MS = 100;
const MAX_PENDING_EDGE_RETRY_DELAY_MS = 5_000;

async function retargetPendingEdgeToStableId(
  db: PrismaClient,
  pendingId: string,
  targetNodeId: string,
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const pending = await tx.pendingEdge.findUnique({ where: { id: pendingId } });
    if (!pending) return null;

    const duplicate = await tx.pendingEdge.findUnique({
      where: {
        sourceId_targetId: { sourceId: pending.sourceId, targetId: targetNodeId },
      },
    });
    if (duplicate && duplicate.id !== pending.id) {
      await tx.pendingEdge.delete({ where: { id: pending.id } });
      return duplicate.id;
    }

    await tx.pendingEdge.update({
      where: { id: pending.id },
      data: { targetId: targetNodeId },
    });
    return pending.id;
  });
}

/**
 * Promote one PendingEdge whose target is now known by stable node id.
 *
 * The endpoint memory keys and complete ancestor paths serialize this insert
 * with Channel reuse and subtree moves. A move is retried from fresh preflight;
 * deletion drops the now-unresolvable row. On repeated movement the pending
 * row is retargeted to the stable id and left as durable work for
 * `runPendingEdgePromotionSweep`; the timer is only a low-latency fast path.
 */
export async function promotePendingEdgeForTarget(
  pendingId: string,
  targetNodeId: string,
  opts: {
    db?: PrismaClient;
    retryDelayMs?: number;
    scheduleFastRetry?: boolean;
  } = {},
): Promise<void> {
  const db = opts.db ?? defaultDb;
  const retryDelayMs = opts.retryDelayMs ?? INITIAL_PENDING_EDGE_RETRY_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    const p = await db.pendingEdge.findUnique({ where: { id: pendingId } });
    if (!p) return;

    const [pSource, pTarget] = await Promise.all([
      db.node.findUnique({
        where: { id: p.sourceId },
        select: { id: true, loc: true, memoryId: true, deletedAt: true },
      }),
      db.node.findUnique({
        where: { id: targetNodeId },
        select: { id: true, loc: true, memoryId: true, deletedAt: true },
      }),
    ]);
    if (!pSource || pSource.deletedAt || !pTarget || pTarget.deletedAt) {
      await db.pendingEdge.deleteMany({ where: { id: p.id } });
      return;
    }

    try {
      const consumed = await db.$transaction(async (tx) => {
        await lockEdgeEndpointMemories(tx, [pSource.memoryId, pTarget.memoryId]);
        await acquireLockSet(tx, [
          ...ancestorLocs(pSource.loc).map((loc) => ({ memoryId: pSource.memoryId, loc })),
          { memoryId: pSource.memoryId, loc: pSource.loc },
          ...ancestorLocs(pTarget.loc).map((loc) => ({ memoryId: pTarget.memoryId, loc })),
          { memoryId: pTarget.memoryId, loc: pTarget.loc },
        ]);

        // The PendingEdge is part of the authoritative snapshot too. An
        // inline source update can deliberately remove it while this promoter
        // waits on the source-memory key (for example edges: []). Never
        // recreate that relationship from the stale outer `p` snapshot.
        const currentPending = await tx.pendingEdge.findUnique({ where: { id: p.id } });
        if (
          !currentPending ||
          currentPending.deletedAt ||
          currentPending.sourceId !== p.sourceId ||
          currentPending.targetId !== p.targetId ||
          currentPending.loc !== p.loc ||
          currentPending.name !== p.name
        ) {
          return false;
        }

        const currentRows = await tx.node.findMany({
          where: { id: { in: [pSource.id, pTarget.id] }, deletedAt: null },
          select: { id: true, loc: true, memoryId: true },
        });
        const currentById = new Map(currentRows.map((row) => [row.id, row]));
        const currentSource = currentById.get(pSource.id);
        const currentTarget = currentById.get(pTarget.id);

        if (
          (currentSource &&
            (currentSource.memoryId !== pSource.memoryId || currentSource.loc !== pSource.loc)) ||
          (currentTarget &&
            (currentTarget.memoryId !== pTarget.memoryId || currentTarget.loc !== pTarget.loc))
        ) {
          throw new PendingEdgePromotionPreflightStale();
        }

        if (currentSource && currentTarget) {
          const pEdgeLoc = currentPending.loc ?? deriveEdgeLoc(
            currentSource.loc,
            currentPending.name,
            currentTarget.loc,
          );
          await tx.edge.upsert({
            where: { loc_memoryId: { loc: pEdgeLoc, memoryId: currentSource.memoryId } },
            create: {
              id: generateId(),
              memoryId: currentSource.memoryId,
              sourceId: currentSource.id,
              targetId: currentTarget.id,
              loc: pEdgeLoc,
              name: currentPending.name,
            },
            update: {},
          });
        }
        const deleted = await tx.pendingEdge.deleteMany({
          where: {
            id: currentPending.id,
            sourceId: currentPending.sourceId,
            targetId: currentPending.targetId,
            deletedAt: null,
          },
        });
        if (deleted.count === 1) {
          // Git sync maintains this denormalized source-memory count. MCP and
          // hand-authored legacy rows may not have credited it, so clamp at
          // zero while decrementing atomically with promotion.
          await tx.$executeRaw`
            UPDATE memories
            SET pending_edge_count = GREATEST(pending_edge_count - 1, 0)
            WHERE id = ${pSource.memoryId}
          `;
        }
        return deleted.count === 1;
      });
      if (!consumed) return;
      return;
    } catch (error) {
      if (error instanceof PendingEdgePromotionPreflightStale) {
        if (attempt < MAX_PENDING_EDGE_PROMOTION_RETRIES) continue;

        const stablePendingId = await retargetPendingEdgeToStableId(db, p.id, targetNodeId);
        if (stablePendingId && opts.scheduleFastRetry !== false) {
          const timer = setTimeout(() => {
            void promotePendingEdgeForTarget(stablePendingId, targetNodeId, {
              db,
              retryDelayMs: Math.min(retryDelayMs * 2, MAX_PENDING_EDGE_RETRY_DELAY_MS),
            }).catch((retryError) => {
              console.error('[pending-edge-promotion] deferred retry failed', retryError);
            });
          }, retryDelayMs);
          timer.unref();
        }
        return;
      }
      throw error;
    }
  }
}
