/**
 * The memory health audit (#819), extracted from `hadron_validate` so the MCP
 * tool and the GraphQL `validateMemory` query run the SAME checks.
 *
 * Every check here is over server-owned state a client cannot compute:
 * `abstractOriginHash` vs current content (the staleness rule lives here),
 * `embedding_failed_at` (not projected on Node at all), and property-schema
 * conformance (needs the memory's declared schema plus the validator). So
 * unlike other MCP-only gaps there is no slow client-side fallback — which is
 * why this returns STRUCTURED findings rather than prose: a caller has to be
 * able to branch on them, and CI has to be able to gate on the count.
 *
 * Deliberately pure: takes a resolved memoryId, does no auth. Callers gate.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { isAbstractUnverified } from './contentHash.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from './validateNodeAgainstSchema.js';
import { normalizeObjectType } from './enforceNodeSchema.js';
import type { MemorySchema } from './memorySchema.js';

/** The six checks. Mirrors the GraphQL MemoryValidationCheck enum. */
export type ValidationKind =
  | 'BROKEN_REF'
  | 'SPARSE'
  | 'STALE_ABSTRACT'
  | 'EMBED_FAILED'
  | 'INDEX_TRUNCATED'
  | 'GIT_MIRROR_FAILED'
  | 'SCHEMA';

export interface ValidationFinding {
  kind: ValidationKind;
  nodeId: string;
  nodeLoc: string;
  detail: string;
}

export interface SkippedCheck {
  check: ValidationKind;
  reason: string;
}

export interface ValidationReport {
  nodesChecked: number;
  /** Findings, capped at `maxFindings`. */
  findings: ValidationFinding[];
  /** The TRUE count, even when `findings` was capped. */
  totalFindings: number;
  /** Non-informational findings, counted even beyond the retained page. */
  totalProblems: number;
  /**
   * A check that could NOT run. Reported explicitly rather than silently
   * omitted: a clean bill of health that quietly skipped a check is worse than
   * no report at all (#819).
   */
  skippedChecks: SkippedCheck[];
}

/**
 * Run every applicable check over a memory's nodes.
 *
 * Scans the whole memory in one pass, as the MCP tool does — the checks are
 * cross-referential (broken-ref needs the full id set), so a partial scan
 * would produce false positives rather than fewer findings.
 */
