import type { Prisma } from '../../generated/prisma/index.js';
import { newestApprovedRevisionOf } from '../nodeApproval.js';
import {
  INCLUDE_RETENTION_PARSER_VERSION, INCLUDE_RETENTION_SCHEMA_VERSION, IncludeRetentionInactiveError,
} from './structuralReferences.js';

/**
 * #2063 R1 / cor:dmo:150:07: internal, access-free retention calculation. Only
 * revision numbers leave this function; it never returns foreign source metadata.
 * Soft-deleted sources AND their tombstoned memories remain reliance owners.
 * Capture-memory scoping prevents a moved node's foreign history from entering
 * this set. Signed-only is ignored as in the shared include selector (D7).
 *
 * Caller must hold the outer include-history fence. No production caller exists
 * in R1. Global completeness is separately checked by verifyIncludeCoverage;
 * R2/R3 must keep coverage current or dirty the generation before R4 wiring.
 */
export async function reliedRevisionsOf(
  tx: Prisma.TransactionClient,
  targetNodeId: string,
  captureMemoryId: string,
): Promise<Set<number>> {
  const generation = await tx.includeRetentionGeneration.findUnique({ where: { id: 'singleton' } });
  if (!generation || generation.state !== 'ACTIVE'
    || generation.schemaVersion !== INCLUDE_RETENTION_SCHEMA_VERSION
    || generation.parserVersion !== INCLUDE_RETENTION_PARSER_VERSION
    || generation.verifiedBindingGeneration !== generation.bindingGeneration) throw new IncludeRetentionInactiveError();


  const target = await tx.node.findUnique({ where: { id: targetNodeId }, select: { memoryId: true, loc: true } });
  const result = new Set<number>();
  if (!target || target.memoryId !== captureMemoryId) return result;
  // DISTINCT in SQL, with no take/LIMIT: high fan-in cannot truncate reliance.
  const references = await tx.$queryRaw<Array<{ pinnedRevNo: number | null; approved: boolean }>>`
    SELECT DISTINCT pinned_rev_no AS "pinnedRevNo", requires_approved AS approved
    FROM include_references
    WHERE target_memory_id = ${target.memoryId} AND target_loc = ${target.loc}`;
  let approved = false;
  for (const reference of references) {
    if (reference.pinnedRevNo !== null) result.add(reference.pinnedRevNo);
    else if (reference.approved) approved = true;
  }
  if (approved) {
    // Same predicate/selector as S2; no decrypt-to-qualify branch and no carrier
    // inference (a newer byte-identical sibling may be the served snapshot).
    const selected = await newestApprovedRevisionOf(tx, targetNodeId);
    if (selected.truncated) throw new IncludeRetentionInactiveError();
    if (selected.found?.source === 'snapshot') result.add(selected.found.revNo);
  }
  return result;
}
