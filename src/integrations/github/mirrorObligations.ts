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
import { mirrorFailureMetadata } from './mirrorFailureMetadata.js';
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
  /** #3042: captured row identity; empty/absent means legacy branch not recorded. */
  branch?: string;
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
    console.error('[git-mirror] Could not take an attempt number; this attempt records nothing', mirrorFailureMetadata(err, 'sequence', 'ATTEMPT_SEQUENCE'));
    return null;
  }
}

/** One entry per distinct five-part key, in a stable row-lock/upsert order. */
function distinct(refs: readonly MirrorObligationRef[]) {
  const byKey = new Map<string, { nodeId: string; kind: string; removeLoc: string; branch: string }>();
  for (const r of refs) {
    const key = { nodeId: r.nodeId, kind: r.kind, removeLoc: r.kind === 'REMOVE' ? (r.removeLoc ?? '') : '', branch: r.branch ?? '' };
    byKey.set(JSON.stringify([key.nodeId, key.kind, key.removeLoc, key.branch]), key);
  }
  return [...byKey.values()].sort((a, b) => {
    for (const field of ['nodeId', 'kind', 'removeLoc', 'branch'] as const) {
      const order = Buffer.compare(Buffer.from(a[field]), Buffer.from(b[field]));
      if (order) return order;
    }
    return 0;
  });
}

/** #3042: only explicit not-mirrored observations may clear all branches. */
export interface MirrorSettlementRoute {
  /** Retry of captured debt on a different current fixed branch: atomically re-key, never guess. */
  targetBranch?: string;
  /** An ordinary successful fixed-branch writer also covers unambiguous legacy debt. */
  clearLegacy?: boolean;
  allBranches?: boolean;
}

/**
 * Settle a validated attempted branch. Every upsert/delete includes branch and the existing attempt fence.
 * For fixed-config drift, lock the captured and destination rows in branch order, judge the source fence AFTER
 * the lock, and settle in one transaction. A conflict-safe upsert also handles a destination inserted after the
 * absent-row read by an outside-lock LOCK_FAILED writer. A newer destination is never changed.
 * Failure tracking remains soft; no exception text is persisted or logged.
 */
