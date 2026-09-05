/**
 * moveNodeSubtree — rebase a node AND its loc-subtree, within one memory OR
 * across memories (#768 same-memory rename; #781 cross-memory relocation).
 *
 * A node's parent/child relationship is expressed by its loc PREFIX (`a:b` is
 * the parent of `a:b:c`) and its URN is `<memoryUrn>::<loc>`. So relocating only
 * the named node stranded every descendant at its original loc, leaving their
 * computed URNs pointing under a parent path that no longer exists (#768). This
 * helper is the ONE shared implementation both the GraphQL `moveNode` resolver
 * and the MCP `hadron_move_node` tool call, so the two surfaces can't drift.
 *
 * It gathers the subtree (`<source.loc>` and each `<source.loc>:…` descendant,
 * on `:` path boundaries), rebases every loc onto `destLoc`, writes a pre-move
 * NodeRevision for each, and moves the rows BY ID (stable — every edge reference
 * stays valid). Nodes move in two phases (park at a unique temp loc, then the
 * final loc) so a rebase that overlaps the source subtree — e.g. moving `a:b`
 * UP to `a` sends grandchild `a:b:b` onto the source's old `a:b` slot — never
 * trips the `(loc, memoryId)` unique mid-transaction.
 *
 * **Cross-memory (`destMemoryId` ≠ the source's memory):** crossing a memory
 * boundary must respect the DESTINATION's write-path invariants:
 *   - REFUSED (CrossMemoryMoveUnsupportedError; #781 follow-ups) when either
 *     memory is ENCRYPTED (needs per-node re-encryption, cloneNode's path), or
 *     when the subtree contains a CHAT-root (its data.scope is tied to the
 *     memory class). GIT-BACKED memories were refused too until #1095, when
 *     `mirrorNodeMoveToGit` gave the move a repo-aware mirror; the caller fires
 *     it AFTER the transaction commits, using the `moved` list in the result.
 *   - Every moved node is validated against the destination's collection SCHEMA
 *     (the enforceNodeSchemaOnWrite gate) before any write.
 *   - Every moved node's `memoryId` becomes `destMemoryId`.
 *   - The moved nodes' `NodeEmbedding` rows are DELETED and re-indexed under the
 *     destination policy (not blindly relabeled, since policies can differ). The
 *     embedding markers are always re-stamped (fresh `embeddingPendingAt` +
 *     reset retry state when the dest indexes, cleared to null when it doesn't) —
 *     this also invalidates any in-flight source-side embed job so it can't
 *     re-insert a source-tagged vector for a node that has left the memory.
 *   - `Memory.pendingEdgeCount` credit for the moved subtree's live PendingEdges
 *     moves from the source memory to the destination.
 *   - Edges whose SOURCE moved follow it: `Edge.memoryId` (the denormalized
 *     source-side memory) becomes `destMemoryId` and the loc is re-derived from
 *     the rebased source + the target's loc (rebased when the target also moved),
 *     disambiguated against sibling and pre-existing destination edges so the
 *     `(loc, memoryId)` unique never trips. A boundary edge whose source did NOT
 *     move keeps its memoryId (its source didn't move) — it simply becomes a
 *     legitimate cross-memory edge, whose endpoints are gated by #783.
 * Same-memory moves change no `memoryId` and leave edges untouched (an edge's
 * loc is a derived denormalization; references are by stable id, so the graph
 * stays intact — same-memory edge-loc rebasing is the separate #781 concern).
 *
 * The CALLER owns: write-authorization to BOTH memories, the destination
 * ancestor lock (`lockAncestorsForCreate`), the same-slot no-op short-circuit,
 * any overwrite/eviction of the destination slot, and the post-move fetch/return
 * shape. `source` MUST be the full live node row (all revisioned fields loaded).
 */

import { deriveEdgeLoc } from './edgeLoc.js';
import { lockAncestorsForCreate, lockNodeForDelete } from './nodeSubtreeLock.js';
import type { Prisma } from '../generated/prisma/index.js';
import { normalizeObjectType } from './enforceNodeSchema.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from './validateNodeAgainstSchema.js';
import type { MemorySchema } from './memorySchema.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  diffNodeChanges,
  type SnapshotSourceNode,
  type SnapshotEditor,
} from './nodeRevisionSnapshot.js';

/** A node OUTSIDE the moving set already occupies a destination slot. */
export class SubtreeMoveCollisionError extends Error {
  constructor(
    public readonly loc: string,
    public readonly memoryId: string,
  ) {
    super(`A node already occupies loc "${loc}" in the destination memory.`);
    this.name = 'SubtreeMoveCollisionError';
  }
}

