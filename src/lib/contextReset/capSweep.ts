/**
 * #4225 S4b (epic #4229; G4 in coordination:team-on-orca-decisions; hrn:node:hadronmemory.com:specs:cor:agt:050:27 part 12,
 * Proposed) — enforce `Agent.contextCap`.
 *
 * A worker of a LONG-LIVED Agent whose last stored terminal report (S4a, #4238) shows its context over that Agent's cap and
 * its composer proven idle (`status idle` at an empty prompt, from a fresh report) gets ONE `worker.reset-context`, through the
 * same issue step, host protocol and fence as a task's end (`issueReset`: no second reset path). At most one per hour
 * per worker, counted from the last cap reset requested whatever became of it. A busy worker, one with a draft or a menu, a
 * locked or dark one, a short-lived Agent's worker, and an Agent with no cap are never touched: what they report stays on the
 * roster. The host re-checks idleness itself at its claim (NOT_IDLE, DRAFT_OR_MENU, BUSY) and the server refuses at the
 * claim under a pause or when the cap was removed meanwhile (SETTING_OFF), so this decision is the first of several fences.
 *
 * Runs in the matcher's one-minute pass. Each worker is decided in its own transaction, under the same locks, in the same
 * order, as an assignment (anchors, stop fence, task graph, reportsTo graph, THEN the per-worker lock), so a pause, a stop
 * signal or a host registration cannot change between the read and the write.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { lockTaskGraph } from '../agentTasks/blockers.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';
import { lockAppReportsTo } from '../workerReportsTo.js';
import { lockStopFence } from '../stopSignals/state.js';
import { PLATFORM_ACTOR } from '../agentTasks/events.js';
import { OPEN_SESSION_PLACEMENT_JOIN } from '../sessionPlacement.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { issueReset } from './contextReset.js';

/** At most one cap reset per worker in this long. */
export const CAP_RESET_INTERVAL_MS = 60 * 60_000;
/** A report older than this is not proof the composer is idle now. The host's sweep reports every few minutes. */
export const CAP_REPORT_FRESH_MS = 20 * 60_000;
const PAGE = 50;
/** A pass reads at most this many pages (PAGE workers each): a bound, not a window, so no worker is ever starved behind others. */
const MAX_PAGES = 200;

type Cursor = { checkedAt: string; id: string };

type Candidate = { workerId: string; appId: string; contextTokens: number; contextMeasuredAt: Date; cap: number };

/** The workers over their Agent's cap and proven idle, as the last stored report says. Filtered by `workerId` for the re-read. */
async function overCap(
  tx: Prisma.TransactionClient | PrismaClient, now: Date, workerId: string | null, lock: boolean, after: Cursor | null = null,
): Promise<(Candidate & { checkedAt: string })[]> {
  const at = now.toISOString();
  const hourAgo = toNaiveUtc(new Date(now.getTime() - CAP_RESET_INTERVAL_MS));
  const rows = await tx.$queryRaw<{ workerId: string; appId: string; contextTokens: number; contextMeasuredAt: string; cap: number }[]>`
    SELECT w.id AS "workerId", w.app_id AS "appId", (w.terminal->>'contextTokens')::int AS "contextTokens",
           w.terminal->>'contextMeasuredAt' AS "contextMeasuredAt", a.context_cap AS cap, w.terminal->>'checkedAt' AS "checkedAt"
    FROM workers w
    ${OPEN_SESSION_PLACEMENT_JOIN}
    JOIN agents a ON a.id = COALESCE(os.agent_id, w.agent_id)
    WHERE w.retired_at IS NULL
      AND a.context_cap IS NOT NULL AND a.lifecycle = 'LONG_LIVED'
      AND w.terminal IS NOT NULL
      AND w.terminal->>'status' = 'idle' AND w.terminal->>'prompt' = 'empty'
      AND jsonb_typeof(w.terminal->'contextTokens') = 'number'
      AND jsonb_typeof(w.terminal->'contextMeasuredAt') = 'string'
      AND CASE WHEN jsonb_typeof(w.terminal->'contextTokens') = 'number' THEN (w.terminal->>'contextTokens')::int END > a.context_cap
      AND (w.terminal->>'checkedAt')::timestamptz >= ${at}::timestamptz - make_interval(secs => ${CAP_REPORT_FRESH_MS / 1000})
      AND (${workerId}::text IS NULL OR w.id = ${workerId})
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.worker_id = w.id AND s.ended_at IS NULL AND s.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM context_resets r WHERE r.worker_id = w.id
                      AND (r.ended_at IS NULL OR (r.cause = 'context-cap' AND r.requested_at > ${hourAgo}::timestamp)))
      AND (${after?.checkedAt ?? null}::text IS NULL OR (w.terminal->>'checkedAt', w.id) > (${after?.checkedAt ?? null}::text, ${after?.id ?? null}::text))
    ORDER BY w.terminal->>'checkedAt', w.id
    LIMIT ${PAGE}
    ${lock ? Prisma.sql`FOR SHARE OF a` : Prisma.empty}`;
  return rows.map((r) => ({ ...r, contextMeasuredAt: new Date(r.contextMeasuredAt) }));
}