export async function validateMemoryNodes(
  db: PrismaClient,
  memoryId: string,
  /**
   * Cap on RETAINED findings (#859 review, Copilot). A large, badly broken
   * memory can produce thousands, and building the whole array only to slice
   * it defeats the point of bounding the response — the detail strings alone
   * are a memory and latency risk. Findings past the cap are COUNTED but not
   * kept, so `totalFindings` stays truthful.
   *
   * The node SCAN is deliberately not bounded: the checks are
   * cross-referential, so a partial scan produces false positives rather than
   * fewer findings.
   */
  maxFindings = 1000,
): Promise<ValidationReport> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { isEncrypted: true, schema: true },
  });

  const skippedChecks: SkippedCheck[] = [];
  // Spec 032 FR-011: this does NOT decrypt, so on an encrypted memory
  // `content` is ciphertext and computeContentHash would differ from every
  // plaintext-derived abstractOriginHash — a false positive on EVERY node.
  // Skipped in v1, and now SAID so (#206 tracks the decrypt step).
  const checkStale = !memory?.isEncrypted;
  if (!checkStale) {
    skippedChecks.push({
      check: 'STALE_ABSTRACT',
      reason:
        'Memory is encrypted: the validator does not decrypt, so every abstract would compare stale against ciphertext (spec 032 FR-011; decrypt step tracked by #206).',
    });
  }
  const conformanceSchema = memory?.schema as unknown as MemorySchema | null;

  const nodes = await db.node.findMany({
    // #884: LIVE nodes only. A soft-deleted node's findings are unactionable —
    // no read surface resolves it, retryFailedEmbeddings and the embed worker
    // both skip it — so a tombstone carrying a stale marker (e.g.
    // embeddingFailedAt from before its deletion) would pollute the audit
    // forever and never clear. Tombstone rows contribute nothing the checks
    // need: target liveness for BROKEN_REF is resolved against the DB below,
    // not against this fetch.
    where: { memoryId, deletedAt: null },
    // #859 review (Codex P2): exclude soft-deleted EDGE rows. Revision-restore
    // paths can leave them behind and every normal edge surface excludes them,
    // so counting one as a broken reference would fail CI for a relation that
    // no longer exists.
    include: { outgoingEdges: { where: { deletedAt: null } } },
  });
  const findings: ValidationFinding[] = [];
  let totalFindings = 0;
  let totalProblems = 0;
  const record = (f: ValidationFinding) => {
    totalFindings += 1;
    if (f.kind !== 'INDEX_TRUNCATED') totalProblems += 1;
    if (findings.length < maxFindings) findings.push(f);
  };

  // BROKEN_REF, corrected in #819. The pre-#819 check compared every edge
  // target against THIS memory's node ids, which was wrong in both directions:
  //
  //   * FALSE POSITIVES on every legitimate CROSS-MEMORY edge — a supported
  //     feature (#755 gates writing one, #781 gates reading it back). Any
  //     memory that links out was reported as riddled with broken refs, which
  //     would make the audit useless for the CI gating #819 exists to enable.
  //   * FALSE NEGATIVES on tombstones — the local id set included soft-deleted
  //     rows, so an edge dangling at a deleted node read as healthy. And a
  //     HARD-deleted target cannot occur at all: Edge.target is FK-enforced
  //     with onDelete: Cascade, so deleting a node takes its edges with it.
  //
  // So the real question is "is this target LIVE anywhere?", which needs one
  // extra lookup for the targets not live in this memory. (Since #884 the
  // fetch above is already live-only, so no further filtering here.)
  const liveLocalIds = new Set(nodes.map((n) => n.id));
  const suspectTargetIds = new Set<string>();
  for (const node of nodes) {
    for (const edge of node.outgoingEdges) {
      if (!liveLocalIds.has(edge.targetId)) suspectTargetIds.add(edge.targetId);
    }
  }
  const liveElsewhereIds = suspectTargetIds.size
    ? new Set(
        (
          await db.node.findMany({
            where: { id: { in: [...suspectTargetIds] }, deletedAt: null },
            select: { id: true },
          })
        ).map((n) => n.id),
      )
    : new Set<string>();
  const targetIsLive = (id: string) => liveLocalIds.has(id) || liveElsewhereIds.has(id);

  for (const node of nodes) {
    for (const edge of node.outgoingEdges) {
      if (!targetIsLive(edge.targetId)) {
        record({
          kind: 'BROKEN_REF',
          nodeId: node.id,
          nodeLoc: node.loc,
          detail: `Edge ${edge.name ?? edge.loc} points at a node that is missing or deleted (id:${edge.targetId})`,
        });
      }
    }
    // #725: normalizeObjectType so the audit matches write-seam semantics — a
    // legacy blank objectType means "no collection", not an undeclared one.
    // (Tombstone exclusion moved to the fetch itself in #884 — every check
    // now sees live nodes only.)
    const auditObjectType = normalizeObjectType(node.objectType);
    // Spec 031 FR-011: an abstract counts as legitimate content, so a node
    // carrying only an abstract is NOT sparse. #2516 (cor:api:020:03): an
    // object node is never sparse — objects are data-only by design.
    if (auditObjectType == null && !node.description && !node.content && !node.abstract) {
      record({
        kind: 'SPARSE',
        nodeId: node.id,
        nodeLoc: node.loc,
        detail: 'No description, content, or abstract',
      });
    }
    // #1128 — shared predicate (isAbstractUnverified). This used to carry its
    // own copy with an `abstractOriginHash != null` guard, added to keep the
    // validator quiet on legacy pre-spec-032 rows; that population has since
    // drained to 2 rows in production, and a missing fingerprint is exactly
    // what an operator running the validator wants told.
    if (checkStale && isAbstractUnverified(node)) {
      record({
        kind: 'STALE_ABSTRACT',
        nodeId: node.id,
        nodeLoc: node.loc,
        detail: 'Abstract may not reflect current content',
      });
    }
    // Spec 033: `embedding_failed_at` is stamped on EVERY failed attempt —
    // in-flight transient ("will retry"), cap-exhausted, and the #206
    // permanent encrypted-no-plaintext class. All are operator-useful, because
    // from outside this audit an empty vector index is indistinguishable from
    // "no hits matched".
    if (node.embeddingTruncatedChunks != null && node.embeddingTruncatedChunks > 0) {
      record({ kind: 'INDEX_TRUNCATED', nodeId: node.id, nodeLoc: node.loc,
        detail: `${node.embeddingTruncatedChunks} passage chunks omitted by the per-node indexing cap (informational)` });
    }
    if (node.embeddingFailedAt) {
      record({
        kind: 'EMBED_FAILED',
        nodeId: node.id,
        nodeLoc: node.loc,
        // `?.trim() ||` (not `??`) so a blank message doesn't render empty.
        detail: node.embeddingError?.trim() || 'unknown',
      });
    }
    if (conformanceSchema != null && auditObjectType != null) {
      try {
        validateNodeAgainstSchema(
          conformanceSchema,
          auditObjectType,
          (node.properties ?? null) as Record<string, unknown> | null,
        );
      } catch (e) {
        if (e instanceof NodeSchemaViolation) {
          record({
            kind: 'SCHEMA',
            nodeId: node.id,
            nodeLoc: node.loc,
            detail: e.message,
          });
        } else throw e;
      }
    }
  }

  // #430: a Git-mirror attempt that did not land leaves a row (src/integrations/github/mirrorObligations.ts). From outside, a
  // stale mirror looks like a healthy one until the repo-wins sync reverts the lost write. Fixed class and loc only: the row
  // never holds exception text. An encrypted memory never syncs to Git (R206), so a row it left behind is not a finding.
  if (!memory?.isEncrypted) {
    const liveLocById = new Map(nodes.map((n) => [n.id, n.loc]));
    const obligations = await db.gitMirrorObligation.findMany({
      where: { memoryId },
      orderBy: [{ nodeId: 'asc' }, { kind: 'asc' }, { removeLoc: 'asc' }],
    });
    for (const o of obligations) {
      // A REMOVE row names the path still owed; a WRITE row needs the node to be live (#884: no finding on a tombstone).
      const nodeLoc = o.kind === 'REMOVE' ? o.removeLoc : liveLocById.get(o.nodeId);
      if (nodeLoc === undefined) continue;
      record({
        kind: 'GIT_MIRROR_FAILED',
        nodeId: o.nodeId,
        nodeLoc,
        detail: `${o.kind === 'REMOVE' ? 'Git mirror removal of this path' : 'Git mirror write'} did not land (${o.errorClass}, ${o.attempts} attempt${o.attempts === 1 ? '' : 's'}); the repository may be stale`,
      });
    }
  }

  return { nodesChecked: nodes.length, findings, totalFindings, totalProblems, skippedChecks };
}