/** The destination is inside the source's own subtree — a loc-prefix cycle. */
export class SubtreeMoveIntoSelfError extends Error {
  constructor(public readonly loc: string) {
    super('Cannot move a node into its own subtree.');
    this.name = 'SubtreeMoveIntoSelfError';
  }
}

/** The source node was relocated by a concurrent move after it was resolved. */
export class SubtreeMoveSourceChangedError extends Error {
  constructor(public readonly nodeId: string) {
    super('The node was moved concurrently; retry the move.');
    this.name = 'SubtreeMoveSourceChangedError';
  }
}

/**
 * A cross-memory move hits a case v1 doesn't support and refuses (rather than
 * silently corrupting): an ENCRYPTED memory (needs per-node decrypt/re-encrypt,
 * cloneNode's path) or a CHAT subtree (its data.scope invariants are
 * class-specific). Both are tracked follow-ups (#781). The message names the
 * specific reason. A GIT-BACKED memory was a third reason until #1095 built the
 * move-aware mirror it was waiting on.
 */
export class CrossMemoryMoveUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossMemoryMoveUnsupportedError';
  }
}

/** A moved node violates the destination memory's collection schema. */
export class SubtreeMoveSchemaViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubtreeMoveSchemaViolationError';
  }
}

export interface MoveNodeSubtreeResult {
  /** Number of nodes relocated (the source node plus its descendants). */
  movedCount: number;
  /**
   * Every relocated node: its stable id, the loc it LEFT, and the loc it now
   * holds. The caller needs the pre-move address to mirror the move into git
   * (#1095) — once the transaction commits, nothing else can recover it, since
   * a move is the one write that changes a node's address in place.
   */
  moved: Array<{ id: string; previousLoc: string; loc: string }>;
}

/**
 * Acquire the source-subtree advisory locks and revalidate the source row.
 * Shared by {@link moveNodeSubtree} AND the callers' single-node paths, so EVERY
 * move that reads or relocates from `source.loc` serializes the same way.
 * Without this, a path that resolves the source before the transaction (all of
 * them) and then reads/counts under `source.loc` races a concurrent move of that
 * node: the concurrent move can commit `p → q` first, this path then sees an
 * empty `p:` prefix and acts on a stale snapshot — stranding descendants.
 *
 * Locks (a) the source's ANCESTOR path — so a concurrent move of a DESCENDANT,
 * which locks its own ancestors (including `source.loc`), contends here — and
 * (b) `source.loc` itself — matching the key a descendant CREATE locks as its
 * ancestor. Then re-reads the row by id and throws
 * {@link SubtreeMoveSourceChangedError} if it was relocated/deleted meanwhile.
 * The caller must already hold the DESTINATION ancestor lock. Two moves that
 * relocate into each other's subtrees can still deadlock on these keys —
 * Postgres detects and aborts one (self-healing; moves are infrequent).
 */
export async function lockSourceForMove(
  tx: Prisma.TransactionClient,
  source: { id: string; loc: string; memoryId: string },
): Promise<void> {
  await lockAncestorsForCreate(tx, source.memoryId, source.loc);
  await lockNodeForDelete(tx, source.memoryId, source.loc);
  const fresh = await tx.node.findUnique({
    where: { id: source.id },
    select: { loc: true, memoryId: true, deletedAt: true },
  });
  if (
    !fresh ||
    fresh.deletedAt ||
    fresh.loc !== source.loc ||
    fresh.memoryId !== source.memoryId
  ) {
    throw new SubtreeMoveSourceChangedError(source.id);
  }
}

/**
 * How to NAME what is moving, in a refusal (#1099).
 *
 * The refusals used to say "a subtree" whatever was moving. For a LEAF — the
 * common case — that is simply wrong, and it sends the reader looking for
 * descendants that do not exist. The count is already in hand at every refusal
 * site, so the message can say the true shape instead of the worst case.
 */
export function describeMoved(loc: string, size: number): string {
  return size === 1
    ? `node "${loc}"`
    : `"${loc}" and its ${size - 1} descendant${size === 2 ? '' : 's'}`;
}

/**
 * Relocate `source` and its loc-subtree to `destLoc` (in `destMemoryId`, which
 * defaults to the source's own memory). See the module doc for the caller's
 * responsibilities. Throws {@link SubtreeMoveIntoSelfError} /
 * {@link SubtreeMoveCollisionError} / {@link SubtreeMoveSourceChangedError}; the
 * caller maps these to its surface.
 */
