/**
 * #430: retry only recorded failures. No write intent, cloning, startup pass, or second Git transport.
 * #425: also apply PENDING captures — REMOVE debts the nodes trigger recorded at delete time, before any
 * attempt — on the next pass, with no backoff wait.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { memoryLocalPath, withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { writeNodeFile, removeNodeFile, nodePayloadHasCiphertext, type NodeForGit } from '../integrations/github/writeNodeToGit.js';
import { loadNodeForGit } from '../integrations/github/nodeWrittenSubscriber.js';
import { nodeFilePath, orphanedLegacyPaths } from '../integrations/github/nodeFrontmatter.js';
import { legacySidecarEdgesFile } from '../integrations/github/legacySidecar.js';
import { validateMemorySource } from '../lib/gitSource.js';
import { mirrorFailureMetadata } from '../integrations/github/mirrorFailureMetadata.js';
import { gitMirrorSweepRowBudget } from './gitMirrorSweepBudget.js';
import { Prisma } from '../generated/prisma/index.js';
import { mirrorRetryBranchEligibleSql } from '../integrations/github/mirrorBranchEligibility.js';
import { mutateMirrorFiles, hasIncompleteMirrorMutation } from '../integrations/github/mirrorFileMutation.js';
import { settleMirrorObligations, tryTakeAttemptSeq, type MirrorObligationRef, type MirrorSettlement } from '../integrations/github/mirrorObligations.js';
import { toNaiveUtc } from '../lib/sessionActivity.js';

export const MAX_ATTEMPTS = 10;
const INTERVAL_MS = 10 * 60_000;
const MAX_MEMORIES = 20;
let running = false;
type DueMemory = { memoryId: string; source: string; memoryUrn: string; orgUrn: string; writeBranch: string | null; dueAt: Date };
type DueRow = { nodeId: string; kind: 'WRITE' | 'REMOVE'; removeLoc: string; branch: string };

/**
 * #425 review: settle a skipped memory's CAPTURED debts instead of leaving them PENDING. A capture is due the
 * moment it exists and has no backoff arm, and a skip runs no attempt, so a memory this pass must skip (no local clone, an
 * invalid stored source) had its PENDING rows selected on EVERY later tick, `validate` reading "waiting for the next mirror
 * sweep" forever. Through the one fenced settle writer they take the shape every other un-runnable obligation already has:
 *  - no local clone: NOT_CLONED, what an ordinary writer's un-cloned attempt records (#430). The debt is KEPT — it backs off,
 *    applies when the clone returns, and an un-cloned skip then leaves it byte-identical (#3060);
 *  - an invalid stored source: cleared. The memory is not mirrored (configuration, not a failure), exactly what
 *    withMirrorCheckout settles for an ordinary writer's obligations there.
 * Settled rows (FAILED, NOT_CLONED) are not touched: a skip still leaves them byte-identical (#3060).
 *
 * Not lock-ordered (a skip never takes the checkout lock), so the fence is what keeps it safe, as for a lock-failed settle:
 * a restore cancelling a row between the read and the settle gets at worst one spurious row back (the safe direction; the
 * next attempt's live-owner check clears it). For the no-clone arm that clearing waits for the clone to return — no
 * attempt runs without one — and until then the rows this settles are the due-row query's PENDING rows (a FAILED row in backoff stays FAILED), and a settled row already
 * reports "did not land" with the repository possibly stale, so the spurious row reports nothing the state does not
 * already say. The number is taken only once a row is found: a skip with nothing
 * captured consumes no attempt and no sequence.
 */
async function settleCapturedOnSkip(db: PrismaClient, memory: DueMemory, settlement: MirrorSettlement): Promise<void> {
  // The rows the due-row query below admits for this memory (a PENDING row is always due), without its LIMIT.
  const captured = await db.$queryRaw<DueRow[]>`
    SELECT node_id AS "nodeId", kind, remove_loc AS "removeLoc", branch
    FROM git_mirror_obligations
    WHERE memory_id = ${memory.memoryId} AND state = 'PENDING' AND attempts < ${MAX_ATTEMPTS}
      AND ${mirrorRetryBranchEligibleSql(Prisma.sql`branch`, Prisma.sql`${memory.writeBranch}`)}`;
  if (!captured.length) return;
  const seq = await tryTakeAttemptSeq(db);
  if (seq === null) return;
  await settleMirrorObligations(db, memory.memoryId, captured, settlement, seq, MAX_ATTEMPTS);
}

