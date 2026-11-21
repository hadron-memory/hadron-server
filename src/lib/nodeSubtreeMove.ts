import { resetEmbeddingObligations } from '../services/embedding/obligation.js';
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

import { assertBootPromptWriteAllowed } from './bootPrompt.js';
import { resyncDerivedIncludesForNodes } from './includes/writeIncludes.js';
import { assertRoleWritersForNodes, type RoleWriterPrincipal } from './nodeRoleWriters.js';
import { COMMENT_NODE_TYPE, COMMENTABLE_CLASSES, commentError, commentGovernedError } from './comments/index.js';
import { questionContainedError, isQuestionFamilyRole, refuseUnderQuestionLog } from './questions/index.js';
import { deriveEdgeLoc } from './edgeLoc.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreate, lockNodeForDelete } from './nodeSubtreeLock.js';
import type { Prisma } from '../generated/prisma/index.js';
import { normalizeObjectType } from './enforceNodeSchema.js';
import { recordUrnRename } from './urnAlias.js';
import { assertNoMintedSpecRemoval } from './mintedSpecPermanence.js';
import { safeEdgeUrnV2, safeNodeUrnV2 } from './urnEmit.js';
import { UrnNotQualifiedError, UrnParseError, normalizeUrnForLookup } from './urn.js';
import { resolveNodeRef, isConcealedNodeRefAmbiguity, type NodeRefProjection } from './entityRef/nodeRef.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from './entityRef/errors.js';
import { isId } from './entityRef/shape.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from './validateNodeAgainstSchema.js';
import type { MemorySchema } from './memorySchema.js';
import { assertRenameAuthoring, attestedAuthoring, type AuthoringContext } from './authoringAttestation.js';
import { clearNodeAuthorship } from './nodeAuthorship.js';
import { memoryIsVectorIndexed } from './embedding/indexing.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  diffNodeChanges,
  ensureCurrentNodeRevisionInTransaction,
  revisionStateHashRefreshMarker,
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

/**
 * #1591: the caller required an UNMINTED subtree (a renumber: draft rights are
 * per node, and a minted node's address was published), and some node of the
 * subtree is minted when read under this move's own locks. A mint that
 * commits between the caller's check and those locks is the race case: the
 * move refuses rather than renumber a minted node without an alias.
 */
export class SubtreeMoveMintedError extends Error {
  constructor(
    public readonly memoryId: string,
    public readonly locs: string[],
  ) {
    super(
      `Refused: ${locs.slice(0, 10).map((l) => `"${l}"`).join(', ')}${locs.length > 10 ? ` (and ${locs.length - 10} more)` : ''} ` +
        `${locs.length === 1 ? 'is' : 'are'} minted, so only an unminted node can be renumbered. Move it instead, which keeps its old address resolving.`,
    );
    this.name = 'SubtreeMoveMintedError';
  }
}

/** #1591 — whether a locked node row is minted (full rows carry `mintedAt`). */
function isMintedRow(n: SnapshotSourceNode): boolean {
  return (n as SnapshotSourceNode & { mintedAt?: Date | null }).mintedAt != null;
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
  /** Raw relative wikilinks whose target changes identity or disappears after a cross-memory move. */
  linkWarnings: MoveLinkWarning[];
  /** #2947: every edge whose URN this move changed (each keeps its old URN as an EDGE alias). */
  edgeUrnChanges: EdgeUrnChange[];
}

export interface MoveLinkWarning {
  nodeId: string;
  /** The containing node's loc after the move. */
  nodeLoc: string;
  /** Link text, including its optional label. Content itself is never rewritten. */
  raw: string;
  target: string;
  status: 'MISSING' | 'RETARGETED' | 'AMBIGUOUS';
}

/** Wikilinks in raw content, in occurrence order. A qualified ref cannot be memory-relative. */
function relativeContentLinks(content: string): Array<{ raw: string; target: string }> {
  const links: Array<{ raw: string; target: string }> = [];
  for (const match of content.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    const target = match[1].split('|', 1)[0].trim();
    if (target && !isId(target) && !target.startsWith('hrn:') && !target.startsWith('urn:')) {
      links.push({ raw: match[0], target });
    }
  }
  return links;
}