export async function moveNodeSubtree(
  tx: Prisma.TransactionClient,
  opts: {
    source: SnapshotSourceNode;
    destLoc: string;
    /** Destination memory. Omit / equal to source.memoryId for a same-memory move. */
    destMemoryId?: string;
    editor: SnapshotEditor;
    /**
     * Also set the moved SOURCE node's `name` to destLoc's leaf atom.
     * Descendants' names are never rewritten — only their loc prefix changes.
     *
     * OFF by default, and both surfaces now leave it off unless the caller asks
     * (#1017): a move changes an address, not a display title. `hadron_move_node`
     * used to pass `true` unconditionally, so the MCP and GraphQL surfaces of one
     * operation disagreed about whether `name` survives — it is now that tool's
     * opt-in `renameToLeaf` argument, and GraphQL `moveNode` still never sets it.
     */
    renameSourceLeaf?: boolean;
  },
): Promise<MoveNodeSubtreeResult> {
  const { source, destLoc, editor, renameSourceLeaf } = opts;
  const srcMemoryId = source.memoryId;
  const destMemoryId = opts.destMemoryId ?? srcMemoryId;
  const crossMemory = destMemoryId !== srcMemoryId;

  // A node can't be moved INTO its own subtree — the rebase would fold the loc
  // prefix onto itself. Only possible within one memory.
  if (!crossMemory && destLoc.startsWith(`${source.loc}:`)) {
    throw new SubtreeMoveIntoSelfError(destLoc);
  }

  // Lock the source subtree + revalidate the source. The caller already holds
  // the destination ancestor lock.
  await lockSourceForMove(tx, source);

  // The subtree: the source node's descendants, on ':' path boundaries (so
  // `findings:auth` doesn't sweep in `findings:auth-v2`).
  const descendants = await tx.node.findMany({
    where: { memoryId: srcMemoryId, deletedAt: null, loc: { startsWith: `${source.loc}:` } },
  });
  const subtree: SnapshotSourceNode[] = [source, ...descendants];
  // Rebase a source-subtree loc onto the destination: source.loc → destLoc,
  // source.loc:x → destLoc:x. slice(source.loc.length) is '' for the source
  // node and ':x…' for a descendant.
  const newLocById = new Map(
    subtree.map((n) => [n.id, destLoc + n.loc.slice(source.loc.length)] as const),
  );
  const movedIds = new Set(subtree.map((n) => n.id));

  // Fail loudly if any node OUTSIDE the moving set already occupies a
  // destination slot. Live OR soft-deleted blocks: the (loc, memoryId) unique
  // index is full, so a tombstone at the target still rejects the write.
  const occupants = await tx.node.findMany({
    where: { memoryId: destMemoryId, loc: { in: [...newLocById.values()] } },
    select: { id: true, loc: true },
  });
  const blocker = occupants.find((o) => !movedIds.has(o.id));
  if (blocker) throw new SubtreeMoveCollisionError(blocker.loc, destMemoryId);

  // Cross-memory pre-checks — crossing a memory boundary must respect the
  // DESTINATION's encryption + schema (the write-path invariants), so validate
  // BEFORE any write (a throw rolls the whole tx back). destMem also carries
  // vectorIndexEnabled for the embedding step below.
  let destVectorIndexEnabled = false;
  if (crossMemory) {
    const [srcMem, destMem] = await Promise.all([
      tx.memory.findUnique({ where: { id: srcMemoryId }, select: { isEncrypted: true, source: true } }),
      tx.memory.findUnique({
        where: { id: destMemoryId },
        select: { isEncrypted: true, source: true, vectorIndexEnabled: true, schema: true },
      }),
    ]);
    // Encryption: v1 refuses a cross-memory move touching an encrypted memory
    // (would leave plaintext at rest in an encrypted dest, or carry
    // source-key-bound ciphertext the dest key can't read). #781 follow-up.
    if (srcMem?.isEncrypted || destMem?.isEncrypted) {
      throw new CrossMemoryMoveUnsupportedError(
        `Cannot move ${describeMoved(source.loc, subtree.length)} across memories: ` +
          (srcMem?.isEncrypted && destMem?.isEncrypted
            ? 'both memories are encrypted'
            : srcMem?.isEncrypted
              ? 'the source memory is encrypted'
              : 'the destination memory is encrypted') +
          ', and a cross-memory move cannot re-key the nodes. ' +
          'Move it within its memory, or clone the nodes into the destination.',
      );
    }
    // Git-backed memories are NO LONGER refused (#1095). The move-aware mirror
    // this guard was waiting on now exists: `mirrorNodeMoveToGit` removes the
    // moved nodes' files from the source repo and writes them to the
    // destination's, so a stale source file can't be re-minted by the next
    // repo-wins sync. Git is one integration of a memory, not a lock on it —
    // and the guard was over-broad besides, refusing on EITHER side when only
    // the source side can strand a file. Callers fire the mirror after the
    // transaction commits; it is fire-and-forget, so a repo that is unreachable
    // degrades to the same DB-only state a same-memory move has always had.
    // Chat: a chat-root node carries a class-specific `data.scope` invariant
    // (validateChatScopeInvariants) — moving it to a different memory class can
    // make the chat unusable (CHAT_MEMORY_OUT_OF_SCOPE). Refuse a subtree that
    // contains a chat-root. #781 follow-up.
    const chatRoot = subtree.find((n) => {
      const d = n.data as { scope?: unknown } | null;
      return d != null && typeof d === 'object' && !Array.isArray(d) && (d.scope === 'private' || d.scope === 'shared');
    });
    if (chatRoot) {
      // #1099 — NAME the chat root. A caller moving a large subtree has no way
      // to tell which of its nodes triggered this, and the whole subtree is
      // refused for one of them.
      throw new CrossMemoryMoveUnsupportedError(
        `Cannot move ${describeMoved(source.loc, subtree.length)} across memories: it ` +
          `${chatRoot.loc === source.loc ? 'is a chat' : `contains the chat "${chatRoot.loc}"`}, ` +
          'and a chat\'s scope is tied to its memory class. Move it within its memory.',
      );
    }
    destVectorIndexEnabled = destMem?.vectorIndexEnabled ?? false;
    // Schema: a schema-governed destination rejects nodes with undeclared
    // objectType / invalid properties — the same enforceNodeSchemaOnWrite gate
    // every normal write applies. Validate every moved node up front.
    const destSchema = (destMem?.schema ?? null) as MemorySchema | null;
    if (destSchema) {
      for (const n of subtree) {
        const objectType = normalizeObjectType(n.objectType);
        if (objectType == null) continue; // ordinary node — nothing to enforce
        try {
          validateNodeAgainstSchema(
            destSchema,
            objectType,
            (n.properties ?? null) as Record<string, unknown> | null,
          );
        } catch (e) {
          if (e instanceof NodeSchemaViolation) {
            throw new SubtreeMoveSchemaViolationError(
              `Node "${n.loc}" does not satisfy the destination memory's schema: ${e.message}`,
            );
          }
          throw e;
        }
      }
    }
  }

  // Move every node in two phases so per-row updates never trip the
  // (loc, memoryId) unique mid-transaction — a same-memory rebase can overlap
  // the source subtree (moving `a:b` → `a` sends grandchild `a:b:b` onto the
  // source's old `a:b` slot). Phase 1 parks each node at a unique temp loc;
  // phase 2 writes the final loc (+ destination memory) and a pre-move
  // NodeRevision. The snapshot/diff read the original `n` (its pre-move loc), so
  // temp parking doesn't affect audit history. Temp locs mirror deleteNode's
  // `__deleted-<id>` re-stamp — id-unique, outside any real loc namespace.
  //
  // The result is built BEFORE the rebase: once phase 2 lands, a row's old loc
  // is gone and unrecoverable, and the git mirror needs the address each node
  // left in order to delete the file it stranded there.
  const result: MoveNodeSubtreeResult = {
    movedCount: subtree.length,
    moved: subtree.map((n) => ({ id: n.id, previousLoc: n.loc, loc: newLocById.get(n.id)! })),
  };
  for (const n of subtree) {
    await tx.node.update({ where: { id: n.id }, data: { loc: `__moving-${n.id}` } });
  }
  const leaf = destLoc.split(':').pop()!;
  for (const n of subtree) {
    const newLoc = newLocById.get(n.id)!;
    const rename = renameSourceLeaf === true && n.id === source.id;
    const changed = { loc: newLoc, memoryId: destMemoryId, ...(rename ? { name: leaf } : {}) };
    await createNodeRevision(
      tx,
      buildNodeRevisionSnapshot(n, editor, { changes: diffNodeChanges(n, changed) }),
    );
    await tx.node.update({ where: { id: n.id }, data: changed });
  }

  if (!crossMemory) {
    // Same-memory: no memoryId changes anywhere, edges left untouched (#768).
    return result;
  }

  // ── Cross-memory carry-over ─────────────────────────────────────────────
  const movedIdList = [...movedIds];

  // Embeddings are re-indexed under the DESTINATION policy, not blindly
  // relabeled: the source vectors were built under the source memory's policy
  // (kind/embeddingSource/chunking), which may differ. Delete the moved nodes'
  // vectors (removing them from the source's candidate window and clearing any
  // wrong-policy rows), then re-stamp the embedding markers for EVERY moved node
  // — always, even when the destination doesn't index:
  //   - it changes `embeddingPendingAt`, which INVALIDATES any in-flight
  //     source-side embed job (embedNode's latest-wins guard) so it can't
  //     re-insert a source-tagged vector for a node that has left the memory;
  //   - it resets the retry state (attempts/failed/error), or a node that had
  //     exhausted its retries would be filtered out of drainEmbeddingQueue and
  //     never re-index at the destination.
  // When the destination indexes, `embeddingPendingAt` is fresh so the worker
  // rebuilds the correct kinds; when it doesn't, the marker is cleared to null
  // (nothing to rebuild — the vectors just stay deleted). Content is plaintext
  // here (encrypted memories are refused above).
  await tx.nodeEmbedding.deleteMany({ where: { nodeId: { in: movedIdList } } });
  await tx.node.updateMany({
    where: { id: { in: movedIdList } },
    data: {
      embeddingPendingAt: destVectorIndexEnabled ? new Date() : null,
      embeddingFailedAt: null,
      embeddingError: null,
      embeddingAttempts: 0,
    },
  });

  // PendingEdge rows follow their source node by FK (no memoryId column), but the
  // denormalized Memory.pendingEdgeCount does not — move the credit from the
  // source memory to the destination for every live pending edge the subtree owns.
  const movedPending = await tx.pendingEdge.count({
    where: { sourceId: { in: movedIdList }, deletedAt: null },
  });
  if (movedPending > 0) {
    await tx.memory.update({
      where: { id: srcMemoryId },
      data: { pendingEdgeCount: { decrement: movedPending } },
    });
    await tx.memory.update({
      where: { id: destMemoryId },
      data: { pendingEdgeCount: { increment: movedPending } },
    });
  }

  // Edges whose SOURCE moved follow it (Edge.memoryId denormalizes the source's
  // memory). Re-derive the loc from the rebased source + the target's loc
  // (rebased if the target also moved, else its current loc), and relocate the
  // edge to the destination memory. Edges whose source did NOT move keep their
  // memoryId (their source stayed) — they simply become cross-memory edges,
  // gated at read time by #783.
  const outgoing = await tx.edge.findMany({
    where: { deletedAt: null, sourceId: { in: [...movedIds] } },
  });
  if (outgoing.length === 0) return result;

  // Target locs for boundary targets (targets outside the moved set).
  const outsideTargetIds = [
    ...new Set(outgoing.map((e) => e.targetId).filter((id) => !movedIds.has(id))),
  ];
  const outsideTargetLoc = new Map<string, string>();
  if (outsideTargetIds.length > 0) {
    const rows = await tx.node.findMany({
      where: { id: { in: outsideTargetIds } },
      select: { id: true, loc: true },
    });
    for (const r of rows) outsideTargetLoc.set(r.id, r.loc);
  }

  // Desired base loc per moved edge (null target loc ⇒ skip defensively).
  const desired = outgoing.map((e) => {
    const tgtLoc = newLocById.get(e.targetId) ?? outsideTargetLoc.get(e.targetId);
    return {
      id: e.id,
      base: tgtLoc == null ? null : deriveEdgeLoc(newLocById.get(e.sourceId)!, e.name, tgtLoc),
    };
  });

  // Pre-existing destination edges that already hold a candidate loc — the exact
  // base OR a numeric-suffixed variant (`<base>:2`, …), since the disambiguation
  // loop below emits those. Missing the suffixed variants would let the loop pick
  // a `<base>:2` that already exists → (loc, memoryId) unique violation (live OR
  // tombstoned — the index is full). `startsWith <base>:` over-matches unrelated
  // deeper locs, which is harmless (we only ever avoid taken locs). The moved
  // edges are still in the source memory here, so they aren't matched.
  const bases = [...new Set(desired.map((d) => d.base).filter((b): b is string => b != null))];
  const taken = new Set<string>();
  if (bases.length > 0) {
    const rows = await tx.edge.findMany({
      where: {
        memoryId: destMemoryId,
        OR: [{ loc: { in: bases } }, ...bases.map((b) => ({ loc: { startsWith: `${b}:` } }))],
      },
      select: { loc: true },
    });
    for (const r of rows) taken.add(r.loc);
  }

  for (const d of desired) {
    if (d.base == null) continue; // target vanished — leave the edge as-is
    let loc = d.base;
    for (let k = 2; taken.has(loc); k++) loc = `${d.base}:${k}`;
    taken.add(loc);
    await tx.edge.update({ where: { id: d.id }, data: { loc, memoryId: destMemoryId } });
  }

  return result;
}
