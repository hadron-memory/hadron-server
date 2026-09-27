import type { NodeContentValidationOutcome } from '../generated/prisma/index.js';

export type NodeContentValidationState = 'UNVALIDATED' | 'STALE' | NodeContentValidationOutcome;

/**
 * Reports are advisory evidence for the exact node revision they observed.
 * A later task/rule revision does not retroactively invalidate a report.
 */
export function nodeContentValidationState(
  nodeRevision: number,
  report: { nodeRevSeq: number; outcome: NodeContentValidationOutcome } | null,
): NodeContentValidationState {
  if (!report) return 'UNVALIDATED';
  if (report.nodeRevSeq > nodeRevision) return 'UNVALIDATED';
  return report.nodeRevSeq === nodeRevision ? report.outcome : 'STALE';
}