/** A miss at a live loc may still resolve through a historical NODE alias. */
async function aliasTargetId(
  tx: Prisma.TransactionClient,
  target: string,
  memoryId: string,
  projection?: NodeRefProjection,
  canReadMemoryId: (id: string) => Promise<boolean> = async id => id === memoryId,
): Promise<string | 'AMBIGUOUS' | null> {
  try {
    const { id } = await resolveNodeRef(tx, target, memoryId, { projection });
    // The report is about a memory-relative link. A bare qualified spelling
    // that happens to parse here cannot turn this into a foreign-memory probe.
    const node = await tx.node.findUnique({ where: { id }, select: { memoryId: true } });
    return node && (projection?.nodes.get(id)?.memoryId ?? node.memoryId) === memoryId ? id : null;
  } catch (error) {
    if (
      error instanceof NodeNotFoundError ||
      error instanceof UrnNotQualifiedError ||
      error instanceof UrnParseError
    ) return null;
    if (error instanceof AmbiguousLegacyUrnError) {
      return await isConcealedNodeRefAmbiguity(tx, error, canReadMemoryId) ? null : 'AMBIGUOUS';
    }
    throw error;
  }
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
 * relocate into each other's subtrees declare their full caller union first;
 * these source-path acquisitions are then subsets of that initial set (#2054).
 */
export async function lockSourceForMove(
  tx: Prisma.TransactionClient,
  source: { id: string; loc: string; memoryId: string },
): Promise<void> {
  await acquireLockSet(tx, [...ancestorLocs(source.loc), source.loc].map(loc => ({ memoryId: source.memoryId, loc })));
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
    /** cor:api:190:03: run shared checks without locks, reconciliation or writes. */
    planOnly?: boolean;
    /** Ruling 0211: do not resolve destination content links for an unreadable memory. */
    withholdLinkWarnings?: boolean;
    /** Node-content read predicate for classifying reference failures. */
    canReadMemoryId?: (memoryId: string) => Promise<boolean>;
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
    /** #1328 — what the rename is, in attestation terms. A rename without it is refused. */
    renameAuthoring?: AuthoringContext;
    /** Refuse (SubtreeMoveMintedError) when any moved node is minted, read under this move's locks (#1591). */
    requireUnminted?: boolean;
    /** Recheck caller write authority after both Memory rows are locked. */
    authorizeLockedMemory?: (memoryId: string) => Promise<void>;
    /**
     * #1331 — the caller, for the role writer level of every moved node (judged on the
     * LOCKED subtree, in the memory it leaves and the one it enters). Omitted only by
     * server-authored callers.
     */
    principal?: RoleWriterPrincipal;
  },
): Promise<MoveNodeSubtreeResult> {
  const { source, destLoc, editor, renameSourceLeaf, renameAuthoring } = opts;
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
  if (!opts.planOnly) await lockSourceForMove(tx, source);

  // The subtree: the source node's descendants, on ':' path boundaries (so
  // `findings:auth` doesn't sweep in `findings:auth-v2`).
  const firstDescendants = await tx.node.findMany({
    where: { memoryId: srcMemoryId, deletedAt: null, loc: { startsWith: `${source.loc}:` } },
    select: { id: true },
  });
  // #1323 (@codex P1, PR #1339): every moved row is row-locked and its
  // unrevisioned drift reconciled as its OWN revision (id order — one global
  // order, so concurrent multi-row operations cannot lock-invert) BEFORE the
  // move is planned from it; otherwise the move's snapshot would fold the drift
  // and the refreshed fingerprint would hide it. The plan is then built from
  // the rows as they are under their locks, and a source that moved or a
  // descendant set that changed in the meantime refuses as a retryable move.
  const reconcileIds = [source.id, ...firstDescendants.map((d) => d.id)].sort();
  // Take the complete Node set before the Memory fence. A merge fold holds
  // Node locks before its Memory FOR SHARE fence; taking Memory first here
  // deadlocks when each operation waits on the other's row.
  for (const id of opts.planOnly ? [] : reconcileIds) {
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
  }

  // Reconciliation below can mint a NodeRevision. Fence the source flip before
  // that first history write, including same-memory moves; a cross-memory move
  // also holds the destination flag through the relocation. Take the lock mode
  // needed by the later URN read now: upgrading two disjoint moves' FOR SHARE
  // locks to FOR NO KEY UPDATE would deadlock. Opposing moves use one ID order.
  const memoryUrns = new Map<string, string>();
  // A concurrent mint takes this row FOR UPDATE, so it cannot interleave with
  // the per-node mint state read below under the node locks.
  for (const memoryId of [...new Set([srcMemoryId, destMemoryId])].sort()) {
    const memory = opts.planOnly
      ? await tx.memory.findUnique({ where: { id: memoryId }, select: { urn: true } })
      : (await tx.$queryRaw<Array<{ urn: string }>>`
          SELECT urn FROM memories WHERE id = ${memoryId} FOR NO KEY UPDATE
        `)[0];
    if (!memory) throw new Error(`Move memory ${memoryId} disappeared while locking; retry.`);
    memoryUrns.set(memoryId, memory.urn);
  }
  for (const memoryId of [...new Set([srcMemoryId, destMemoryId])].sort()) {
    await opts.authorizeLockedMemory?.(memoryId);
  }

  for (const id of opts.planOnly ? [] : reconcileIds) {
    await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: srcMemoryId });
  }
  const lockedSource = await tx.node.findUnique({ where: { id: source.id } });
  if (
    !lockedSource ||
    lockedSource.deletedAt ||
    lockedSource.memoryId !== srcMemoryId ||
    lockedSource.loc !== source.loc
  ) {
    throw new SubtreeMoveSourceChangedError(source.id);
  }
  const descendants = await tx.node.findMany({
    where: { memoryId: srcMemoryId, deletedAt: null, loc: { startsWith: `${source.loc}:` } },
  });
  const lockedIds = [source.id, ...descendants.map((d) => d.id)].sort();
  if (lockedIds.length !== reconcileIds.length || lockedIds.some((id, i) => id !== reconcileIds[i])) {
    throw new SubtreeMoveSourceChangedError(source.id);
  }
  // #1468 — moving a spec OUT of a minted corpus removes it from the corpus.
  // A same-memory move is a rename that keeps its UrnAlias, so it stays
  // allowed. Rows and memory are already locked in the guard's order.
  if (crossMemory) {
    await assertNoMintedSpecRemoval(tx, srcMemoryId, lockedIds, 'move out of its corpus');
  }
  const subtree: SnapshotSourceNode[] = [lockedSource, ...descendants];
  if (opts.principal) {
    await assertRoleWritersForNodes(tx, opts.principal, subtree, { from: srcMemoryId, to: destMemoryId }, { preview: opts.planOnly });
  }
  // Rebase a source-subtree loc onto the destination: source.loc → destLoc,
  // source.loc:x → destLoc:x. slice(source.loc.length) is '' for the source
  // node and ':x…' for a descendant.
  const newLocById = new Map(
    subtree.map((n) => [n.id, destLoc + n.loc.slice(source.loc.length)] as const),
  );
  const movedIds = new Set(subtree.map((n) => n.id));

  // #1392 — a bare [[loc]] in content is relative to the containing memory.
  // Moving the raw body across memories can leave it dangling, or worse, make
  // it point at a different node at that same loc. Compare target IDs, not
  // existence alone. Only links that resolved in the source are move-caused
  // changes; pre-existing broken links and qualified URNs are outside this
  // report. Do not rewrite author text or expose source-memory addresses.
  const contentLinks = crossMemory && !opts.withholdLinkWarnings
    ? subtree.flatMap((n) => relativeContentLinks(n.content ?? '').map((link) => ({
        nodeId: n.id, nodeLoc: newLocById.get(n.id)!, ...link,
      })))
    : [];
  const targets = [...new Set(contentLinks.map((link) => link.target))];
  const sourceTargets = targets.length
    ? await tx.node.findMany({
        where: { memoryId: srcMemoryId, loc: { in: targets }, deletedAt: null },
        select: { id: true, loc: true },
      })
    : [];
  const sourceIdByLoc = new Map(sourceTargets.map((n) => [n.loc, n.id]));
  for (const target of targets) {
    if (sourceIdByLoc.has(target)) continue;
    const id = await aliasTargetId(tx, target, srcMemoryId, undefined, opts.canReadMemoryId);
    if (id && id !== 'AMBIGUOUS') sourceIdByLoc.set(target, id);
  }

  // Fail loudly if any node OUTSIDE the moving set already occupies a
  // destination slot. Live OR soft-deleted blocks: the (loc, memoryId) unique
  // index is full, so a tombstone at the target still rejects the write.
  const occupants = await tx.node.findMany({
    where: { memoryId: destMemoryId, loc: { in: [...newLocById.values()] } },
    select: { id: true, loc: true },
  });
  const blocker = occupants.find((o) => !movedIds.has(o.id));
  if (blocker) throw new SubtreeMoveCollisionError(blocker.loc, destMemoryId);

  // #1591 — a caller that needs draft rights (renumber) re-decides them HERE,
  // per node, under the locks, before anything moves (@codex P1, PR #1453).
  // A placeholder may move anywhere: it is an unminted node, and the
  // destination's mint refuses while it remains.
  if (opts.requireUnminted) {
    const minted = subtree.filter(isMintedRow).map((n) => n.loc).sort();
    if (minted.length > 0) throw new SubtreeMoveMintedError(srcMemoryId, minted);
  }

  // #1606 — a comment never moves on its own (cor:dmo:110:04): it follows its
  // target. A commented target crossing memories carries its threads in this
  // same transaction (cor:dmo:110:02), and is refused when the destination
  // cannot hold comments.
  if (subtree.some((n) => n.nodeType === COMMENT_NODE_TYPE)) throw commentGovernedError('move', 'edits');
  // #2043 — a compiled boot prompt is placed by its compile, never moved.
  // and (cor:agt:040:11) a worker session never moves a boot-prompt source either.
  for (const n of subtree) assertBootPromptWriteAllowed(n, {}, 'move');
  // #1641 §3.2 — a question's loc IS its code, so neither a question nor a log
  // (nor an ancestor of one) moves; and nothing moves into a log's code space.
  const questionsMoved = subtree.filter((n) => isQuestionFamilyRole(n.role));
  if (questionsMoved.length > 0) throw questionContainedError('Moving this node', questionsMoved.map((n) => n.loc));
  await refuseUnderQuestionLog(tx, destMemoryId, destLoc, 'Moving this node');
  const carriedComments = crossMemory
    ? await tx.commentMeta.findMany({
      where: { targetNodeId: { in: [...movedIds] } },
      select: { nodeId: true, targetNodeId: true, node: { select: { deletedAt: true } } },
    })
    : [];
  // Every thread moves (history follows its target), but only LIVE comments
  // need a commentable destination: a deleted thread is gone from every check
  // (cor:dmo:110:05), which is what lets an admin's thread delete clear a node
  // for a move into a private or system memory (110:02). #1663 review P2.
  const liveCarried = carriedComments.filter((c) => c.node.deletedAt == null);
  if (liveCarried.length > 0) {
    const dest = await tx.memory.findUniqueOrThrow({ where: { id: destMemoryId }, select: { class: true } });
    if (!COMMENTABLE_CLASSES.has(dest.class)) {
      const perTarget = new Map<string, number>();
      for (const c of liveCarried) perTarget.set(c.targetNodeId, (perTarget.get(c.targetNodeId) ?? 0) + 1);
      throw commentError(
        'COMMENT_MOVE_UNCOMMENTABLE',
        `Cannot move ${describeMoved(source.loc, subtree.length)} into a ${dest.class} memory: it has comment threads. An admin of the memory deletes them first.`,
        { class: dest.class, nodes: subtree.filter((n) => perTarget.has(n.id)).map((n) => ({ nodeId: n.id, loc: n.loc, comments: perTarget.get(n.id)! })) },
      );
    }
  }

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
        select: { isEncrypted: true, source: true, vectorIndexEnabled: true, class: true, schema: true },
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
    // Chat: refuse a subtree containing a chat-root. #781 follow-up.
    //
    // **Two kinds of chat root, carrying DIFFERENT markers — this predicate is
    // a union, and measuring that is what stopped #1196 from silently deleting
    // half the guard.** The obvious move when `data.scope` was dropped was to
    // swap this for `nodeType === 'chat'`; that reads like the canonical
    // chat-root marker because `ensureChannelWithRoot` and `locateTeamChatRoot`
    // both use it. But `startChat` writes its chat root as
    // `nodeType: 'record'` (resolvers.mutation.chat.ts) — so the swap would
    // have kept the guard for Channels and quietly dropped it for every AGENT
    // chat, which is the larger population and the one #781 was about.
    //
    //   - **Agent chats** (`startChat`) still carry `data.scope`, untouched by
    //     #1196. The original reason holds verbatim for them: the marker is
    //     denormalized from the host's class, so a cross-memory move can make
    //     the chat unusable (`CHAT_MEMORY_OUT_OF_SCOPE`).
    //   - **Channel roots** carry `nodeType: 'chat'` and NO scope marker since
    //     #1196. Their reason is different and stronger, which is why the
    //     refusal survives its original rationale going away
    //     (`cor:api:190:02` anticipated exactly this): `Channel.memoryId` and
    //     `Channel.loc` are the address reservation, and the register rows and
    //     read states point at the root. Moving the node without the row leaves
    //     a Channel reserving an address in a memory its root no longer lives
    //     in.
    const chatRoot = subtree.find((n) => {
      if (n.nodeType === 'chat') return true;
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
          'and a chat is bound to the memory that hosts it. Move it within its memory.',
      );
    }
    destVectorIndexEnabled = destMem ? memoryIsVectorIndexed(destMem) : false;
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

  // The same alias eligibility as the real write: a plan must project both
  // arriving addresses and the aliases that write will create, not rewrite
  // the reference spelling or lose historical memory-prefix lookup (#3424).
  const sourceMemoryUrn = memoryUrns.get(srcMemoryId)!;
  const targetMemoryUrn = memoryUrns.get(destMemoryId)!;
  const aliasKey = (memoryUrn: string, loc: string) =>
    safeNodeUrnV2(memoryUrn, loc).slice('hrn:node:'.length);
  const leavesAlias = new Set(subtree.filter(isMintedRow));
  if (leavesAlias.size < subtree.length) {
    const srcIsAgentSystemMemory = await tx.agent.findFirst({
      where: { systemMemoryId: srcMemoryId, deletedAt: null },
      select: { id: true },
    });
    if (srcIsAgentSystemMemory) {
      for (const n of subtree) {
        if (n.loc.startsWith('register:')) leavesAlias.add(n);
      }
    }
  }
  const plannedAliases = new Map<string, string[]>();
  if (opts.planOnly) {
    for (const n of leavesAlias) {
      const key = normalizeUrnForLookup(aliasKey(sourceMemoryUrn, n.loc));
      const ids = plannedAliases.get(key) ?? [];
      ids.push(n.id);
      plannedAliases.set(key, ids);
    }
  }
  const projection: NodeRefProjection | undefined = opts.planOnly ? {
    nodes: new Map(subtree.map(n => [n.id, { memoryId: destMemoryId, loc: newLocById.get(n.id)! }])),
    aliases: plannedAliases,
  } : undefined;

  /** Compare content links against either the committed or virtual destination. */
  async function linkWarningsAfterMove(virtual: boolean): Promise<MoveLinkWarning[]> {
    const destinationTargets = targets.length
      ? await tx.node.findMany({
          where: { memoryId: destMemoryId, loc: { in: targets }, deletedAt: null },
          select: { id: true, loc: true },
        })
      : [];
    const destinationIdByLoc = new Map<string, string>(destinationTargets.map((n) => [n.loc, n.id]));
    if (virtual) {
      for (const n of subtree) destinationIdByLoc.set(newLocById.get(n.id)!, n.id);
    }
    for (const target of targets) {
      if (destinationIdByLoc.has(target)) continue;
      const id = await aliasTargetId(tx, target, destMemoryId, virtual ? projection : undefined, opts.canReadMemoryId);
      if (id) destinationIdByLoc.set(target, id);
    }
    return contentLinks.flatMap((link) => {
      const originalId = sourceIdByLoc.get(link.target);
      if (!originalId) return [];
      const nextId = destinationIdByLoc.get(link.target);
      if (nextId === originalId) return [];
      const status = nextId === 'AMBIGUOUS' ? 'AMBIGUOUS' : nextId ? 'RETARGETED' : 'MISSING';
      return [{ ...link, status }];
    });

  }

  if (opts.planOnly) {
    return {
      movedCount: subtree.length,
      moved: subtree.map(n => ({ id: n.id, previousLoc: n.loc, loc: newLocById.get(n.id)! })),
      linkWarnings: await linkWarningsAfterMove(true),
      edgeUrnChanges: [],
    };
  }

  // cor:urn:030:01 — each moved row leaves a published address behind, even
  // when its parent memory's stored URN never changes. Record every predecessor
  // in this SAME transaction as the two-phase rebase. The shared alias helper
  // normalizes and deduplicates repeat moves; the node-ref resolver applies
  // live-address precedence and current-target liveness on lookup.
  // The earlier NO KEY UPDATE locks pin both URNs against Memory rename and
  // remain compatible with child-row FK KEY SHARE checks.
  //
  // #1448, per node since #1591: except for an UNMINTED node. A draft number
  // was never published, so nothing outside can cite it; recording it would
  // make two specs moved through the same number resolve as ambiguous, and
  // keep draft-era numbers resolving after the mint. A minted node's address
  // was published, so it leaves an alias behind wherever it moves.
  //
  // #2610: a register:<code> entry in a live Agent's system memory ALSO leaves
  // its old address behind, minted or not. #1448's premise ("nothing outside
  // can cite an unminted node") is about spec draft numbers and fails for
  // entries the moment action URNs exist: the address is emitted on every read
  // (`Node.actionUrn`) as soon as the entry does, and cor:urn:010:01 (Proposed,
  // #2610) rules the old code never stops resolving. Scoped so #1448's spec
  // behavior is untouched: only `register:` locs in the SOURCE memory when that
  // memory is some live Agent's system memory — exactly the nodes an action URN
  // can key on.
  for (const n of leavesAlias) {
    await recordUrnRename(tx, {
      entityType: 'NODE',
      entityId: n.id,
      oldUrn: aliasKey(sourceMemoryUrn, n.loc),
      newUrn: aliasKey(targetMemoryUrn, newLocById.get(n.id)!),
      createdBy: editor.userId ?? editor.info ?? null,
    });
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
    linkWarnings: [],
    edgeUrnChanges: [],
  };
  const leaf = destLoc.split(':').pop()!;
  // #1328 — a rename is an authored name change. The rows are locked by now,
  // and this refuses before the first write of the move.
  const renamed = renameSourceLeaf === true ? subtree.find((n) => n.id === source.id && n.name !== leaf) : undefined;
  const renameStamp = renamed
    ? await assertRenameAuthoring(tx, srcMemoryId, destMemoryId, {
        priorRole: renamed.role, priorRunnable: renamed.isRunnable,
        role: renamed.role, runnable: renamed.isRunnable, mintHuman: true, authoredChange: true,
      }, renameAuthoring ?? attestedAuthoring(null))
    : null;
  for (const n of subtree) {
    await tx.node.update({ where: { id: n.id }, data: { loc: `__moving-${n.id}` } });
  }
  for (const n of subtree) {
    const newLoc = newLocById.get(n.id)!;
    const rename = renameSourceLeaf === true && n.id === source.id;
    const changed = { loc: newLoc, memoryId: destMemoryId, ...(rename ? { name: leaf } : {}) };
    await createNodeRevision(
      tx,
      buildNodeRevisionSnapshot(n, editor, { changes: diffNodeChanges(n, changed) }),
    );
    await tx.node.update({
      where: { id: n.id },
      data: {
        ...changed,
        ...(rename && n.name !== leaf ? (renameStamp ?? clearNodeAuthorship()) : {}),
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });
  }

  const carriedThreadEdgeChanges: EdgeUrnChange[] = [];
  if (carriedComments.length > 0) {
    // The threads follow (their locs are id-derived, so they cannot collide).
    const ids = carriedComments.map((c) => c.nodeId);
    await tx.node.updateMany({ where: { id: { in: ids } }, data: { memoryId: destMemoryId } });
    // #2947 (ruling 0162, Vera's read of 2026-11-21): the thread's governed edges (a COMMENT_ANCHOR) keep their id-derived
    // loc, but their URN names the memory, so the old URN keeps resolving through an EDGE alias like any other edge.
    const threadEdges = await tx.edge.findMany({
      where: { sourceId: { in: ids }, governedKind: { not: null }, memoryId: { not: destMemoryId } },
      select: { id: true, loc: true, memoryId: true },
    });
    await tx.edge.updateMany({ where: { sourceId: { in: ids }, governedKind: { not: null } }, data: { memoryId: destMemoryId } });
    for (const e of threadEdges) {
      const previousUrn = safeEdgeUrnV2(memoryUrns.get(e.memoryId) ?? memoryUrns.get(srcMemoryId)!, e.loc);
      const urn = safeEdgeUrnV2(memoryUrns.get(destMemoryId)!, e.loc);
      if (previousUrn === urn) continue;
      await recordUrnRename(tx, {
        entityType: 'EDGE', entityId: e.id,
        oldUrn: previousUrn.slice('hrn:edge:'.length), newUrn: urn.slice('hrn:edge:'.length),
        createdBy: editor.userId ?? editor.info ?? null,
      });
      carriedThreadEdgeChanges.push({ edgeId: e.id, previousUrn, urn });
    }
  }

  if (!crossMemory) {
    // Same-memory: no memoryId changes, but a DERIVED edge's loc follows its endpoints (#2947).
    result.edgeUrnChanges = await rebaseMovedEdges(tx, {
      movedIds, newLocById, srcMemoryId, destMemoryId, crossMemory, memoryUrns, createdBy: editor.userId ?? editor.info ?? null,
    });
    return result;
  }

  // #2040 — a moved node's derived INCLUDE edges are re-derived in the memory it
  // now lives in (a same-memory loc tag points elsewhere after a cross-memory
  // move). They are dropped here, not re-homed: the governed-edge trigger forbids
  // rewriting them, and their loc is id-derived.
  await tx.edge.deleteMany({ where: { governedKind: 'INCLUDE', sourceId: { in: [...movedIds] } } });
  await resyncDerivedIncludesForNodes(tx, [...movedIds]);

  // Read the destination AFTER the rows and NODE aliases have moved. A live
  // occupant has precedence over aliases, and an alias to a node newly moved
  // into this memory can now resolve. Both cases are missed by a pre-move map.
  result.linkWarnings = await linkWarningsAfterMove(false);

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
  await resetEmbeddingObligations(tx, movedIdList, destVectorIndexEnabled);

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

  // #2947: the edge pass, shared with the same-memory path above.
  result.edgeUrnChanges = [
    ...carriedThreadEdgeChanges,
    ...(await rebaseMovedEdges(tx, {
      movedIds, newLocById, srcMemoryId, destMemoryId, crossMemory, memoryUrns, createdBy: editor.userId ?? editor.info ?? null,
    })),
  ];
  return result;
}