export async function settleMirrorObligations(
  db: PrismaClient, memoryId: string, refs: readonly MirrorObligationRef[],
  settlement: MirrorSettlement, attemptSeq: bigint, maxAttempts?: number, route: MirrorSettlementRoute = {},
): Promise<void> {
  const keys = distinct(refs);
  if (!keys.length) return;
  const limit = maxAttempts ?? null;
  const nodeIds = keys.map(k => k.nodeId), kinds = keys.map(k => k.kind), locs = keys.map(k => k.removeLoc), branches = keys.map(k => k.branch);
  const state = settlement.result === 'failed' && settlement.errorClass === 'NOT_CLONED' ? 'NOT_CLONED' : 'FAILED';
  try {
    // Re-key all captured rows atomically. This also preserves multiple REMOVE locs and their independent fences.
    if (route.targetBranch !== undefined && keys.some(k => k.branch !== route.targetBranch)) {
      const target = route.targetBranch;
      await db.$transaction(async tx => {
        // Lock the union up front in a consistent order. Missing destination rows are handled by ON CONFLICT below.
        const locked = await tx.$queryRaw<Array<{ nodeId: string; kind: string; removeLoc: string; branch: string; attempts: number; attemptSeq: bigint }>>`
          SELECT o.node_id AS "nodeId", o.kind::text AS kind, o.remove_loc AS "removeLoc", o.branch,
            o.attempts, o.attempt_seq AS "attemptSeq"
          FROM git_mirror_obligations o
          WHERE o.memory_id = ${memoryId} AND EXISTS (
            SELECT 1 FROM unnest(${nodeIds}::text[], ${kinds}::text[], ${locs}::text[], ${branches}::text[])
              AS r(node_id, kind, remove_loc, branch)
            WHERE o.node_id = r.node_id AND o.kind::text = r.kind AND o.remove_loc = r.remove_loc
              AND o.branch IN (r.branch, ${target}))
          ORDER BY o.node_id COLLATE "C", o.kind::text COLLATE "C", o.remove_loc COLLATE "C", o.branch COLLATE "C" FOR UPDATE OF o`;
        for (const key of keys) {
          const source = locked.find(r => r.nodeId === key.nodeId && r.kind === key.kind && r.removeLoc === key.removeLoc && r.branch === key.branch);
          if (!source || source.attemptSeq >= attemptSeq) continue;
          if (settlement.result === 'cleared') {
            await tx.$executeRaw`
              DELETE FROM git_mirror_obligations WHERE memory_id = ${memoryId} AND node_id = ${key.nodeId}
                AND kind::text = ${key.kind} AND remove_loc = ${key.removeLoc}
                AND branch IN (${key.branch}, ${target}) AND attempt_seq < ${attemptSeq}`;
          } else {
            await tx.$executeRaw`
              INSERT INTO git_mirror_obligations
                (memory_id,node_id,kind,remove_loc,branch,state,error_class,attempts,attempt_seq,last_attempt_at)
              VALUES (${memoryId},${key.nodeId},${key.kind}::git_mirror_obligation_kind,${key.removeLoc},${target},
                (CASE WHEN ${limit}::int IS NOT NULL AND ${source.attempts + 1} >= ${limit}::int THEN 'EXHAUSTED' ELSE ${state} END)::git_mirror_obligation_state,
                ${settlement.errorClass},${source.attempts + 1},${attemptSeq},now())
              ON CONFLICT (memory_id,node_id,kind,remove_loc,branch) DO UPDATE SET
                attempts = GREATEST(git_mirror_obligations.attempts, ${source.attempts}) + 1,
                state = (CASE WHEN ${limit}::int IS NOT NULL AND GREATEST(git_mirror_obligations.attempts, ${source.attempts}) + 1 >= ${limit}::int
                  THEN 'EXHAUSTED' ELSE ${state} END)::git_mirror_obligation_state,
                error_class = EXCLUDED.error_class, attempt_seq = EXCLUDED.attempt_seq, last_attempt_at = now()
              WHERE git_mirror_obligations.attempt_seq < EXCLUDED.attempt_seq`;
            // Even if a newer destination won the upsert race, it covers the same debt on the only current branch.
            if (key.branch !== target) await tx.$executeRaw`
              DELETE FROM git_mirror_obligations WHERE memory_id = ${memoryId} AND node_id = ${key.nodeId}
                AND kind::text = ${key.kind} AND remove_loc = ${key.removeLoc} AND branch = ${key.branch}
                AND attempt_seq < ${attemptSeq}`;
          }
        }
      });
      return;
    }
    if (settlement.result === 'cleared') {
      await db.$executeRaw`
        DELETE FROM git_mirror_obligations o
        USING unnest(${nodeIds}::text[], ${kinds}::text[], ${locs}::text[], ${branches}::text[]) AS r(node_id,kind,remove_loc,branch)
        WHERE o.memory_id = ${memoryId} AND o.node_id = r.node_id AND o.kind::text = r.kind AND o.remove_loc = r.remove_loc
          AND (o.branch = r.branch OR ${route.allBranches ?? false} OR (${route.clearLegacy ?? false} AND o.branch = ''))
          AND o.attempt_seq < ${attemptSeq}`;
      return;
    }
    await db.$executeRaw`
      INSERT INTO git_mirror_obligations
        (memory_id,node_id,kind,remove_loc,branch,state,error_class,attempts,attempt_seq,last_attempt_at)
      SELECT ${memoryId},r.node_id,r.kind::git_mirror_obligation_kind,r.remove_loc,r.branch,
        (CASE WHEN ${limit}::int IS NOT NULL AND 1 >= ${limit}::int THEN 'EXHAUSTED' ELSE ${state} END)::git_mirror_obligation_state,
        ${settlement.errorClass},1,${attemptSeq},now()
      FROM unnest(${nodeIds}::text[], ${kinds}::text[], ${locs}::text[], ${branches}::text[]) AS r(node_id,kind,remove_loc,branch)
      ON CONFLICT (memory_id,node_id,kind,remove_loc,branch) DO UPDATE SET
        state = CASE WHEN ${limit}::int IS NOT NULL AND git_mirror_obligations.attempts + 1 >= ${limit}::int
          THEN 'EXHAUSTED'::git_mirror_obligation_state ELSE EXCLUDED.state END,
        error_class = EXCLUDED.error_class, attempts = git_mirror_obligations.attempts + 1,
        attempt_seq = EXCLUDED.attempt_seq, last_attempt_at = now()
      WHERE git_mirror_obligations.attempt_seq < EXCLUDED.attempt_seq`;
  } catch (err) {
    console.error(`[git-mirror] Could not settle ${keys.length} obligation(s) for memory ${memoryId}`, mirrorFailureMetadata(err, 'settle', 'SETTLEMENT'));
  }
}
