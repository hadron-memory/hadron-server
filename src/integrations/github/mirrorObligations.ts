/**
 * #430 (first slice): record the Git-mirror attempts that did not land.
 *
 * STUB in the schema commit: the types and entry points exist, nothing settles yet. The behavior lands in the next
 * commit, after the pins that prove its absence.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';

/** The closed set of failure words a row may carry (CHECK in git-mirror-obligation-invariants.sql). */
export type MirrorErrorClass =
  | 'TOKEN_UNAVAILABLE' | 'BRANCH_SETUP' | 'TREE_WRITE' | 'PUSH_FAILED' | 'LOCK_FAILED' | 'NOT_CLONED';

/** One file the mirror owes the repository: a node's current file (WRITE) or an old loc to vacate (REMOVE). */
export interface MirrorObligationRef {
  nodeId: string;
  kind: 'WRITE' | 'REMOVE';
  /** Required for REMOVE (the loc captured when the node left it), absent for WRITE. */
  removeLoc?: string;
}

/** How one attempt ended, as far as the obligation is concerned. */
export type MirrorSettlement = { result: 'cleared' } | { result: 'failed'; errorClass: MirrorErrorClass };

export async function takeAttemptSeq(_db: PrismaClient): Promise<bigint> {
  return 0n;
}

export async function settleMirrorObligations(
  _db: PrismaClient, _memoryId: string, _refs: readonly MirrorObligationRef[],
  _settlement: MirrorSettlement, _attemptSeq: bigint,
): Promise<void> {}

export async function clearMirrorObligations(
  _db: PrismaClient, _memoryId: string, _refs: readonly MirrorObligationRef[],
): Promise<void> {}
