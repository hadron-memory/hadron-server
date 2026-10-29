/**
 * Git mirror as an `evt.node.written.v1` subscriber (event pivot).
 *
 * The write paths used to call writeNodeToGit directly with the node
 * in-closure; now they emit the event and this module re-reads the node and
 * mirrors it. Re-reading (instead of shipping content on the bus) is what
 * keeps the event payload IDs-only AND makes duplicate delivery free: two
 * deliveries mirror the same latest state.
 *
 * ENCRYPTED memories never sync to Git (R206, cor:sec:040:05), with or without
 * a key: there is no direct request-time write for them either. A configured
 * mirror that was attempted is logged as ENCRYPTED_GIT_SYNC_UNAVAILABLE.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { getBusClient } from '../../lib/bus/index.js';
import {
  NODE_WRITTEN_SUBJECT,
  isNodeWrittenEvent,
  registerNodeWrittenLocalHandler,
  setNodeWrittenBusActive,
  type NodeWrittenEvent,
} from '../../lib/events/nodeWritten.js';
import { deserializeTags } from '../db/provider.js';
import { writeNodeToGit, type NodeForGit } from './writeNodeToGit.js';
import { logEncryptedGitSyncRefusal } from './encryptedGitSync.js';

/** Durable-consumer + local-fallback registration name. */
export const GIT_MIRROR_SUBSCRIBER = 'git-mirror';

/**
 * Handle one event: re-read the node (with outgoing edges) and mirror it to
 * the memory's git repo. Resolves as a no-op for a node that vanished or was
 * deleted since the event (mirror-on-delete is deleteNode's own concern) and
 * for encrypted memories, which log a typed skip (see the module contract). writeNodeToGit handles
 * its own soft failures (missing repo, no clone) by logging.
 */
export async function handleNodeWrittenForGit(
  db: PrismaClient,
  evt: NodeWrittenEvent,
): Promise<void> {
  const node = await loadNodeForGit(db, evt);
  if (!node) return;
  await writeNodeToGit(
    node,
    evt.ownerRepo ?? '',
    evt.clientId ?? null,
    evt.memoryId,
    () => loadNodeForGit(db, evt),
  );
}

async function loadNodeForGit(
  db: PrismaClient,
  evt: NodeWrittenEvent,
): Promise<NodeForGit | null> {
  const node = await db.node.findUnique({
    where: { id: evt.nodeId },
    include: { outgoingEdges: { include: { target: true } } },
  });
  if (!node || node.deletedAt) return null;
  // The event's memoryId must agree with the node's actual memory: routing
  // (target repo) and the encryption gate below both key off it, so a
  // mismatched (corrupt/forged) event could mirror one memory's node into
  // another memory's repository (PR-507 review, Codex P2). Refuse, loudly.
  if (node.memoryId !== evt.memoryId) {
    console.warn(
      `[git-mirror] node.written memoryId mismatch — node ${evt.nodeId} lives in ` +
        `${node.memoryId}, event claims ${evt.memoryId}; skipping`,
    );
    return null;
  }
  const memory = await db.memory.findUnique({
    where: { id: evt.memoryId },
    select: { isEncrypted: true, source: true },
  });
  if (!memory) return null;
  // R206 (cor:sec:040:05): an encrypted memory never syncs to Git, with or
  // without a key. A configured mirror that was attempted is an observable
  // typed skip, not a silent null; a memory with no source has nothing to skip.
  if (memory.isEncrypted) {
    if (memory.source) logEncryptedGitSyncRefusal('node.written mirror', evt.memoryId);
    return null;
  }
  return {
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
      // #1218 — the mirror carries the governed signals.
      role: node.role ?? null,
      isRunnable: node.isRunnable ?? null,
      isPlaceholder: node.isPlaceholder,
      outgoingEdges: node.outgoingEdges ?? [],
    };
}

/**
 * Wire the git mirror into the event flow: ALWAYS registers the in-process
 * fallback (so bus-off deployments keep mirroring), then adds the durable
 * bus subscription when a broker is available. The local handler stays the
 * delivery path until the subscription is CONFIRMED active
 * (setNodeWrittenBusActive) — a reachable broker with a failed/never-started
 * subscriber must not silently park events in the stream (PR-507 review,
 * Codex P2). Returns the bus unsubscribe function (which also flips the
 * handler back to local dispatch), or null when the bus is off.
 */
export async function startGitMirrorSubscriber(
  db: PrismaClient,
): Promise<(() => Promise<void>) | null> {
  registerNodeWrittenLocalHandler(GIT_MIRROR_SUBSCRIBER, (evt) =>
    handleNodeWrittenForGit(db, evt),
  );
  const bus = await getBusClient();
  if (!bus) return null;
  const unsubscribe = await bus.subscribePubSub(
    NODE_WRITTEN_SUBJECT,
    GIT_MIRROR_SUBSCRIBER,
    async (msg) => {
      // Shape-check the wire payload; malformed events are logged and acked
      // (terminating garbage beats redelivering it — PR-489 posture).
      if (!isNodeWrittenEvent(msg.payload)) {
        console.warn('[git-mirror] ignoring malformed node.written payload:', msg.payload);
        return;
      }
      await handleNodeWrittenForGit(db, msg.payload);
    },
  );
  setNodeWrittenBusActive(GIT_MIRROR_SUBSCRIBER, true);
  console.log(`[git-mirror] bus subscriber active on ${NODE_WRITTEN_SUBJECT}`);
  return async () => {
    setNodeWrittenBusActive(GIT_MIRROR_SUBSCRIBER, false);
    await unsubscribe();
  };
}
