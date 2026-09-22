/**
 * Durable recovery for PendingEdges retargeted to a stable node id.
 *
 * Inline MCP/Git promotion is the low-latency path, but the PendingEdge row is
 * the durable queue: this sweep selects only explicitly marked stable-id work
 * and joins the unwrapped id to `nodes.id` after process restarts or transient
 * failures. Loc-keyed forward references remain parked even when their string
 * happens to equal an unrelated node id.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import {
  PENDING_EDGE_STABLE_TARGET_PREFIX,
  promotePendingEdgeForTarget,
  reconcileAllPendingEdgeCounts,
} from '../lib/pendingEdgePromotion.js';

export interface PendingEdgePromotionSweepOutcome {
  promoted: number;
  failed: number;
  examined: number;
}

export async function runPendingEdgePromotionSweep(
  db: PrismaClient = defaultDb,
  batchSize = 100,
): Promise<PendingEdgePromotionSweepOutcome> {
  const candidates = await db.$queryRaw<Array<{ id: string; targetId: string }>>`
    SELECT p.id, n.id AS "targetId"
    FROM pending_edges p
    JOIN nodes n
      ON n.id = substring(
        p.target_id FROM char_length(${PENDING_EDGE_STABLE_TARGET_PREFIX}) + 1
      )
    WHERE p.deleted_at IS NULL
      AND starts_with(p.target_id, ${PENDING_EDGE_STABLE_TARGET_PREFIX})
    ORDER BY p.updated_at ASC NULLS FIRST, p.id ASC
    LIMIT ${batchSize}
  `;

  const outcome: PendingEdgePromotionSweepOutcome = {
    promoted: 0,
    failed: 0,
    examined: candidates.length,
  };
  for (const candidate of candidates) {
    try {
      await promotePendingEdgeForTarget(candidate.id, candidate.targetId, {
        db,
        // The periodic sweep is the durable retry. Avoid stacking an
        // additional process-local timer when movement consumes this pass.
        scheduleFastRetry: false,
      });
      if (!(await db.pendingEdge.findUnique({ where: { id: candidate.id } }))) {
        outcome.promoted += 1;
      }
    } catch (error) {
      outcome.failed += 1;
      console.error(`[pending-edge-promotion] sweep failed for ${candidate.id}`, error);
      // Retained failures must move behind unexamined work; otherwise the same
      // oldest full batch can starve every newer resolvable row forever.
      await db.pendingEdge.updateMany({
        where: { id: candidate.id, deletedAt: null },
        data: { updatedAt: new Date() },
      }).catch((rotationError) => {
        console.error(`[pending-edge-promotion] failed to rotate ${candidate.id}`, rotationError);
      });
    }
  }
  // A source hard-delete cascades its PendingEdges before this sweep can see
  // them. Reconcile from the authoritative live rows so those lost links, plus
  // legacy/MCP rows that were never incrementally credited, self-heal too.
  await reconcileAllPendingEdgeCounts(db);
  return outcome;
}

export interface PendingEdgePromotionLoop {
  stop: () => Promise<void>;
}

/** Start the durable promotion sweep. The stop handle keeps tests/shutdowns timer-safe. */
export function startPendingEdgePromotionSweepLoop(
  db: PrismaClient = defaultDb,
  intervalMs = 30_000,
  initialDelayMs = 5_000,
): PendingEdgePromotionLoop {
  let stopped = false;
  let interval: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const run = () => {
    if (stopped || running) return;
    running = runPendingEdgePromotionSweep(db)
      .then((outcome) => {
        if (outcome.promoted || outcome.failed) {
          console.log(
            `[pending-edge-promotion] promoted=${outcome.promoted} failed=${outcome.failed} examined=${outcome.examined}`,
          );
        }
      })
      .catch((error) => {
        console.error('[pending-edge-promotion] sweep failed', error);
      })
      .finally(() => {
        running = null;
      });
  };

  const initial = setTimeout(() => {
    if (stopped) return;
    run();
    interval = setInterval(run, intervalMs);
  }, initialDelayMs);

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(initial);
      if (interval) clearInterval(interval);
      await running;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPendingEdgePromotionSweep()
    .then((outcome) => {
      console.log(JSON.stringify({ ...outcome, ranAt: new Date().toISOString() }));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
