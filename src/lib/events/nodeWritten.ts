/**
 * `evt.node.written.v1` — the platform's first domain event.
 *
 * Published by node write surfaces (GraphQL writeNodeCore /
 * searchReplaceInNodes / mergeNodes, MCP hadron_create_node /
 * hadron_update_node) and standalone Edge CRUD after commit: outgoing edges
 * are serialized in the source node's Git file. Payload is IDs and
 * routing metadata ONLY — never node content (plaintext must not transit
 * the broker; subscribers re-read from the DB, which is also what makes
 * duplicate delivery harmless).
 *
 * Consumer today: the git mirror (re-read + push). The point of the event is
 * that the write core no longer knows that list — a new module that cares
 * about writes registers a subscriber; the write paths don't change.
 * (The embedding wake deliberately does NOT ride this event: it must be
 * published AFTER the durable embeddingPendingAt stamp, an ordering only the
 * embedding module itself can guarantee — see enqueueNodeEmbedding. A fact
 * event emitted by the write path can't carry that ordering; PR-507 review.)
 *
 * Delivery — per handler, not per process (PR-507 review):
 *   - A handler whose bus subscription is confirmed ACTIVE (the module
 *     called setNodeWrittenBusActive after subscribing) is served by the
 *     durable fan-out (at-least-once; handlers are idempotent).
 *   - Every OTHER registered handler gets the LOCAL in-process dispatch off
 *     a setImmediate — this covers bus-off deployments (D-2026-06-17-004)
 *     AND the bus-on-but-subscription-dead window (boot subscribe failure,
 *     broker recovered after boot): mirroring must not silently stop just
 *     because the broker accepted the publish. The durable replay may later
 *     deliver the same event to a recovered subscriber — idempotent
 *     re-mirror, harmless.
 *
 * NOT published by syncGraphFromGithub: a git-sync-triggered event would
 * bounce straight back into the git mirror (echo loop). Sync keeps its
 * direct embedding enqueue.
 */

import { getBusClient } from '../bus/index.js';

export const NODE_WRITTEN_SUBJECT = 'evt.node.written.v1';

/** IDs + routing metadata only — see the module contract above. */
export interface NodeWrittenEvent {
  nodeId: string;
  memoryId: string;
  /** Caller-supplied repo hint for the git mirror ('' when unknown). */
  ownerRepo?: string;
  /** Attribution for the git commit trailer. */
  clientId?: string | null;
}

/** Runtime shape check for bus-delivered payloads (at-least-once, unowned wire). */
export function isNodeWrittenEvent(payload: unknown): payload is NodeWrittenEvent {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.nodeId === 'string' && typeof p.memoryId === 'string';
}

type LocalHandler = (evt: NodeWrittenEvent) => Promise<void>;

const localHandlers = new Map<string, LocalHandler>();
// Handlers whose durable bus subscription is currently confirmed active —
// these are served by the broker fan-out, so the local dispatch skips them.
const busActiveHandlers = new Set<string>();

/**
 * Register a module's in-process fallback handler (keyed by the same name
 * as its durable bus consumer; re-registering replaces). Runs ONLY when the
 * bus is unavailable — with a broker connected, delivery goes through the
 * durable subscription instead.
 */
export function registerNodeWrittenLocalHandler(name: string, handler: LocalHandler): void {
  localHandlers.set(name, handler);
}

/**
 * Mark a handler's durable bus subscription as active/inactive. While
 * active, the local dispatch skips that handler (the broker delivers);
 * call with false on unsubscribe so the local path takes over again.
 * A handler that never confirms stays on local dispatch even when
 * publishes succeed — a reachable broker does NOT imply a live subscriber
 * (PR-507 review).
 */
export function setNodeWrittenBusActive(name: string, active: boolean): void {
  if (active) busActiveHandlers.add(name);
  else busActiveHandlers.delete(name);
}

/** Test hook: drop all local handlers + bus-active marks. */
export function clearNodeWrittenLocalHandlers(): void {
  localHandlers.clear();
  busActiveHandlers.clear();
}

/**
 * Emit the event, post-commit and fire-and-forget: a broker outage or a
 * failing subscriber must never break the write path (same posture as the
 * embedding enqueue). Bus available → durable publish; otherwise → local
 * fallback dispatch. Never throws.
 */
export async function publishNodeWritten(evt: NodeWrittenEvent): Promise<void> {
  let published = false;
  try {
    const bus = await getBusClient();
    if (bus) {
      await bus.publish(NODE_WRITTEN_SUBJECT, evt, {
        // Unique per publish: dedup only guards broker-level retries, not
        // distinct writes of the same node (mirrors publishEmbedWake).
        idempotencyKey: `${evt.nodeId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      });
      published = true;
    }
  } catch (err) {
    // Fall through to the local path — a publish failure downgrades the
    // transport, it doesn't drop the side effects.
    console.error('[events] node.written publish error — dispatching locally:', err);
  }
  // Local dispatch for every handler the broker is NOT confirmed to serve:
  // all of them when the publish didn't happen, and the not-bus-active ones
  // even when it did (a reachable broker ≠ a live subscriber — PR-507
  // review; without this, a boot-time subscribe failure silently parks
  // events in the stream until a restart).
  for (const [name, handler] of localHandlers) {
    if (published && busActiveHandlers.has(name)) continue;
    setImmediate(() => {
      handler(evt).catch((err) => {
        console.error(`[events] local node.written handler "${name}" error:`, err);
      });
    });
  }
}
