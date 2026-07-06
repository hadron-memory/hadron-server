/**
 * `evt.node.written.v1` — the platform's first domain event.
 *
 * Published by every node write surface (GraphQL writeNodeCore /
 * searchReplaceInNodes / mergeNodes, MCP hadron_create_node /
 * hadron_update_node) AFTER the write is committed. Payload is IDs and
 * routing metadata ONLY — never node content (plaintext must not transit
 * the broker; subscribers re-read from the DB, which is also what makes
 * duplicate delivery harmless).
 *
 * Consumers today: the git mirror (re-read + push) and the embedding wake
 * (marker check + embed). The point of the event is that the write core no
 * longer knows that list — a new module that cares about writes registers a
 * subscriber; the write paths don't change.
 *
 * Delivery:
 *   - Bus ON  → durable fan-out via subscribePubSub (each module has its own
 *     durable consumer; at-least-once, so handlers are idempotent).
 *   - Bus OFF (NATS_URL unset / broker down) → the LOCAL fallback: handlers
 *     registered via registerNodeWrittenLocalHandler run in-process off a
 *     setImmediate, preserving D-2026-06-17-004 (a missing broker never
 *     changes behavior, only transport).
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

/**
 * Register a module's in-process fallback handler (keyed by the same name
 * as its durable bus consumer; re-registering replaces). Runs ONLY when the
 * bus is unavailable — with a broker connected, delivery goes through the
 * durable subscription instead.
 */
export function registerNodeWrittenLocalHandler(name: string, handler: LocalHandler): void {
  localHandlers.set(name, handler);
}

/** Test hook: drop all local handlers. */
export function clearNodeWrittenLocalHandlers(): void {
  localHandlers.clear();
}

/**
 * Emit the event, post-commit and fire-and-forget: a broker outage or a
 * failing subscriber must never break the write path (same posture as the
 * embedding enqueue). Bus available → durable publish; otherwise → local
 * fallback dispatch. Never throws.
 */
export async function publishNodeWritten(evt: NodeWrittenEvent): Promise<void> {
  try {
    const bus = await getBusClient();
    if (bus) {
      await bus.publish(NODE_WRITTEN_SUBJECT, evt, {
        // Unique per publish: dedup only guards broker-level retries, not
        // distinct writes of the same node (mirrors publishEmbedWake).
        idempotencyKey: `${evt.nodeId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      });
      return;
    }
  } catch (err) {
    // Fall through to the local path — a publish failure downgrades the
    // transport, it doesn't drop the side effects.
    console.error('[events] node.written publish error — dispatching locally:', err);
  }
  for (const [name, handler] of localHandlers) {
    setImmediate(() => {
      handler(evt).catch((err) => {
        console.error(`[events] local node.written handler "${name}" error:`, err);
      });
    });
  }
}
