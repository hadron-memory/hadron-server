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
import { computeContentHash } from './contentHash.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from './validateNodeAgainstSchema.js';
import { normalizeObjectType } from './enforceNodeSchema.js';
import type { MemorySchema } from './memorySchema.js';

/** The five checks. Mirrors the GraphQL MemoryValidationCheck enum. */
export type ValidationKind =
  | 'BROKEN_REF'
  | 'SPARSE'
  | 'STALE_ABSTRACT'
  | 'EMBED_FAILED'
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
  findings: ValidationFinding[];
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
    where: { memoryId },
    include: { outgoingEdges: true },
  });
  const findings: ValidationFinding[] = [];

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
  // extra lookup for the targets not live in this memory.
  const liveLocalIds = new Set(nodes.filter((n) => !n.deletedAt).map((n) => n.id));
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
        findings.push({
          kind: 'BROKEN_REF',
          nodeId: node.id,
          nodeLoc: node.loc,
          detail: `Edge ${edge.name ?? edge.loc} points at a node that is missing or deleted (id:${edge.targetId})`,
        });
      }
    }
    // Spec 031 FR-011: an abstract counts as legitimate content, so a node
    // carrying only an abstract is NOT sparse.
    if (!node.description && !node.content && !node.abstract) {
      findings.push({
        kind: 'SPARSE',
        nodeId: node.id,
        nodeLoc: node.loc,
        detail: 'No description, content, or abstract',
      });
    }
    // The explicit `abstractOriginHash != null` guard keeps the validator
    // quiet on legacy pre-spec-032 rows that never carried the signal.
    if (
      checkStale &&
      node.abstract != null && node.abstract.length > 0 &&
      node.content != null && node.content.length > 0 &&
      node.abstractOriginHash != null &&
      node.abstractOriginHash !== computeContentHash(node.content)
    ) {
      findings.push({
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
    if (node.embeddingFailedAt) {
      findings.push({
        kind: 'EMBED_FAILED',
        nodeId: node.id,
        nodeLoc: node.loc,
        // `?.trim() ||` (not `??`) so a blank message doesn't render empty.
        detail: node.embeddingError?.trim() || 'unknown',
      });
    }
    // #725: normalizeObjectType so the audit matches write-seam semantics — a
    // legacy blank objectType means "no collection", not an undeclared one.
    // Soft-deleted tombstones are skipped: a non-conforming deleted row is not
    // actionable.
    const auditObjectType = normalizeObjectType(node.objectType);
    if (conformanceSchema != null && auditObjectType != null && node.deletedAt == null) {
      try {
        validateNodeAgainstSchema(
          conformanceSchema,
          auditObjectType,
          (node.properties ?? null) as Record<string, unknown> | null,
        );
      } catch (e) {
        if (e instanceof NodeSchemaViolation) {
          findings.push({
            kind: 'SCHEMA',
            nodeId: node.id,
            nodeLoc: node.loc,
            detail: e.message,
          });
        } else throw e;
      }
    }
  }

  return { nodesChecked: nodes.length, findings, skippedChecks };
}

/** The MCP prose line for one finding — the pre-#819 wording, preserved. */
export function formatFindingLine(f: ValidationFinding, nodeUrn: string): string {
  const tag = {
    BROKEN_REF: 'broken-ref',
    SPARSE: 'sparse',
    STALE_ABSTRACT: 'stale-abstract',
    EMBED_FAILED: 'embed-failed',
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