/** One bounded run. The selection is a hint; withMirrorCheckout re-reads each row inside its memory lock. */
export async function gitMirrorSweepTick(db: PrismaClient, now = new Date()): Promise<number> {
  if (running) return 0;
  running = true;
  let handled = 0;
  let remainingRows = gitMirrorSweepRowBudget();
  try {
    // State/attempt predicates also exclude an ordinary writer's FAILED row whose old EXHAUSTED attempts exceed the cap.
    // Order by the oldest DUE time, not the oldest attempt. Invalid stored sources are excluded below before the bound.
    let afterDue: Date | null = null;
    let afterId = '';
    while (handled < MAX_MEMORIES && remainingRows > 0) {
      // #3174: bind naive UTC text, never a Date (a Date binds as timestamptz and shifts by the session zone).
      const afterDueUtc = afterDue ? toNaiveUtc(afterDue) : null;
      const candidates: DueMemory[] = await db.$queryRaw<DueMemory[]>`
        WITH due AS (
        SELECT m.id AS "memoryId", m.source, m.urn AS "memoryUrn", org.urn AS "orgUrn", m.write_branch AS "writeBranch",
          MIN(CASE WHEN o.state = 'PENDING' THEN o.last_attempt_at
                   ELSE o.last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(o.attempts - 1, 7)), 72) END) AS "dueAt"
        FROM git_mirror_obligations o JOIN memories m ON m.id = o.memory_id JOIN organizations org ON org.id = m.organization_id
        WHERE o.state IN ('PENDING', 'FAILED', 'NOT_CLONED') AND o.attempts < ${MAX_ATTEMPTS}
          AND ${mirrorRetryBranchEligibleSql(Prisma.sql`o.branch`, Prisma.sql`m.write_branch`)}
          AND NOT m.is_encrypted AND m.source IS NOT NULL AND m.organization_id IS NOT NULL AND m.deleted_at IS NULL
          AND (CASE WHEN o.state = 'PENDING' THEN o.last_attempt_at
                    ELSE o.last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(o.attempts - 1, 7)), 72) END) <= ${toNaiveUtc(now)}::timestamp
        GROUP BY m.id, m.source, m.urn, org.urn, m.write_branch
        ) SELECT * FROM due
        WHERE (${afterDueUtc}::timestamp IS NULL OR ("dueAt", "memoryId") > (${afterDueUtc}::timestamp, ${afterId}::text))
        ORDER BY "dueAt", "memoryId" LIMIT ${MAX_MEMORIES}`;
      for (const candidate of candidates) {
        // The sweep never clones (#430) and never touches the network for an invalid stored source. A skipped memory's
        // captured debts are settled here rather than left due forever (see settleCapturedOnSkip).
        try { validateMemorySource(candidate.source); } catch {
          await settleCapturedOnSkip(db, candidate, { result: 'cleared' });
          continue;
        }
        if (!existsSync(join(memoryLocalPath(candidate.orgUrn, candidate.memoryUrn), '.git'))) {
          await settleCapturedOnSkip(db, candidate, { result: 'failed', errorClass: 'NOT_CLONED' });
          continue;
        }
        if (handled >= MAX_MEMORIES || remainingRows === 0) break;
        handled++;
        // Bound the DB result, not just its consumer. Only due rows reserve budget slots; the existing lock-time
        // re-read still decides whether a selected row needs an attempt after a competing writer has run.
        const rows = await db.$queryRaw<DueRow[]>`
          SELECT node_id AS "nodeId", kind, remove_loc AS "removeLoc", branch
          FROM git_mirror_obligations
          WHERE memory_id = ${candidate.memoryId} AND state IN ('PENDING', 'FAILED', 'NOT_CLONED')
            AND ${mirrorRetryBranchEligibleSql(Prisma.sql`branch`, Prisma.sql`${candidate.writeBranch}`)}
            AND attempts < ${MAX_ATTEMPTS}
            AND (CASE WHEN state = 'PENDING' THEN last_attempt_at
                      ELSE last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) END) <= ${toNaiveUtc(now)}::timestamp
          ORDER BY (CASE WHEN state = 'PENDING' THEN last_attempt_at
                         ELSE last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) END),
            node_id, kind, remove_loc, branch
          LIMIT ${remainingRows}`;
        const byBranch = new Map<string, DueRow[]>();
        for (const row of rows) {
          remainingRows--; // reserve every selected row once, across all branches, even if it races away
          const group = byBranch.get(row.branch) ?? [];
          group.push(row); byBranch.set(row.branch, group);
        }
        for (const [branch, group] of byBranch) {
          const memoryId = candidate.memoryId;
          const liveOwner = (loc: string) => db.node.findFirst({ where: { memoryId, loc, deletedAt: null }, select: { id: true } });
          await withMirrorCheckout({
            db, memoryId, retry: { now, maxAttempts: MAX_ATTEMPTS, branch }, obligations: group,
            commitSubject: 'Retry recorded mirror files', logPrefix: '[git-mirror-sweep]',
            beforeGit: async refs => {
              // Only decide whether preparation is needed. A row-local first-load outage must reach
              // mutate's per-row refresh/settlement, never escape and charge the whole branch batch.
              for (const ref of refs) if (ref.kind === 'WRITE') {
                try {
                  if (await loadNodeForGit(db, { nodeId: ref.nodeId, memoryId })) return true;
                } catch { return true; }
              }
              for (const ref of refs) if (ref.kind === 'REMOVE') {
                try { if (!await liveOwner(ref.removeLoc ?? '')) return true; }
                catch { return true; } // classify at the row-local mutation boundary
              }
              return false;
            },
            verify: async ({ localPath, memoryUrn, obligations = [] }) => {
              for (const ref of obligations) if (ref.kind === 'REMOVE' && !await liveOwner(ref.removeLoc ?? '')) {
                if (existsSync(nodeFilePath(localPath, ref.removeLoc ?? '', memoryUrn)) ||
                  existsSync(orphanedLegacyPaths(localPath, ref.removeLoc ?? '').readme)) return false;
              }
              return true;
            },
          }, async ({ localPath, memoryUrn, obligations = [] }) => {
            // Refresh after preparation. Refuse each unavailable payload before any path mutation;
            // a row-local failure must not exhaust healthy siblings sharing the checkout.
            const writes: NodeForGit[] = [];
            const failedWrites: string[] = [];
            for (const ref of obligations) if (ref.kind === 'WRITE') {
              try {
                const node = await loadNodeForGit(db, { nodeId: ref.nodeId, memoryId });
                if (node) {
                  if (nodePayloadHasCiphertext(node)) failedWrites.push(node.id);
                  else writes.push(node);
                }
              } catch (err) {
                // #3151: one second-refresh outage must not consume a healthy sibling's attempt.
                failedWrites.push(ref.nodeId);
                console.error('[git-mirror-sweep] Payload refresh failed', mirrorFailureMetadata(err, 'tree', 'TREE_WRITE'));
              }
            }
            const failedRemoves: MirrorObligationRef[] = [];
            const paths = (loc: string) => {
              const file = nodeFilePath(localPath, loc, memoryUrn);
              // Root README must never snapshot/delete its entire checkout as a legacy path.
              if (!loc) return [file];
              const legacy = orphanedLegacyPaths(localPath, loc);
              // #3264: checkpoint only the exact file cleanup may remove, never the sidecar directory
              // (loc `git` made it `.git`, which the checkpoint tried to copy into itself).
              const edges = legacySidecarEdgesFile(legacy.sidecar);
              return edges === null ? [file, legacy.readme] : [file, legacy.readme, edges];
            };
            const failedOperation = (err: unknown) => {
              console.error('[git-mirror-sweep] File mutation failed', mirrorFailureMetadata(err, 'tree', 'TREE_WRITE'));
            };
            const rejected = new Set(failedWrites);
            for (const node of writes) if (!rejected.has(node.id)) {
              try {
                const child = node.loc ? await liveOwner(node.loc + ':README') : null;
                mutateMirrorFiles(localPath, paths(node.loc), () => { writeNodeFile(localPath, node, memoryUrn, child !== null); });
              }
              catch (err) {
                failedOperation(err); failedWrites.push(node.id);
                if (hasIncompleteMirrorMutation(localPath)) return { failedWrites, failedRemoves };
              }
            }
            for (const ref of obligations) if (ref.kind === 'REMOVE') {
              try {
                if (!await liveOwner(ref.removeLoc ?? '')) {
                  mutateMirrorFiles(localPath, paths(ref.removeLoc ?? ''), () => {
                    removeNodeFile(localPath, ref.removeLoc ?? '', ref.nodeId, memoryUrn);
                  });
                }
              } catch (err) {
                failedOperation(err); failedRemoves.push(ref);
                if (hasIncompleteMirrorMutation(localPath)) return { failedWrites, failedRemoves };
              }
            }
            return { failedWrites, failedRemoves };
          });
        }
      }
      if (candidates.length < MAX_MEMORIES) break;
      afterDue = candidates[candidates.length - 1]!.dueAt;
      afterId = candidates[candidates.length - 1]!.memoryId;
    }
    return handled;
  } finally { running = false; }
}

/** First pass is one full interval later; never races startup clone creation. */
export function startGitMirrorObligationSweepLoop(db: PrismaClient, intervalMs = INTERVAL_MS): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_GIT_MIRROR_SWEEP === 'true') return null;
  return setInterval(() => {
    void gitMirrorSweepTick(db).catch(err => console.error('[git-mirror-sweep] Run failed', mirrorFailureMetadata(err, 'sweep', 'SWEEP')));
  }, intervalMs);
}
