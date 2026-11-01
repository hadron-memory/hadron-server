/**
 * #430 (first slice): record the Git-mirror attempts that did not land, so a stale mirror is no longer silent.
 *
 * Every DB → git mirror is fire-and-forget by contract: a failed write logs and returns an outcome, and the repo-wins
 * sync later reverts what the mirror never published. `withMirrorCheckout` now settles each attempt it was told about
 * (`opts.obligations`) into `git_mirror_obligations`: a FAILED / NOT_CLONED row while the last attempt failed, no row
 * after a success or when the memory is simply not mirrored. This slice RECORDS failures the process survives; it does
 * not retry, reconcile, or stamp intent before the attempt (a crash before the stamp and a lost event stay open).
 *
 * **Fencing.** The attempt sequence is taken INSIDE the per-memory checkout lock and the settle runs before that lock
 * releases (`withMirrorCheckout`), so settles for one memory apply in lock order, across processes. The conflict arm of
 * the failure upsert and the success delete both require `attempt_seq <` the settling attempt's, so a stale settle that
 * does arrive late (the one path outside the lock: a lock that could not be taken) is a no-op against a newer row and can
 * at worst leave one spurious FAILED row, the safe direction. A memory that is NOT mirrored (no source, no org, encrypted,
 * an invalid source) settles as `cleared` on the same fence: its number is taken BEFORE the configuration is read, so a
 * stale "not mirrored" observation, which a newer attempt's lock-taken number always exceeds, cannot delete that attempt's
 * row. Success deletes are NOT a high-water mark: the row is gone afterwards, so a lower-numbered failure that arrives
 * late can re-create it (a spurious row, the safe direction; pinned in mirrorObligations430.test.ts).
 *
 * **Redaction.** A row stores one of a closed set of fixed words. Exception text is never stored: a raw Git error can
 * carry an installation-token URL (findings:git-execfile-error-carries-auth-url).
 *
 * Every function here is soft: a settle that cannot be written logs a fixed line and returns, because the DB write that
 * triggered the mirror already committed.
 */
import { Prisma } from '../../generated/prisma/index.js';
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

/** Next attempt number. Taken inside the checkout lock, so numbers for one memory rise in lock order. */
export async function takeAttemptSeq(db: PrismaClient): Promise<bigint> {
  const [{ seq }] = await db.$queryRaw<Array<{ seq: bigint }>>`SELECT nextval('git_mirror_attempt_seq')::bigint AS seq`;
  return seq;
}

/**
 * `takeAttemptSeq` that never throws: failure tracking is a soft add-on to the mirror, so a sequence that cannot be taken
 * logs a fixed line and yields null, and the caller mirrors anyway and records nothing for that attempt.
 */
export async function tryTakeAttemptSeq(db: PrismaClient): Promise<bigint | null> {
  try {
    return await takeAttemptSeq(db);
  } catch (err) {
    console.error(`[git-mirror] Could not take an attempt number; this attempt records nothing: ${errorCode(err)}`);
    return null;
  }
}

/** One entry per distinct key: an upsert that names a key twice would fail the whole statement. */
function distinct(refs: readonly MirrorObligationRef[]): Array<{ nodeId: string; kind: string; removeLoc: string }> {
  const byKey = new Map<string, { nodeId: string; kind: string; removeLoc: string }>();
  for (const r of refs) {
    const removeLoc = r.kind === 'REMOVE' ? (r.removeLoc ?? '') : '';
    byKey.set(`${r.nodeId}\u0000${r.kind}\u0000${removeLoc}`, { nodeId: r.nodeId, kind: r.kind, removeLoc });
  }
  return [...byKey.values()];
}

/**
 * Settle one attempt for `refs` in `memoryId`. A sweep may supply its attempt cap: reaching it records EXHAUSTED
 * inside the same fenced upsert. Ordinary writers supply no cap and can recover or leave a new FAILED row.
 * A failure is an upsert that only applies over an OLDER attempt; a
 * success deletes only rows an older attempt left. Never throws.
 */
export async function settleMirrorObligations(
  db: PrismaClient, memoryId: string, refs: readonly MirrorObligationRef[],
  settlement: MirrorSettlement, attemptSeq: bigint, maxAttempts?: number,
): Promise<void> {
  const keys = distinct(refs);
  if (keys.length === 0) return;
  const limit = maxAttempts ?? null;
  const nodeIds = keys.map((k) => k.nodeId);
  const kinds = keys.map((k) => k.kind);
  const locs = keys.map((k) => k.removeLoc);
  try {
    if (settlement.result === 'cleared') {
      await db.$executeRaw`
        DELETE FROM git_mirror_obligations o
        USING unnest(${nodeIds}::text[], ${kinds}::text[], ${locs}::text[]) AS r(node_id, kind, remove_loc)
        WHERE o.memory_id = ${memoryId} AND o.node_id = r.node_id AND o.kind::text = r.kind
          AND o.remove_loc = r.remove_loc AND o.attempt_seq < ${attemptSeq}`;
      return;
    }
    const state = settlement.errorClass === 'NOT_CLONED' ? 'NOT_CLONED' : 'FAILED';
    await db.$executeRaw`
      INSERT INTO git_mirror_obligations
        (memory_id, node_id, kind, remove_loc, state, error_class, attempts, attempt_seq, last_attempt_at)
      SELECT ${memoryId}, r.node_id, r.kind::git_mirror_obligation_kind, r.remove_loc,
             CASE WHEN ${limit}::int IS NOT NULL AND 1 >= ${limit}::int THEN 'EXHAUSTED' ELSE ${state} END::git_mirror_obligation_state, ${settlement.errorClass}, 1, ${attemptSeq}, now()
      FROM unnest(${nodeIds}::text[], ${kinds}::text[], ${locs}::text[]) AS r(node_id, kind, remove_loc)
      ON CONFLICT (memory_id, node_id, kind, remove_loc) DO UPDATE
        SET state = CASE WHEN ${limit}::int IS NOT NULL AND git_mirror_obligations.attempts + 1 >= ${limit}::int
              THEN 'EXHAUSTED'::git_mirror_obligation_state ELSE EXCLUDED.state END, error_class = EXCLUDED.error_class,
            attempts = git_mirror_obligations.attempts + 1,
            attempt_seq = EXCLUDED.attempt_seq, last_attempt_at = now()
        WHERE git_mirror_obligations.attempt_seq < EXCLUDED.attempt_seq`;
  } catch (err) {
    console.error(`[git-mirror] Could not settle ${keys.length} obligation(s) for memory ${memoryId}: ${errorCode(err)}`);
  }
}

/** A fixed token for the log line: a Prisma code or the error's name, never its message (which can echo data). */
function errorCode(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  return err instanceof Error ? err.name : 'unknown';
}
