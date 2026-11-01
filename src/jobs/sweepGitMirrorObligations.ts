/** #430: retry only recorded failures. No write intent, cloning, startup pass, or second Git transport. */
import type { PrismaClient } from '../generated/prisma/index.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { memoryLocalPath, withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { writeNodeFile, removeNodeFile, nodePayloadHasCiphertext, type NodeForGit } from '../integrations/github/writeNodeToGit.js';
import { loadNodeForGit } from '../integrations/github/nodeWrittenSubscriber.js';
import { nodeFilePath, orphanedLegacyPaths } from '../integrations/github/nodeFrontmatter.js';
import { validateMemorySource } from '../lib/gitSource.js';
import { mirrorFailureMetadata } from '../integrations/github/mirrorFailureMetadata.js';
import { type MirrorObligationRef } from '../integrations/github/mirrorObligations.js';
import { gitMirrorSweepRowBudget } from './gitMirrorSweepBudget.js';

export const MAX_ATTEMPTS = 10;
const INTERVAL_MS = 10 * 60_000;
const MAX_MEMORIES = 20;
let running = false;
type DueMemory = { memoryId: string; source: string; memoryUrn: string; orgUrn: string; writeBranch: string | null; dueAt: Date };
type DueRow = { nodeId: string; kind: 'WRITE' | 'REMOVE'; removeLoc: string; branch: string };

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
      const candidates: DueMemory[] = await db.$queryRaw<DueMemory[]>`
        WITH due AS (
        SELECT m.id AS "memoryId", m.source, m.urn AS "memoryUrn", org.urn AS "orgUrn", m.write_branch AS "writeBranch",
          MIN(o.last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(o.attempts - 1, 7)), 72)) AS "dueAt"
        FROM git_mirror_obligations o JOIN memories m ON m.id = o.memory_id JOIN organizations org ON org.id = m.organization_id
        WHERE o.state IN ('FAILED', 'NOT_CLONED') AND o.attempts < ${MAX_ATTEMPTS}
          AND (m.write_branch IS NULL OR m.write_branch NOT LIKE '%{client}%' OR o.branch <> '')
          AND NOT m.is_encrypted AND m.source IS NOT NULL AND m.organization_id IS NOT NULL AND m.deleted_at IS NULL
          AND o.last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(o.attempts - 1, 7)), 72) <= ${now}
        GROUP BY m.id, m.source, m.urn, org.urn, m.write_branch
        ) SELECT * FROM due
        WHERE (${afterDue}::timestamp IS NULL OR ("dueAt", "memoryId") > (${afterDue}::timestamp, ${afterId}::text))
        ORDER BY "dueAt", "memoryId" LIMIT ${MAX_MEMORIES}`;
      for (const candidate of candidates) {
        try { validateMemorySource(candidate.source); } catch { continue; }
        if (!existsSync(join(memoryLocalPath(candidate.orgUrn, candidate.memoryUrn), '.git'))) continue;
        if (handled >= MAX_MEMORIES || remainingRows === 0) break;
        handled++;
        // Bound the DB result, not just its consumer. Only due rows reserve budget slots; the existing lock-time
        // re-read still decides whether a selected row needs an attempt after a competing writer has run.
        const rows = await db.$queryRaw<DueRow[]>`
          SELECT node_id AS "nodeId", kind, remove_loc AS "removeLoc", branch
          FROM git_mirror_obligations
          WHERE memory_id = ${candidate.memoryId} AND state IN ('FAILED', 'NOT_CLONED')
            AND (${candidate.writeBranch?.includes('{client}') ?? false} = false OR branch <> '')
            AND attempts < ${MAX_ATTEMPTS}
            AND last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) <= ${now}
          ORDER BY last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72),
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
          const loadWrites = async (refs: readonly MirrorObligationRef[]) => {
            const writes: NodeForGit[] = [];
            for (const ref of refs) if (ref.kind === 'WRITE') {
              const node = await loadNodeForGit(db, { nodeId: ref.nodeId, memoryId });
              if (node) writes.push(node);
            }
            return writes;
          };
          await withMirrorCheckout({
            db, memoryId, retry: { now, maxAttempts: MAX_ATTEMPTS, branch }, obligations: group,
            commitSubject: 'Retry recorded mirror files', logPrefix: '[git-mirror-sweep]',
            beforeGit: async refs => {
              if ((await loadWrites(refs)).length) return true;
              for (const ref of refs) if (ref.kind === 'REMOVE' && !await liveOwner(ref.removeLoc ?? '')) return true;
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
            // Refresh after remote preparation, and preflight the whole batch before any path mutation.
            const writes = await loadWrites(obligations);
            if (writes.some(nodePayloadHasCiphertext)) throw new Error('Mirror payload unavailable');
            for (const node of writes) writeNodeFile(localPath, node, memoryUrn);
            for (const ref of obligations) if (ref.kind === 'REMOVE' && !await liveOwner(ref.removeLoc ?? '')) {
              removeNodeFile(localPath, ref.removeLoc ?? '', ref.nodeId, memoryUrn);
            }
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