/** One edge whose URN a move changed: its old URN keeps resolving through an EDGE alias (ruling 0162). */
export interface EdgeUrnChange {
  edgeId: string;
  /** `hrn:edge:<memory urn>:<loc>` before the move. */
  previousUrn: string;
  /** The same, after. */
  urn: string;
}

/**
 * #2947 (rulings 0153, 0154, 0161, 0162; cor:api:190:01, :02) — what a move does to the EDGES that touch the moved subtree,
 * for a same-memory AND a cross-memory move.
 *
 *  - A DERIVED edge (`locAuthored = false`) whose source OR target moved gets its loc re-derived from the new endpoints.
 *    A loc already held in its memory, by a live OR a soft-deleted edge, gets a numbered suffix (the unique index covers
 *    every row); the edges park at an id-unique temp loc first, so a rebase onto the moved subtree's own old slots never
 *    trips the unique mid-transaction.
 *  - An AUTHORED edge keeps its loc on every move (0154). The one exception is a cross-memory move of its SOURCE, which
 *    carries it into the destination memory (its memory atom changes): it keeps the loc, and a loc the destination already
 *    holds gets a numbered suffix (0161). Authored edges claim their locs before derived ones do.
 *  - A governed edge (INCLUDE, COMMENT_*) is never touched here: its loc is id-derived. (A carried thread's COMMENT_ANCHOR
 *    gets its EDGE alias in the carried-comments step of the move, 0162.)
 *  - A boundary edge whose only moved endpoint is its TARGET, moved to another memory than the edge's own, is not rebased.
 *  - Every edge whose URN changes keeps its old URN as an EDGE alias (0162), derived or authored.
 *
 * The recorded flag is the only thing that tells derived from authored; nothing is inferred from the loc at move time.
 */