/** Decide one worker under its locks; returns whether a reset was issued. */
async function decide(db: PrismaClient, c: Candidate, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: c.appId }], 'shared');
    const app = await tx.app.findUnique({ where: { id: c.appId }, select: { deletedAt: true, uninstalledAt: true, teamPausedAt: true } });
    // R120 (part 2, which part 12 keeps): a team pause suppresses it; nothing touches a paused worker's terminal.
    if (!app || app.deletedAt || app.uninstalledAt || app.teamPausedAt) return false;
    await lockStopFence(tx, c.appId, 'shared');
    await lockTaskGraph(tx, c.appId, 'shared');
    await lockAppReportsTo(tx, c.appId, 'shared');
    await lockWorkersForAssignment(tx, [c.workerId]);
    // Decided again under the lock, from the rows as they are now.
    const [again] = await overCap(tx, now, c.workerId, true);
    if (!again) return false;
    // None live, and none asked for in the last hour whatever became of it (a refused or failed one counts).
    const [recent] = await tx.$queryRaw<{ live: boolean; capRecent: boolean; last: Date | null }[]>`
      SELECT bool_or(ended_at IS NULL) AS live,
             COALESCE(bool_or(cause = 'context-cap' AND requested_at > ${toNaiveUtc(new Date(now.getTime() - CAP_RESET_INTERVAL_MS))}::timestamp), false) AS "capRecent",
             max(requested_at) AS last
      FROM context_resets WHERE worker_id = ${c.workerId}`;
    if (recent?.live || recent?.capRecent) return false;
    // A measurement taken before the last reset was asked for describes the context that reset replaced.
    if (recent?.last && again.contextMeasuredAt.getTime() <= recent.last.getTime()) return false;
    const out = await issueReset(tx, {
      appId: c.appId, workerId: c.workerId, taskId: null, cause: 'context-cap', actor: PLATFORM_ACTOR, now,
      unsupportedIsFailure: false, extra: { contextTokens: again.contextTokens, contextCap: again.cap },
    });
    return out !== null;
  });
}

/** One pass: returns how many resets it issued. A failure for one worker never stops the others. */
export async function contextCapTick(db: PrismaClient, now: Date = new Date()): Promise<number> {
  let issued = 0;
  let after: Cursor | null = null;
  // Page through EVERY candidate by (checkedAt, id): a worker that cannot be reset (no capable host, say) is passed over, and
  // never keeps the ones behind it out of the pass (Diego, P2 at cc136d0af).
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const due = await overCap(db, now, null, false, after);
    for (const c of due) {
      try {
        if (await decide(db, c, now)) issued += 1;
      } catch (err) {
        console.error('[context-cap] deciding a reset failed:', c.workerId, err);
      }
    }
    if (due.length < PAGE) break;
    const last = due[due.length - 1]!;
    after = { checkedAt: last.checkedAt, id: last.workerId };
  }
  return issued;
}
