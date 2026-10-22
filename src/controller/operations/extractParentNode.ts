import { withIncludeHistoryClientTransaction } from '../../lib/includes/includeHistoryFence.js';
import { assertCopiedIncludesWritable, resyncDerivedIncludesForNodes, type ReadableMemoryIds } from '../../lib/includes/writeIncludes.js';
import { assertRoleWritersForNodes, type RoleWriterPrincipal } from '../../lib/nodeRoleWriters.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { decisionContainedError, isDecisionFamilyRole } from '../../lib/decisions/index.js';
import { assertBatchMutable } from '../../lib/bulkMutationGate.js';
import { assertNoMintedSpecRemoval } from '../../lib/mintedSpecPermanence.js';
import { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { ensureCurrentNodeRevisionInTransaction, jsonOrDbNull } from '../../lib/nodeRevisionSnapshot.js';
import { carryGovernedSignals } from '../../lib/governedSignals.js';
import { carryNodeAuthorship, clearNodeAuthorship } from '../../lib/nodeAuthorship.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { rebindIncludeTags } from '../../lib/includes/rebindIncludeTags.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import type { MemoryClass, MemoryVisibility } from '../../generated/prisma/index.js';

/**
 * Extract a parent node and its whole loc-subtree into a BRAND-NEW memory,
 * making the parent the new memory's root.
 *
 * The "subtree" is loc-prefix defined (the same shape searchReplaceInNodes /
 * moveNode descendants use): the node at `parentLoc` plus every live node whose
 * loc starts with `parentLoc:`. Locs are REBASED so the parent becomes the
 * memory root — `parentLoc` → `rootLoc`, `parentLoc:x:y` → `rootLoc:x:y`.
 *
 * Two dispositions (chosen by the caller):
 *   - copy (default): the source subtree stays; the new memory gets fresh-id
 *     copies (mirrors cloneMemory — the copies are "newly created", no revision
 *     history, embeddings backfilled by the caller when indexed).
 *   - move: after the copy, the source subtree (its nodes + the source memory's
 *     edges/pending-edges touching it) is soft-deleted, so the parent is truly
 *     relocated out of the source.
 *
 * The new memory PRESERVES the source's class (a `group` source stays a
 * member-restricted group, personal/private stay owner-owned) so an extract
 * never widens who can read the content. Governance/config columns
 * (requiresLicense, acceptsUploads, revision cap, chunk dials) carry over from
 * the source too.
 *
 * What carries over and what does not (v1):
 *   - Edges: ONLY those wholly INSIDE the subtree (both endpoints moved). Their
 *     loc is re-derived from the rebased endpoint locs (edge identity is
 *     loc+memory, spec 037), with a numeric suffix on the rare derived-loc
 *     collision so no edge is silently dropped. Boundary-crossing edges are
 *     DROPPED.
 *   - PendingEdges: DROPPED (an unresolved forward reference from the subtree
 *     is left behind; carrying + rewriting them is a follow-up).
 *   - NodeRevision history, embeddings, subscriptions/shares/members, assets,
 *     git-sync config: NOT copied (same rationale as cloneMemory).
 *
 * v1 limitation: node content/abstract are copied verbatim. Because both the
 * memory slug AND node locs change, URN references among the moved nodes inside
 * prose WILL break (a self-reference like `…::findings:auth:oauth` is wrong on
 * both axes) — a full loc-rewrite is a follow-up.
 *
 * The caller (extractParentNodeToMemory resolver) is responsible for authz,
 * source-class/encryption gating, URN-collision checks, and post-extract
 * embedding backfill.
 */

export interface ExtractParentNodeArgs {
  /** #1331 — the caller, for the role writer level of a MOVE's source nodes. Omitted by server-authored callers. */
  principal?: RoleWriterPrincipal;
  /** Source memory the subtree currently lives in. */
  sourceMemoryId: string;
  /** Loc of the parent node — the subtree root to extract. */
  parentLoc: string;
  /** Pre-computed `<org.urn>:<slug>` URN for the new memory. */
  newUrn: string;
  /** Display name of the new memory. Doubles as its root loc (a valid slug). */
  name: string;
  /** Root loc for the rebased subtree — the parent node lands here. */
  rootLoc: string;
  /** Org the new memory lands in (resolved + authorized by the caller). */
  targetOrganizationId: string;
  /** Class of the new memory — the source's own (system/app rejected upstream). */
  newClass: MemoryClass;
  /** Visibility of the new memory (GROUP for group; NULL for personal/private). */
  visibility: MemoryVisibility | null;
  /** Owner for personal/private extractions (chk_personal_visibility_user). */
  ownerUserId: string | null;
  /** Bootstrap this user as the group-class extract's first owner member. */
  groupOwnerUserId: string | null;
  /** contentChunks vector index on the new memory (knowledge default = true). */
  vectorIndexEnabled: boolean;
  /** move = soft-delete the source subtree after copying; copy = leave it. */
  move: boolean;
  /** Audit attribution for createdBy / deletedBy columns. */
  actorId: string | null;
  /** #2167 — memories the copier may read (`getAccessibleMemoryIds`); `null` = unrestricted. */
  copierReadableMemoryIds: ReadableMemoryIds;
}

export interface ExtractParentNodeResult {
  memoryId: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Execute the extract inside one transaction. Throws if no live node exists at
 * `parentLoc` in the source memory.
 */
export async function extractParentNodeGraph(
  db: PrismaClient,
  args: ExtractParentNodeArgs,
): Promise<ExtractParentNodeResult> {
  return withIncludeHistoryClientTransaction(db,
    async (tx) => {
      const source = await tx.memory.findUniqueOrThrow({ where: { id: args.sourceMemoryId } });

      // ── Subtree ──────────────────────────────────────────────────────────
      // The node at parentLoc plus its descendants, on `:` path boundaries so
      // a sibling like `findings:auth-v2` isn't swept in with `findings:auth`.
      const selectedNodes = await tx.node.findMany({
        where: {
          memoryId: args.sourceMemoryId,
          deletedAt: null,
          OR: [{ loc: args.parentLoc }, { loc: { startsWith: `${args.parentLoc}:` } }],
        },
      });
      const parent = selectedNodes.find((n) => n.loc === args.parentLoc);
      if (!parent) {
        throw new ParentNodeNotFoundError(args.parentLoc, args.sourceMemoryId);
      }
      // #1641 §3.2 — a decision or a log is neither moved nor copied out of
      // its log: a move would delete it here, and a copy would mint decisions
      // no decision operation wrote. (The move/delete statements below act on
      // these ids only, so a log created after this read is never swept.)
      const decisions = selectedNodes.filter((n) => isDecisionFamilyRole(n.role));
      if (decisions.length > 0) {
        throw decisionContainedError(args.move ? 'Extracting and moving this subtree' : 'Extracting this subtree', decisions.map((n) => n.loc));
      }

      // ── The two gates every per-node writer consults (#1191) ────────────
      // Counted on `main` before this: ZERO in this whole operation.
      //
      // BOTH dispositions are gated, not just `move`. #1191 names the move —
      // it soft-deletes the source subtree, so it is a delete in everything but
      // name, and it relocates a Channel's address out from under its row. The
      // COPY needs the PROTECTED-loc half too: a copy into a fresh memory can
      // still reach a Channel's reserved address in the SOURCE, which is what
      // this gate reads.
      //
      // AMENDED by #1210 (2026-09-19). This paragraph used to continue: "...and
      // the copied rows carry `isRunnable`, so extracting a subtree containing
      // a task node MINTS a governed task node in a brand-new memory through a
      // generic surface" — the argument for refusing governed rows here. That
      // is the reading @Holger's owning-operation ruling overturns: a
      // preserving copy duplicates an approved node rather than authoring one.
      // The governed half is now `{ governed: 'carry' }` below, with the full
      // reasoning at the call. The minting hazard the old text named is still
      // real and still handled — by the carry PRESERVING rather than deriving.
      //
      // In memory, over rows already loaded — no extra query, and no
      // `startsWith` on a caller-supplied loc (which compiles to an unescaped
      // LIKE where `_` is a legal loc character).
      // AUTHORITATIVE, not a point-in-time read (@codex + @copilot, both P1 on
      // PR #1211). `assertBatchMutable` takes the Channel-memory lock that
      // `ensureChannelWithRoot` holds while it creates one, then re-reads the
      // protected set under it — so a Channel adopted between this check and
      // the `createMany`/soft-delete below either commits first and is seen, or
      // waits behind this transaction.
      //
      // Unlike the merge this whole operation is ONE transaction, so holding
      // the lock here covers every write it performs.
      //
      // CORRECTED by #1210 (@copilot, PR #1230). This used to continue: "…
      // `nodes` was read inside it a few lines above, so the governed check is
      // on this transaction's own snapshot rather than a stale one." That
      // safety property does NOT hold, and the fix directly below is what
      // proves it: `nodes` is read BEFORE the gate takes the memory lock, and
      // the governed-kind doors serialize per loc rather than on that key, so
      // a promotion or demotion can commit in between. READ COMMITTED does not
      // refresh the earlier read. That is precisely why `assertBatchMutable`
      // re-reads the signals and hands them back for the carry to copy — a
      // reader must not lean on this snapshot being current.
      // #1331 — a MOVE removes the subtree from its source memory: each node's role
      // needs its writer level there. A copy writes into a brand-new memory that has
      // no rulebook yet, so nothing narrows it (and it never changes the source).
      if (args.move && args.principal) {
        await assertRoleWritersForNodes(tx, args.principal, selectedNodes, { from: args.sourceMemoryId });
      }
      const freshSignals = await assertBatchMutable(
        tx,
        [args.sourceMemoryId],
        selectedNodes,
        args.move ? 'move' : 'copy',
        // #1210 — extract is an OWNING OPERATION and no longer refuses a
        // governed subtree. @Holger ruled this on 2026-09-19 (#1218), and the
        // reason belongs HERE rather than in the issue, because what is being
        // removed is a deliberate refusal that #1191 added five hours before
        // #1218 was filed:
        //
        //   A PRESERVING COPY NEITHER MINTS NOR CLEARS GOVERNANCE. The copy
        //   arrives governed exactly as the source was — nothing gains
        //   protection it lacked, nothing loses protection it had. That is the
        //   same reasoning that makes revision-restore safe, and it is why
        //   extract carries the signals (`carryGovernedSignals` below) rather
        //   than being refused for carrying them.
        //
        // The paragraph above this call used to justify the refusal with "the
        // copied rows carry `isRunnable`, so extracting a subtree containing a
        // task MINTS a governed task through a generic surface". That reading
        // is what the ruling overturns: duplicating an approved node is not
        // authoring one. The minting hazard it names is real and is addressed
        // where it belongs — the carry PRESERVES and never derives, so extract
        // cannot add a marker the source lacked.
        //
        // NOT loosened: the protected-loc half above still refuses (a
        // Channel's address is a reservation, not a kind marker), and MERGE
        // keeps the refusal — it was never in the ruling.
        //
        // This does NOT close #1202. A governed node extracted into a memory
        // the caller owns is still clearable through the kind's door, because
        // the door refuses the wrong TOOL and never the wrong PRINCIPAL.
        { governed: 'carry' },
      );
      // (@codex P2, PR #1462) A move soft-deletes the source subtree, so it
      // holds the source memory's row fence (FOR SHARE) like every other node
      // write: a mint, which takes that row FOR NO KEY UPDATE, then either sees
      // this extraction committed or finishes before it starts. Node rows are
      // locked first, in id order, then the memory: the order moves and merge
      // folds use, so the fence cannot close a cycle with them. A row that was
      // deleted or moved since the selection refuses as a retry.
      if (args.move) {
        const selectedLoc = new Map(selectedNodes.map((n) => [n.id, n.loc]));
        for (const id of [...selectedLoc.keys()].sort()) {
          const [locked] = await tx.$queryRaw<Array<{ memory_id: string; loc: string; deleted_at: Date | null }>>`
            SELECT memory_id, loc, deleted_at FROM nodes WHERE id = ${id} FOR UPDATE
          `;
          if (!locked || locked.deleted_at || locked.memory_id !== args.sourceMemoryId || locked.loc !== selectedLoc.get(id)) {
            throw new Error('extractParentNode: a source node changed during the copy; retry.');
          }
        }
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${args.sourceMemoryId} FOR SHARE`;
        // #1468 — the move disposition soft-deletes the whole selected subtree
        // from the source memory; a minted spec in it is refused (copy-only is
        // not a removal). Under the fence just taken, in its order.
        await assertNoMintedSpecRemoval(tx, args.sourceMemoryId, [...selectedLoc.keys()], 'extract-and-move');
      }
      // The gate's signal snapshot does not validate authorship. A direct raw
      // edit may leave a stale stamp on a selected source. Reconcile stamped
      // sources in stable row-lock order, then copy their current content and
      // attribution together.
      const refreshed = new Map<string, (typeof selectedNodes)[number]>();
      for (const n of selectedNodes.filter((n) => n.authorshipKind).sort((a, b) => a.id.localeCompare(b.id))) {
        const rev = await ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: args.sourceMemoryId });
        const current = rev == null ? null : await tx.node.findUnique({ where: { id: n.id } });
        if (!current || current.deletedAt || current.memoryId !== args.sourceMemoryId || current.loc !== n.loc) {
          throw new Error('extractParentNode: a source node changed during the copy; retry.');
        }
        refreshed.set(n.id, current);
      }
      const nodes = selectedNodes.map((n) => refreshed.get(n.id) ?? n);

      // Rebase a source loc onto the new root: parentLoc → rootLoc,
      // parentLoc:x → rootLoc:x. `slice(parentLoc.length)` yields '' for the
      // parent and `:x…` for a descendant.
      const rebase = (oldLoc: string): string =>
        args.rootLoc + oldLoc.slice(args.parentLoc.length);

      // ── New memory ───────────────────────────────────────────────────────
      const memoryId = generateId();
      await tx.memory.create({
        data: {
          id: memoryId,
          organizationId: args.targetOrganizationId,
          urn: args.newUrn,
          name: args.name,
          visibility: args.visibility,
          class: args.newClass,
          // Governance/config carried from the source so an extract never
          // silently drops a license gate or resets tuned chunking (a licensed
          // source must stay licensed, cross-org subscribe still gated).
          requiresLicense: source.requiresLicense,
          acceptsUploads: source.acceptsUploads,
          maxRevCount: source.maxRevCount,
          chunkTokens: source.chunkTokens,
          chunkOverlap: source.chunkOverlap,
          forceFixedSize: source.forceFixedSize,
          vectorIndexEnabled: args.vectorIndexEnabled,
          // Match createMemory: a content-chunk index needs a contentChunks
          // source, otherwise most nodes stay unindexed until abstracts exist.
          ...(args.vectorIndexEnabled ? { embeddingSource: 'contentChunks' as const } : {}),
          // userId set iff personal/private (chk_personal_visibility_user).
          userId: args.ownerUserId,
          createdBy: args.actorId,
        },
      });

      // Group-class extract: bootstrap the caller as first owner in the SAME
      // transaction so the memory is never persisted zero-owner (matches
      // createMemory / cloneMemoryGraph).
      if (args.groupOwnerUserId) {
        await tx.memoryMember.create({
          data: {
            memoryId,
            userId: args.groupOwnerUserId,
            role: 'owner',
            createdBy: args.groupOwnerUserId,
          },
        });
      }

      // ── Nodes ────────────────────────────────────────────────────────────
      const idMap = new Map<string, string>();
      const newLocById = new Map<string, string>();
      for (const n of nodes) {
        idMap.set(n.id, generateId());
        newLocById.set(n.id, rebase(n.loc));
      }
      const movedIds = [...idMap.keys()];

      // R180 (#2167) — include tags naming a copied node follow it to its rebased loc.
      const rebasedLocByLoc = new Map(nodes.map((n) => [n.loc, newLocById.get(n.id)!]));
      const nodeRows: Prisma.NodeCreateManyInput[] = nodes.map((n) => {
        const content = rebindIncludeTags(n.content, rebasedLocByLoc, source.urn, args.newUrn);
        const contentChanged = content !== n.content;
        // Spec 032, as clone's URN rewrite: a FRESH abstract stays fresh
        // against the rewritten content; a stale one keeps its stale hash.
        const abstractOriginHash = contentChanged && n.abstractOriginHash !== null && n.abstractOriginHash === computeContentHash(n.content)
          ? computeContentHash(content)
          : n.abstractOriginHash;
        return {
        id: idMap.get(n.id)!,
        memoryId,
        nodeType: n.nodeType,
        objectType: n.objectType,
        name: n.name,
        alias: n.alias,
        loc: newLocById.get(n.id)!,
        isLink: n.isLink,
        description: n.description,
        // Content is verbatim except for R180's include rebinding. A rebound
        // node's contentHash (the external-producer domain) would describe
        // other bytes, so it is nulled, as on clone.
        abstract: n.abstract,
        content,
        contentHash: contentChanged ? null : n.contentHash,
        abstractOriginHash,
        tags: n.tags,
        properties: jsonOrDbNull(n.properties),
        data: jsonOrDbNull(n.data),
        seq: n.seq,
        ownerRepo: n.ownerRepo,
        // #1591: a placeholder's copy is a placeholder (see cloneMemory).
        isPlaceholder: n.isPlaceholder,
        // #1218/#1210 — extract is an OWNING OPERATION: it carries the governed
        // signals (`role`, `isRunnable`) instead of dropping them. This list
        // copied `isRunnable` and not `role`, so an extracted review or spec
        // arrived UNGOVERNED while an extracted task did not. Preserves, never
        // mints. See `governedSignals.ts`.
        //
        // From the GATE's snapshot, not from `n` (@codex P1, PR #1230). `nodes`
        // was read before the gate took the memory lock, and the kind doors do
        // not serialize against that lock — so a promotion committed in between
        // leaves `n` stale, and copying it would produce an ungoverned duplicate
        // of a node that IS governed. With `move: true` the source is then
        // soft-deleted, so the ungoverned copy is all that survives. Falling
        // back to `n` keeps the copy correct if a row vanished from the
        // re-read.
        ...carryGovernedSignals(refreshed.has(n.id) ? n : freshSignals?.get(n.loc) ?? n),
        // Content and attribution both come from the reconciled source; a
        // rebound node's content is no longer what its author wrote (cor:api:150:01).
        ...(contentChanged ? clearNodeAuthorship() : carryNodeAuthorship(n)),
        llmModel: n.llmModel,
        aiAgent: n.aiAgent,
        tokens: n.tokens,
        // Embedding markers start clean; the caller backfills if indexed.
        createdBy: args.actorId,
        };
      });
      if (nodeRows.length > 0) {
        await tx.node.createMany({ data: nodeRows });
      }

      // ── Edges (intra-subtree only) ───────────────────────────────────────
      // Both endpoints must be in the moved set; boundary-crossing edges are
      // dropped. Edge loc is re-derived from the rebased endpoint locs (node
      // locs changed; edge identity is loc+memory, spec 037). Two source edges
      // between the same endpoints with names that sanitize alike derive the
      // same loc — disambiguate with a numeric suffix so neither is dropped.
      const edges = await tx.edge.findMany({
        where: {
          // movedIds are all source-memory nodes, so this is implied — but
          // stating it lets the planner use the (memoryId, ...) index and keeps
          // the "edges of the source memory" invariant explicit.
          memoryId: args.sourceMemoryId,
          deletedAt: null,
          sourceId: { in: movedIds },
          targetId: { in: movedIds },
          // Derived INCLUDE edges (#2040) are re-derived for the copies, not copied.
          OR: [{ governedKind: null }, { governedKind: { not: 'INCLUDE' } }],
        },
      });
      const usedEdgeLocs = new Set<string>();
      const edgeRows: Prisma.EdgeCreateManyInput[] = edges.map((e) => {
        const base = deriveEdgeLoc(newLocById.get(e.sourceId)!, e.name, newLocById.get(e.targetId)!);
        let loc = base;
        for (let n = 2; usedEdgeLocs.has(loc); n++) loc = `${base}:${n}`;
        usedEdgeLocs.add(loc);
        return {
          id: generateId(),
          memoryId,
          sourceId: idMap.get(e.sourceId)!,
          targetId: idMap.get(e.targetId)!,
          loc,
          name: e.name,
          description: e.description,
          isRunnable: e.isRunnable,
          condition: jsonOrDbNull(e.condition),
          priority: e.priority,
          data: jsonOrDbNull(e.data),
          createdBy: args.actorId,
        };
      });
      if (edgeRows.length > 0) {
        await tx.edge.createMany({ data: edgeRows });
      }
      // #2167 — every copied tag is an added tag, resolved where it landed: the
      // content is verbatim, so a relative tag resolves against the rebased locs.
      const copiedIds = nodeRows.map((r) => r.id as string);
      await assertCopiedIncludesWritable(tx, copiedIds, memoryId, args.copierReadableMemoryIds);
      // #2040 — the copies' include edges are re-derived from their content.
      await resyncDerivedIncludesForNodes(tx, copiedIds);

      // ── Move disposition ─────────────────────────────────────────────────
      // Soft-delete the source subtree so the parent is truly relocated.
      if (args.move) {
        const now = new Date();
        // Only edges that LIVE in the source memory (Edge.memoryId is the
        // source node's memory). This catches intra-subtree edges and outgoing
        // edges to nodes outside the subtree. Incoming cross-memory edges
        // (memoryId = another memory) are left untouched — soft-deleting them
        // would mutate a memory the caller has no write access to.
        // Derived include edges (#2040) are dropped, not soft-deleted: the
        // governed-edge trigger refuses a soft delete, and content re-derives them.
        await tx.edge.deleteMany({
          where: {
            governedKind: 'INCLUDE',
            OR: [{ sourceId: { in: movedIds } }, { targetId: { in: movedIds } }],
          },
        });
        await tx.edge.updateMany({
          where: {
            memoryId: args.sourceMemoryId,
            deletedAt: null,
            OR: [{ sourceId: { in: movedIds } }, { targetId: { in: movedIds } }],
          },
          data: { deletedAt: now, deletedBy: args.actorId },
        });
        await tx.node.updateMany({
          where: { memoryId: args.sourceMemoryId, id: { in: movedIds }, deletedAt: null },
          data: { deletedAt: now, deletedBy: args.actorId },
        });
        // PendingEdges hang off moved nodes (sourceId, Cascade) — soft-delete
        // them too so none dangle at a now-deleted node, and keep the source's
        // denormalized pendingEdgeCount honest.
        const movedPending = await tx.pendingEdge.findMany({
          where: { sourceId: { in: movedIds }, deletedAt: null },
          select: { id: true },
        });
        if (movedPending.length > 0) {
          await tx.pendingEdge.updateMany({
            where: { id: { in: movedPending.map((p) => p.id) } },
            data: { deletedAt: now, deletedBy: args.actorId },
          });
          await tx.memory.update({
            where: { id: args.sourceMemoryId },
            data: { pendingEdgeCount: { decrement: movedPending.length } },
          });
        }
      }

      // Provenance breadcrumb on the new memory.
      await tx.memoryLogEntry.create({
        data: {
          id: generateId(),
          memoryId,
          level: 'INFO',
          eventType: 'OTHER',
          message: `${args.move ? 'Moved' : 'Extracted'} from node "${args.parentLoc}" of memory "${source.urn}"`,
          detail: {
            sourceMemoryId: args.sourceMemoryId,
            sourceMemoryUrn: source.urn,
            parentLoc: args.parentLoc,
            move: args.move,
          },
          createdBy: args.actorId,
        },
      });

      return { memoryId, nodeCount: nodeRows.length, edgeCount: edgeRows.length };
    },
    // A large subtree copies many rows; the default 5s interactive-transaction
    // timeout is too tight (mirrors cloneMemoryGraph).
    { timeout: 120_000 },
  );
}

/** No live node exists at the requested parent loc in the source memory. */
export class ParentNodeNotFoundError extends Error {
  constructor(
    public readonly loc: string,
    public readonly memoryId: string,
  ) {
    super(`No live node at loc "${loc}" in memory ${memoryId}.`);
    this.name = 'ParentNodeNotFoundError';
  }
}