async function rebaseMovedEdges(
  tx: Prisma.TransactionClient,
  a: {
    movedIds: Set<string>;
    newLocById: Map<string, string>;
    srcMemoryId: string;
    destMemoryId: string;
    crossMemory: boolean;
    memoryUrns: Map<string, string>;
    createdBy: string | null;
  },
): Promise<EdgeUrnChange[]> {
  const moved = [...a.movedIds];
  const edges = await tx.edge.findMany({
    where: { deletedAt: null, governedKind: null, OR: [{ sourceId: { in: moved } }, { targetId: { in: moved } }] },
  });
  if (edges.length === 0) return [];

  // Current locs of the endpoints that did NOT move (the moved ones are in newLocById).
  const outsideIds = [...new Set(edges.flatMap((e) => [e.sourceId, e.targetId]).filter((id) => !a.newLocById.has(id)))];
  const outsideLoc = new Map<string, string>();
  if (outsideIds.length > 0) {
    for (const r of await tx.node.findMany({ where: { id: { in: outsideIds } }, select: { id: true, loc: true } })) outsideLoc.set(r.id, r.loc);
  }
  const locOf = (id: string) => a.newLocById.get(id) ?? outsideLoc.get(id);

  // Memory URNs for the memories the edges live in before and after.
  const memoryIds = new Set<string>([a.srcMemoryId, a.destMemoryId, ...edges.map((e) => e.memoryId)]);
  const missing = [...memoryIds].filter((id) => !a.memoryUrns.has(id));
  if (missing.length > 0) {
    for (const m of await tx.memory.findMany({ where: { id: { in: missing } }, select: { id: true, urn: true } })) a.memoryUrns.set(m.id, m.urn);
  }

  type Plan = { id: string; name: string | null; oldMemoryId: string; oldLoc: string; memoryId: string; base: string; authored: boolean };
  const plans: Plan[] = [];
  for (const e of edges) {
    const carried = a.crossMemory && a.movedIds.has(e.sourceId); // the edge's memory follows its source
    const memoryId = carried ? a.destMemoryId : e.memoryId;
    if (e.locAuthored) {
      if (carried) plans.push({ id: e.id, name: e.name, oldMemoryId: e.memoryId, oldLoc: e.loc, memoryId, base: e.loc, authored: true });
      continue;
    }
    // Ruling of 2026-11-21 (Holger, "don't rebase"): a boundary edge whose only moved endpoint is its TARGET, moved into a
    // memory other than the edge's own, keeps its stored loc: a rebased loc would hand source-memory readers the
    // destination's loc past the endpoint gate.
    if (a.crossMemory && !a.movedIds.has(e.sourceId) && e.memoryId !== a.destMemoryId) continue;
    const src = locOf(e.sourceId); const tgt = locOf(e.targetId);
    if (src == null || tgt == null) continue; // an endpoint vanished: leave the edge as it is
    const base = deriveEdgeLoc(src, e.name, tgt);
    if (base === e.loc && memoryId === e.memoryId) continue; // nothing about its address changed
    plans.push({ id: e.id, name: e.name, oldMemoryId: e.memoryId, oldLoc: e.loc, memoryId, base, authored: false });
  }
  if (plans.length === 0) return [];

  // Park, so no rebase can collide with a slot another moving edge is about to leave.
  for (const p of plans) await tx.edge.update({ where: { id: p.id }, data: { loc: `__moving-edge-${p.id}` }, select: { id: true } });

  // Slots already held in each landing memory (live OR soft-deleted): the exact base or a numbered variant of it.
  const taken = new Map<string, Set<string>>();
  for (const memoryId of new Set(plans.map((p) => p.memoryId))) {
    const bases = [...new Set(plans.filter((p) => p.memoryId === memoryId).map((p) => p.base))];
    const rows = await tx.edge.findMany({
      where: { memoryId, OR: [{ loc: { in: bases } }, ...bases.map((b) => ({ loc: { startsWith: `${b}:` } }))] },
      select: { loc: true },
    });
    taken.set(memoryId, new Set(rows.map((r) => r.loc)));
  }

  const changes: EdgeUrnChange[] = [];
  const emit = (memoryId: string, loc: string) => safeEdgeUrnV2(a.memoryUrns.get(memoryId)!, loc);
  // Authored edges claim their locs first.
  for (const p of [...plans].sort((x, y) => Number(y.authored) - Number(x.authored))) {
    const held = taken.get(p.memoryId)!;
    let loc = p.base;
    for (let k = 2; held.has(loc); k++) loc = `${p.base}:${k}`;
    held.add(loc);
    await tx.edge.update({ where: { id: p.id }, data: { loc, memoryId: p.memoryId }, select: { id: true } });
    const previousUrn = emit(p.oldMemoryId, p.oldLoc);
    const urn = emit(p.memoryId, loc);
    if (previousUrn === urn) continue;
    await recordUrnRename(tx, {
      entityType: 'EDGE', entityId: p.id,
      oldUrn: previousUrn.slice('hrn:edge:'.length), newUrn: urn.slice('hrn:edge:'.length),
      createdBy: a.createdBy,
    });
    changes.push({ edgeId: p.id, previousUrn, urn });
  }
  return changes;
}
