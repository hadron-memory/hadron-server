import { COMPILED_BOOT_PROMPT_NODE_TYPE, assertBootPromptWriteAllowed, bootPromptCompiledWriteError, isBootPromptRole } from '../../lib/bootPrompt.js';
import { assertIncludesWritable, syncDerivedIncludesEdges } from '../../lib/includes/writeIncludes.js';
import type { Node } from '../../index.d.js';
import { runAsSystem } from '../../lib/requestActor.js';
import { GRAPHS_PATH } from '../../config.js';
import { generateId } from '../../lib/id.js';
import { db } from '../../integrations/db/client.js';
import { serializeTags } from '../../integrations/db/provider.js';
import { authoredContentChanged, clearNodeAuthorship } from '../../lib/nodeAuthorship.js';
import { saveNodeToFs } from '../../integrations/localFs/saveNodeToFs.js';
import {
  ensureCurrentNodeRevisionInTransaction,
  buildNodeRevisionSnapshot,
  revisionStateHashRefreshMarker,
  createNodeRevision,
  diffNodeChanges,
} from '../../lib/nodeRevisionSnapshot.js';
import {
  acquireLockSet,
  ancestorLocs,
  lockAncestorsForCreate,
  lockLocForWrite,
} from '../../lib/nodeSubtreeLock.js';

/**
 * Create a new node: save to filesystem and upsert into the database.
 */
const createNodeAsSystem = async (
  node: Partial<Node> & { memoryId: string },
): Promise<Node> => {
  if (!node.loc || !node.name || !node.memoryId) {
    throw new Error('Node requires loc, name, and memoryId');
  }
  const loc = node.loc;
  const name = node.name;

  // Save to filesystem
  const fsResult = await saveNodeToFs(node, GRAPHS_PATH);
  if (fsResult.error) {
    throw new Error(`Failed to save node to filesystem: ${fsResult.error}`);
  }

  const id = node.id ?? generateId();
  const serializedTags = serializeTags(node.tags ?? []) as string[];
  const content = node.content ?? null;
  const fields = {
    name,
    alias: node.alias ?? null,
    description: node.description ?? null,
    content,
    contentHash: node.contentHash ?? null,
    tags: serializedTags,
    ownerRepo: node.ownerRepo ?? null,
  };

  const saved = await db.$transaction(async (tx) => {
    // This legacy controller is still a real authoring seam. Declare its whole
    // path lock-set first, then use the normal create/update helpers for their
    // authoritative gates. A second call at the same loc must snapshot the
    // first state exactly like GraphQL and MCP do.
    await acquireLockSet(tx, [
      ...ancestorLocs(loc).map((ancestorLoc) => ({ memoryId: node.memoryId, loc: ancestorLoc })),
      { memoryId: node.memoryId, loc },
    ]);
    await lockAncestorsForCreate(tx, node.memoryId, loc);
    await lockLocForWrite(tx, node.memoryId, loc);

    const prior = await tx.node.findUnique({
      where: { loc_memoryId: { loc, memoryId: node.memoryId } },
      select: { id: true },
    });
    // Row lock + drift reconciled as its own revision before the snapshot
    // (@copilot, PR #1339), then the authoritative re-read it is built from.
    if (prior) await ensureCurrentNodeRevisionInTransaction(tx, prior.id, { expectedMemoryId: node.memoryId });
    const existing = prior ? await tx.node.findUnique({ where: { id: prior.id } }) : null;
    // The upsert below targets (loc, memory); the lock was taken by id. A row
    // that moved in between must refuse, not be snapshotted here while a
    // duplicate lands at the old address (@copilot, PR #1339).
    if (prior && (!existing || existing.loc !== loc || existing.memoryId !== node.memoryId)) {
      throw new Error(`createNode: the node at "${loc}" moved during the write; retry.`);
    }
    // #2043 — defensive: no boot-prompt role or compiled marker reaches this
    // legacy path today (memory-root creation only); a future caller must not reopen it.
    if (isBootPromptRole((node as { role?: string | null }).role) || (node as { nodeType?: string | null }).nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE) {
      throw bootPromptCompiledWriteError('create', 'produces');
    }
    assertBootPromptWriteAllowed(existing, {}, 'update');
    let authoredEdit = false;
    if (existing) {
      const changes = diffNodeChanges(existing, fields);
      authoredEdit = authoredContentChanged(changes);
      // An identical re-save is not a revision (@codex P2, PR #1339): a
      // snapshot here would manufacture history on every idempotent save and
      // evict real revisions under maxRevCount.
      if (changes.length > 0) {
        await createNodeRevision(
          tx,
          buildNodeRevisionSnapshot(
            existing,
            { userId: null, info: 'controller:createNode' },
            { changes },
          ),
        );
      }
    }

    const written = await tx.node.upsert({
      where: { loc_memoryId: { loc, memoryId: node.memoryId } },
      create: {
        id,
        memoryId: node.memoryId,
        loc,
        ...fields,
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
      update: {
        ...fields,
        ...(authoredEdit ? clearNodeAuthorship() : {}),
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
      include: {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      },
    });
    // #2040 — this legacy seam runs as the system with no principal, so tags
    // reach only the node's own memory; a refusal rolls the write back. With no
    // writing person it skips the writer's read check (#2041 S2b). Its only
    // callers write a new memory's root node, with no caller content.
    const tags = await assertIncludesWritable(tx, written, content, [node.memoryId], undefined, { includeSystemWrite: true });
    await syncDerivedIncludesEdges(tx, written, tags, [node.memoryId]);
    return written;
  });

  return saved as unknown as Node;
};

/**
 * #1610: server scaffolding (a new memory's root node); its revision editor is
 * `controller:createNode`, so the node write runs as the system too.
 */
export const createNode: typeof createNodeAsSystem = (...args) =>
  runAsSystem(() => createNodeAsSystem(...args));
