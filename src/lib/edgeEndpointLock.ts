import type { Prisma } from '../generated/prisma/index.js';
import { lockMemoriesForChannelChange } from './channels.js';

export interface EdgeEndpointSnapshot {
  id: string;
  loc: string;
  memoryId: string;
}

/**
 * Serialize a singular edge insert with Channel reuse in either endpoint's
 * memory, then prove that both endpoints are still the live rows the caller
 * authorized and resolved before entering the transaction.
 *
 * Channel reuse tombstones the previous transcript while holding the same
 * memory-scoped advisory key. Without this handshake an edge insert can race
 * after reuse's edge sweep but before its message tombstones commit, leaving a
 * live edge that exposes a deleted message through endpoint hydration.
 *
 * Multiple memory keys are acquired in resolved signed-key order, matching
 * the bulk mutation gate and preventing cross-memory edges from deadlocking
 * when two callers name the same pair in opposite directions.
 */
export async function lockLiveEdgeEndpoints(
  tx: Prisma.TransactionClient,
  source: EdgeEndpointSnapshot,
  target: EdgeEndpointSnapshot,
): Promise<{ source: EdgeEndpointSnapshot | null; target: EdgeEndpointSnapshot | null }> {
  const live = await lockLiveEdgeEndpointSet(tx, [source, target]);
  return { source: live.get(source.id) ?? null, target: live.get(target.id) ?? null };
}

/** The set form used by node writes that replace several outgoing edges. */
export async function lockLiveEdgeEndpointSet(
  tx: Prisma.TransactionClient,
  endpoints: readonly EdgeEndpointSnapshot[],
): Promise<Map<string, EdgeEndpointSnapshot>> {
  await lockEdgeEndpointMemories(tx, endpoints.map((endpoint) => endpoint.memoryId));
  return liveEdgeEndpointSet(tx, endpoints);
}

/**
 * Acquire the Channel-reuse keys for a complete edge-endpoint memory set.
 *
 * Inline node writes call this before taking any loc lock or changing the
 * source node, then revalidate with `liveEdgeEndpointSet` after the source
 * write but before replacing its edges. Splitting those two phases lets the
 * source mutation and edge replacement share one transaction without trying
 * to validate a source row that a create has not inserted yet.
 */
export async function lockEdgeEndpointMemories(
  tx: Prisma.TransactionClient,
  memoryIds: readonly string[],
): Promise<void> {
  await lockMemoriesForChannelChange(tx, memoryIds);
}

/** Revalidate endpoint identity and liveness while the caller holds its memory keys. */
export async function liveEdgeEndpointSet(
  tx: Prisma.TransactionClient,
  endpoints: readonly EdgeEndpointSnapshot[],
): Promise<Map<string, EdgeEndpointSnapshot>> {
  const rows = await tx.node.findMany({
    where: { id: { in: [...new Set(endpoints.map((endpoint) => endpoint.id))] }, deletedAt: null },
    select: { id: true, loc: true, memoryId: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const live = new Map<string, EdgeEndpointSnapshot>();
  for (const snapshot of endpoints) {
    const current = byId.get(snapshot.id);
    if (current && current.loc === snapshot.loc && current.memoryId === snapshot.memoryId) {
      live.set(snapshot.id, current);
    }
  }
  return live;
}
