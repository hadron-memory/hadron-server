/** #430: retry only recorded failures. No write intent, cloning, startup pass, or second Git transport. */
import type { PrismaClient } from '../generated/prisma/index.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { memoryLocalPath, withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { writeNodeToGit, removeNodeFile } from '../integrations/github/writeNodeToGit.js';
import { loadNodeForGit } from '../integrations/github/nodeWrittenSubscriber.js';
import { nodeFilePath, orphanedLegacyPaths } from '../integrations/github/nodeFrontmatter.js';
import { validateMemorySource } from '../lib/gitSource.js';
import { gitMirrorSweepRowBudget } from './gitMirrorSweepBudget.js';

export const MAX_ATTEMPTS = 10;
const INTERVAL_MS = 10 * 60_000;
const MAX_MEMORIES = 20;
let running = false;
type DueMemory = { memoryId: string; source: string; memoryUrn: string; orgUrn: string; writeBranch: string | null; dueAt: Date };
type DueRow = { nodeId: string; kind: 'WRITE' | 'REMOVE'; removeLoc: string };

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
          AND NOT m.is_encrypted AND m.source IS NOT NULL AND m.organization_id IS NOT NULL AND m.deleted_at IS NULL
          AND o.last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(o.attempts - 1, 7)), 72) <= ${now}
        GROUP BY m.id, m.source, m.urn, org.urn, m.write_branch
        ) SELECT * FROM due
        WHERE (${afterDue}::timestamp IS NULL OR ("dueAt", "memoryId") > (${afterDue}::timestamp, ${afterId}::text))
        ORDER BY "dueAt", "memoryId" LIMIT ${MAX_MEMORIES}`;
      for (const candidate of candidates) {
        try { validateMemorySource(candidate.source); } catch { continue; }
        // #3042: the recorded debt lacks the client/branch identity; never publish it to the fallback unknown branch.
        if (candidate.writeBranch?.includes('{client}')) continue;
        if (!existsSync(join(memoryLocalPath(candidate.orgUrn, candidate.memoryUrn), '.git'))) continue;
        if (handled >= MAX_MEMORIES || remainingRows === 0) break;
        handled++;
        // Bound the DB result, not just its consumer. Only due rows reserve budget slots; the existing lock-time
        // re-read still decides whether a selected row needs an attempt after a competing writer has run.
        const rows = await db.$queryRaw<DueRow[]>`
          SELECT node_id AS "nodeId", kind, remove_loc AS "removeLoc"
          FROM git_mirror_obligations
          WHERE memory_id = ${candidate.memoryId} AND state IN ('FAILED', 'NOT_CLONED')
            AND attempts < ${MAX_ATTEMPTS}
            AND last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72) <= ${now}
          ORDER BY last_attempt_at + interval '5 minutes' * LEAST(power(2, LEAST(attempts - 1, 7)), 72),
            node_id, kind, remove_loc
          LIMIT ${remainingRows}`;
        for (const row of rows) {
          // Reserve before entering Git. A raced-away/ineligible row can leave a slot unused, never widen the bound.
          remainingRows--;
          const memoryId = candidate.memoryId;
          const retry = { now, maxAttempts: MAX_ATTEMPTS };
          if (row.kind === 'WRITE') {
            // Both loads happen under the checkout lock. The first avoids any Git for missing/tombstoned nodes; the
            // renderer refreshes again after branch preparation, so it never publishes a pre-wait content snapshot.
            const refresh = () => loadNodeForGit(db, { nodeId: row.nodeId, memoryId });
            await writeNodeToGit({ id: row.nodeId }, '', null, memoryId, refresh, {
              db, retry, beforeGit: async () => !!await refresh(),
            });
          } else {
            const liveOwner = () => db.node.findFirst({ where: { memoryId, loc: row.removeLoc, deletedAt: null }, select: { id: true } });
            await withMirrorCheckout({
              db, memoryId, retry, obligations: [{ nodeId: row.nodeId, kind: 'REMOVE', removeLoc: row.removeLoc }],
              commitSubject: `Retry removal of ${row.removeLoc}`, logPrefix: '[git-mirror-sweep]',
              beforeGit: async () => !await liveOwner(),
              verify: ({ localPath, memoryUrn }) => !existsSync(nodeFilePath(localPath, row.removeLoc, memoryUrn)) &&
                !existsSync(orphanedLegacyPaths(localPath, row.removeLoc).readme),
            }, async ({ localPath, memoryUrn }) => {
              // A loc may have been reclaimed while fetch/branch setup waited. Never delete its live owner's file.
              if (await liveOwner()) return false;
              removeNodeFile(localPath, row.removeLoc, row.nodeId, memoryUrn);
            });
          }
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
    void gitMirrorSweepTick(db).catch(() => console.error('[git-mirror-sweep] Run failed'));
  }, intervalMs);
}