/** The MCP prose line for one finding — the pre-#819 wording, preserved. */
export function formatFindingLine(f: ValidationFinding, nodeUrn: string): string {
  const tag = {
    BROKEN_REF: 'broken-ref',
    SPARSE: 'sparse',
    STALE_ABSTRACT: 'stale-abstract',
    EMBED_FAILED: 'embed-failed',
    INDEX_TRUNCATED: 'index-truncated',
    GIT_MIRROR_FAILED: 'git-mirror-failed',
    SCHEMA: 'schema',
  }[f.kind];
  switch (f.kind) {
    case 'BROKEN_REF': {
      // "→ id:<target> (<name>)" — reconstructed from the structured detail.
      const m = f.detail.match(/^Edge (.*) points at a node that is missing or deleted \((id:.*)\)$/);
      return m ? `[${tag}] ${nodeUrn} → ${m[2]} (${m[1]})` : `[${tag}] ${nodeUrn} — ${f.detail}`;
    }
    case 'SPARSE':
      return `[${tag}] ${nodeUrn} — no description, content, or abstract`;
    case 'STALE_ABSTRACT':
      return `[${tag}] ${nodeUrn} — abstract may not reflect current content`;
    default:
      return `[${tag}] ${nodeUrn} — ${f.detail}`;
  }
}
