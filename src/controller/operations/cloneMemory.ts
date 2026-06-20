import type { PrismaClient } from '../../generated/prisma/index.js';
import { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { computeContentHash } from '../../lib/contentHash.js';

/**
 * Clone a Memory: copy the Memory row plus its live graph (Nodes, Edges,
 * PendingEdges) into a new Memory under a new URN, rewriting references to
 * the source memory's URN inside node content/abstract and pending-edge
 * targets.
 *
 * What is deliberately NOT copied (the clone is a fresh start, not a fork
 * of the source's operational state):
 *   - NodeVersion history — clone nodes are "newly created" (the create
 *     path in upsertNode also writes no initial version).
 *   - NodeEmbedding vectors — content changes under URN rewrite, so the
 *     caller re-stamps via backfillMemoryEmbeddings when the clone is
 *     vector-indexed.
 *   - MemorySubscription / MemoryShare / MemoryMember / Session /
 *     MemoryLicense / AgentMemoryItem / MemoryLogEntry rows — social and
 *     operational state belongs to the source. (Group-class clones get the
 *     caller bootstrapped as first owner, matching createMemory.)
 *   - Assets — bytes live in object storage; copying them is a future
 *     follow-up. Asset URNs in content keep pointing at the source memory.
 *   - Git-sync config (source, tokens, branches, sync state) — a clone
 *     syncing from the source repo would be destructively overwritten
 *     (repo wins), so it starts DB-only.
 *   - Soft-deleted nodes/edges — only the live graph is cloned.
 */

/**
 * The two textual forms a memory URN appears in inside node content.
 * `Memory.urn` is STORED in legacy form `<org>:<slug>` (org URNs contain no
 * `:`); the spec-021 canonical form doubles the org→memory separator:
 * `<org>::<slug>`. Node references in content appear as
 * `urn:node:<org>::<slug>::<loc>`, bare `<org>::<slug>::<loc>`, or legacy
 * `<org>:<slug>:<loc>` — all share one of these two memory-URN prefixes.
 */
export function memoryUrnForms(storedUrn: string): { legacy: string; canonical: string } {
  const sep = storedUrn.indexOf(':');
  const canonical =
    sep === -1 ? storedUrn : `${storedUrn.slice(0, sep)}::${storedUrn.slice(sep + 1)}`;
  return { legacy: storedUrn, canonical };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Slug-atom charset per the spec-021 grammar is [a-z0-9._-]; boundary
// classes below decide where a memory-URN match may begin/end inside prose.
//
// Left boundary INCLUDES `.` — so `foo.acme.com:dev` (a different org that
// happens to end with the source org's domain) is not rewritten.
// Right boundary: a bare `.` followed by a non-slug char (or end) is
// sentence punctuation ("see acme.com::dev.") and must NOT block the
// rewrite — but `.` followed by another slug-atom char is still inside an
// identifier (`acme.com::dev.x` is a DIFFERENT memory whose slug extends
// the source's with a dot atom), so that blocks the match (PR-265 review,
// Copilot).
const LEFT_BOUNDARY = 'A-Za-z0-9._-';
const RIGHT_BOUNDARY = 'A-Za-z0-9_-';
const SLUG_ATOM = 'A-Za-z0-9._-';

/**
 * Rewrite every reference to `oldUrn` (stored legacy form) into `newUrn`
 * inside a text blob. Handles both the canonical (`org::slug`) and legacy
 * (`org:slug`) spellings, including `urn:<type>:`-prefixed and
 * node-loc-suffixed (`...::loc:part`) occurrences. Returns the input
 * unchanged (same reference) when nothing matches.
 */
export function rewriteMemoryUrnRefs(
  text: string | null,
  oldUrn: string,
  newUrn: string,
): string | null {
  if (!text) return text;
  const oldForms = memoryUrnForms(oldUrn);
  const newForms = memoryUrnForms(newUrn);
  let out = text;
  // Canonical pass first: after it, no canonical spelling of the old URN
  // remains, so the legacy pass can't partially match inside one.
  for (const [from, to] of [
    [oldForms.canonical, newForms.canonical],
    [oldForms.legacy, newForms.legacy],
  ] as const) {
    const re = new RegExp(
      `(?<![${LEFT_BOUNDARY}])${escapeRegExp(from)}(?![${RIGHT_BOUNDARY}])(?!\\.[${SLUG_ATOM}])`,
      'g',
    );
    out = out.replace(re, to);
  }
  return out;
}

/** Json-column value for createMany: Prisma rejects raw `null` on Json? columns. */
function jsonOrDbNull(v: Prisma.JsonValue | null) {
  return v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
}

export interface CloneMemoryArgs {
  sourceMemoryId: string;
  /** New memory display name; the caller derives `newUrn` from it. */
  name: string;
  /** Pre-computed `<org.urn>:<name>` for the clone (caller checks collisions). */
  newUrn: string;
  /** Owner for personal/private clones (chk_personal_visibility_user). */
  ownerUserId: string | null;
  /** Bootstrap this user as the group-class clone's first owner member. */
  groupOwnerUserId: string | null;
  /** Audit attribution for createdBy columns. */
  actorId: string | null;
}

export interface CloneMemoryResult {
  memoryId: string;
  nodeCount: number;
  edgeCount: number;
  pendingEdgeCount: number;
}

/**
 * Execute the clone inside one transaction. The caller is responsible for
 * authorization, source-class/encryption gating, and URN collision checks
 * (see the cloneMemory resolver), plus post-clone embedding backfill.
 */
export async function cloneMemoryGraph(
  db: PrismaClient,
  args: CloneMemoryArgs,
): Promise<CloneMemoryResult> {
  return db.$transaction(
    async (tx) => {
      const source = await tx.memory.findUniqueOrThrow({
        where: { id: args.sourceMemoryId },
      });

      const memoryId = generateId();
      await tx.memory.create({
        data: {
          id: memoryId,
          organizationId: source.organizationId,
          urn: args.newUrn,
          name: args.name,
          shortDescription: source.shortDescription,
          description: source.description,
          tags: source.tags,
          license: source.license,
          category0: source.category0,
          category1: source.category1,
          category2: source.category2,
          iconUrl: source.iconUrl,
          heroUrl: source.heroUrl,
          homeUrl: source.homeUrl,
          visibility: source.visibility,
          class: source.class,
          requiresLicense: source.requiresLicense,
          acceptsUploads: source.acceptsUploads,
          // 033 vector-index config carries over; vectors themselves are
          // re-derived (the caller backfills after the transaction).
          vectorIndexEnabled: source.vectorIndexEnabled,
          embeddingSource: source.embeddingSource,
          chunkTokens: source.chunkTokens,
          chunkOverlap: source.chunkOverlap,
          forceFixedSize: source.forceFixedSize,
          // Git-sync config intentionally NOT copied — see module doc.
          // userId only for personal/private (CHECK-enforced both ways).
          userId: args.ownerUserId,
          createdBy: args.actorId,
        },
      });

      // ── Nodes ──────────────────────────────────────────────────────────
      const nodes = await tx.node.findMany({
        where: { memoryId: source.id, deletedAt: null },
      });

      const idMap = new Map<string, string>();
      for (const n of nodes) idMap.set(n.id, generateId());

      const nodeRows: Prisma.NodeCreateManyInput[] = nodes.map((n) => {
        const newContent = rewriteMemoryUrnRefs(n.content, source.urn, args.newUrn);
        const newAbstract = rewriteMemoryUrnRefs(n.abstract, source.urn, args.newUrn);
        const contentChanged = newContent !== n.content;
        // Spec 032: abstractOriginHash is SHA256(plaintext content) at
        // abstract-authoring time. If the source abstract was FRESH
        // (origin hash matches the old content), keep it fresh against the
        // rewritten content; if it was already stale, preserve the old
        // hash so the staleness signal survives the clone.
        let abstractOriginHash = n.abstractOriginHash;
        if (
          contentChanged &&
          abstractOriginHash !== null &&
          abstractOriginHash === computeContentHash(n.content)
        ) {
          abstractOriginHash = computeContentHash(newContent);
        }
        return {
          id: idMap.get(n.id)!,
          memoryId,
          nodeType: n.nodeType,
          name: n.name,
          alias: n.alias,
          loc: n.loc,
          isLink: n.isLink,
          description: n.description,
          abstract: newAbstract,
          content: newContent,
          // contentHash lives in the external-producer hash domain
          // (SHA256(yaml+md), set by git sync). The rewrite invalidates it
          // and the clone has no git backing — null it when content
          // changed rather than storing a hash that describes other bytes.
          contentHash: contentChanged ? null : n.contentHash,
          abstractOriginHash,
          tags: n.tags,
          properties: jsonOrDbNull(n.properties),
          data: jsonOrDbNull(n.data),
          seq: n.seq,
          ownerRepo: n.ownerRepo,
          isRunnable: n.isRunnable,
          llmModel: n.llmModel,
          aiAgent: n.aiAgent,
          tokens: n.tokens,
          // Embedding markers start clean; backfill re-stamps if indexed.
          createdBy: args.actorId,
        };
      });
      if (nodeRows.length > 0) {
        await tx.node.createMany({ data: nodeRows });
      }

      // ── Edges ──────────────────────────────────────────────────────────
      // Clone every live edge whose SOURCE lives in this memory. Targets:
      //   - live internal node → remapped to its clone
      //   - soft-deleted internal node → edge skipped
      //   - external node (cross-memory edge) → original target kept
      // Incoming edges from other memories' nodes are NOT cloned — that
      // would add outgoing edges to nodes the clone doesn't own.
      const edges = await tx.edge.findMany({
        where: { deletedAt: null, sourceId: { in: [...idMap.keys()] } },
      });
      // Targets not in the live-ID map are either soft-deleted internal
      // nodes (skip the edge) or external nodes (keep the original id).
      // Query only those — not every node id of the source memory — to
      // classify them (PR-265 review, Gemini).
      const unmappedTargetIds = [
        ...new Set(edges.map((e) => e.targetId).filter((id) => !idMap.has(id))),
      ];
      const deletedInternalTargetIds = new Set(
        unmappedTargetIds.length > 0
          ? (
              await tx.node.findMany({
                where: { id: { in: unmappedTargetIds }, memoryId: source.id },
                select: { id: true },
              })
            ).map((n) => n.id)
          : [],
      );
      const edgeRows: Prisma.EdgeCreateManyInput[] = [];
      for (const e of edges) {
        const newTarget = idMap.get(e.targetId);
        if (!newTarget && deletedInternalTargetIds.has(e.targetId)) continue;
        edgeRows.push({
          id: generateId(),
          // Spec 037: edge identity is (loc, memoryId). The clone preserves
          // node locs, so the derived edge loc stays valid + unique; just
          // copy it and retarget memoryId to the new memory.
          memoryId,
          sourceId: idMap.get(e.sourceId)!,
          targetId: newTarget ?? e.targetId,
          loc: e.loc,
          name: e.name,
          description: e.description,
          isRunnable: e.isRunnable,
          condition: jsonOrDbNull(e.condition),
          priority: e.priority,
          data: jsonOrDbNull(e.data),
          createdBy: args.actorId,
        });
      }
      if (edgeRows.length > 0) {
        await tx.edge.createMany({ data: edgeRows, skipDuplicates: true });
      }

      // ── PendingEdges ───────────────────────────────────────────────────
      // targetId is a free-form string (not a FK) and may embed the source
      // memory's URN — rewrite it like content.
      const pendingEdges = await tx.pendingEdge.findMany({
        where: { deletedAt: null, sourceId: { in: [...idMap.keys()] } },
      });
      const pendingRows: Prisma.PendingEdgeCreateManyInput[] = pendingEdges.map((p) => ({
        id: generateId(),
        sourceId: idMap.get(p.sourceId)!,
        targetId: rewriteMemoryUrnRefs(p.targetId, source.urn, args.newUrn)!,
        loc: p.loc,
        name: p.name,
        createdBy: args.actorId,
      }));
      if (pendingRows.length > 0) {
        await tx.pendingEdge.createMany({ data: pendingRows, skipDuplicates: true });
      }
      if (pendingRows.length > 0) {
        await tx.memory.update({
          where: { id: memoryId },
          data: { pendingEdgeCount: pendingRows.length },
        });
      }

      // Group-class clone: caller becomes the first owner in the SAME
      // transaction so the memory is never persisted zero-owner
      // (matches createMemory's bootstrap).
      if (source.class === 'group' && args.groupOwnerUserId) {
        await tx.memoryMember.create({
          data: {
            memoryId,
            userId: args.groupOwnerUserId,
            role: 'owner',
            createdBy: args.groupOwnerUserId,
          },
        });
      }

      // Provenance breadcrumb on the clone.
      await tx.memoryLogEntry.create({
        data: {
          id: generateId(),
          memoryId,
          level: 'INFO',
          eventType: 'OTHER',
          message: `Cloned from memory "${source.urn}"`,
          detail: { sourceMemoryId: source.id, sourceMemoryUrn: source.urn },
          createdBy: args.actorId,
        },
      });

      return {
        memoryId,
        nodeCount: nodeRows.length,
        edgeCount: edgeRows.length,
        pendingEdgeCount: pendingRows.length,
      };
    },
    // Large memories copy thousands of rows; the default 5s interactive-
    // transaction timeout is too tight.
    { timeout: 120_000 },
  );
}
