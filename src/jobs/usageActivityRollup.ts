/**
 * usageActivityRollup — the one-time backfill and the read-only drift check for the usage-activity rollup
 * (#2719 slice 2; prisma/usage-activity-rollup-invariants.sql maintains it from then on).
 *
 * The triggers maintain EVERY cell from the moment the migration runs, so the backfill only has to make the cells
 * before the state row's `applies_from` agree with usage_events once, then flip `complete` (which lets the reader use
 * them).
 *
 * CORRECTION (#4320) of the migration's preamble, which says "the triggers maintain cells from the next 15-minute
 * boundary on" (prisma/migrations/20261117300000_usage_activity_rollup/migration.sql, written before d20dc14e): the
 * triggers maintain every cell from the moment they exist, and the boundary only tells the READER where to trust the
 * cells. An applied migration is never edited, so this header is where a reader of the rollup lands on that.
 *
 * Each chunk is a whole number of cells and is OVERWRITTEN (delete the span, insert the recount), never added
 * to, so a rerun, a resumed run or a crash between chunks cannot double count. A chunk runs in one transaction that
 * first takes SHARE ROW EXCLUSIVE on usage_events (writers wait for it; reads do not), so the recount is a consistent
 * snapshot, nothing else touches the span while it is rewritten, and two backfills running together take their chunks
 * one after the other. A change to an already rebuilt span after its chunk committed is netted by the triggers like
 * any write, including a backdated insert, a delete, a soft delete or a user merge. Each chunk re-reads the state row
 * under lock and stops if the backfill is complete or the boundary moved. Deploying the migration without running this
 * is correct: the reader answers those cells from usage_events. RUNNING IT ON PRODUCTION NEEDS ITS OWN GRANT, and it
 * briefly holds off event writes once per chunk (one day of cells by default).
 *
 * DRIFT CHECK compares the rollup with a recount from usage_events over closed cells and reports every mismatch. It
 * never repairs: a reader of a drifted cell sees the rollup value, so this check is the control.
 *
 * Run by hand (no loop, off by default):
 *   tsx src/jobs/usageActivityRollup.ts backfill
 *   tsx src/jobs/usageActivityRollup.ts drift
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { ROLLUP_CELL_MS } from '../lib/usageActivity.js';

const naive = (d: Date): string => d.toISOString().replace('Z', '');
const floorCell = (ms: number): number => Math.floor(ms / ROLLUP_CELL_MS) * ROLLUP_CELL_MS;

/** Default chunk: one day of cells (96). Always a whole number of cells. */
const DEFAULT_CHUNK_CELLS = 96;

export interface BackfillResult {
  /** True when the state row was already complete, so nothing ran. */
  alreadyComplete: boolean;
  chunks: number;
  /** Cell rows written (scope rows, not events). */
  cellsWritten: number;
}

/** Fill every cell before `applies_from` and mark the rollup complete. See the file header for the guarantees. */
export async function backfillUsageActivityRollup(
  db: PrismaClient,
  options: { chunkCells?: number; /** Test hook: runs after each committed chunk. */ afterChunk?: (index: number) => Promise<void> } = {},
): Promise<BackfillResult> {
  const chunkMs = Math.max(1, Math.trunc(options.chunkCells ?? DEFAULT_CHUNK_CELLS)) * ROLLUP_CELL_MS;
  const [state] = await db.$queryRaw<Array<{ applies_from: Date; complete: boolean }>>`
    SELECT applies_from, complete FROM usage_activity_rollup_state WHERE id = 1`;
  if (!state) throw new Error('usage_activity_rollup_state has no row: the migration did not run');
  if (state.complete) return { alreadyComplete: true, chunks: 0, cellsWritten: 0 };
  const boundary = naive(state.applies_from);

  // The first cell the reader will trust: applies_from rounded up to a cell edge (it is aligned unless set by hand).
  const end = Math.ceil(state.applies_from.getTime() / ROLLUP_CELL_MS) * ROLLUP_CELL_MS;
  // The lowest cell that can need rewriting: the oldest live event, or an older stale cell (a trigger netted a delete of
  // an event the rollup never counted, so the cell holds a negative count).
  const [{ first }] = await db.$queryRaw<Array<{ first: Date | null }>>`
    SELECT LEAST(
      (SELECT MIN(created_at) FROM usage_events
        WHERE created_at < ${naive(new Date(end))}::timestamp AND type IN ('read', 'write') AND deleted_at IS NULL),
      (SELECT MIN(cell) FROM usage_activity_cells WHERE cell < ${naive(new Date(end))}::timestamp)) AS first`;
  let chunks = 0;
  let cellsWritten = 0;
  if (first) {
    for (let start = floorCell(first.getTime()); start < end; start += chunkMs) {
      const a = naive(new Date(start));
      const b = naive(new Date(Math.min(start + chunkMs, end)));
      const inserted = await db.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE usage_events IN SHARE ROW EXCLUSIVE MODE`;
        const [now] = await tx.$queryRaw<Array<{ complete: boolean; same: boolean }>>`
          SELECT complete, applies_from = ${boundary}::timestamp AS same FROM usage_activity_rollup_state WHERE id = 1 FOR UPDATE`;
        if (!now || now.complete || !now.same) return null;
        await tx.$executeRaw`DELETE FROM usage_activity_cells WHERE cell >= ${a}::timestamp AND cell < ${b}::timestamp`;
        return tx.$executeRaw`
          INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes)
          SELECT s.k, s.sid, hadron_usage_cell(e.created_at),
                 COUNT(*) FILTER (WHERE e.type = 'read'), COUNT(*) FILTER (WHERE e.type = 'write')
          FROM usage_events e
          CROSS JOIN LATERAL (VALUES ('user', e.user_id), ('memory', e.memory_id)) AS s(k, sid)
          WHERE e.created_at >= ${a}::timestamp AND e.created_at < ${b}::timestamp
            AND e.type IN ('read', 'write') AND e.deleted_at IS NULL AND s.sid IS NOT NULL
          GROUP BY 1, 2, 3`;
      }, { timeout: 600_000, maxWait: 600_000 });
      if (inserted === null) break; // another run completed it, or the boundary moved: the guarded flip below decides
      chunks++;
      cellsWritten += inserted;
      if (options.afterChunk) await options.afterChunk(chunks);
    }
  }
  // Guarded on the boundary the run read: a state row moved under us is not marked complete by a stale run.
  const done = await db.$executeRaw`
    UPDATE usage_activity_rollup_state SET complete = true
    WHERE id = 1 AND NOT complete AND applies_from = ${boundary}::timestamp`;
  if (done !== 1) {
    const [after] = await db.$queryRaw<Array<{ complete: boolean; same: boolean }>>`
      SELECT complete, applies_from = ${boundary}::timestamp AS same FROM usage_activity_rollup_state WHERE id = 1`;
    if (after?.complete && after.same) return { alreadyComplete: true, chunks, cellsWritten }; // a concurrent run finished it
    throw new Error('usage_activity_rollup_state changed during the backfill; rerun it');
  }
  return { alreadyComplete: false, chunks, cellsWritten };
}

export interface DriftRow {
  scopeKind: string;
  scopeId: string;
  cell: string;
  rollup: { reads: number; writes: number };
  recount: { reads: number; writes: number };
}

/**
 * Cells whose rollup counts differ from a recount of usage_events, over `[from, to)` (whole cells). Defaults to every
 * maintained cell older than `closedAfterMs` (1 hour, so cells still receiving writes are left out). A missing cell
 * counts as zero on its side. Read only; at most `limit` rows (default 100) come back, `total` is the full count.
 */
export async function findUsageActivityRollupDrift(
  db: Pick<PrismaClient, '$queryRaw'>,
  options: { from?: Date; to?: Date; limit?: number; now?: Date; closedAfterMs?: number } = {},
): Promise<{ total: number; rows: DriftRow[] }> {
  const [state] = await db.$queryRaw<Array<{ applies_from: Date; complete: boolean }>>`
    SELECT applies_from, complete FROM usage_activity_rollup_state WHERE id = 1`;
  if (!state) return { total: 0, rows: [] };
  const now = options.now ?? new Date();
  const to = new Date(floorCell(options.to?.getTime() ?? now.getTime() - (options.closedAfterMs ?? 3_600_000)));
  const lowest = state.complete ? 0 : Math.ceil(state.applies_from.getTime() / ROLLUP_CELL_MS) * ROLLUP_CELL_MS;
  const from = new Date(Math.max(floorCell(options.from?.getTime() ?? 0), lowest));
  const limit = Math.max(1, Math.trunc(options.limit ?? 100));
  const found = await db.$queryRaw<Array<{
    k: string; sid: string; cell: Date; rr: bigint; rw: bigint; cr: bigint; cw: bigint; total: bigint;
  }>>`
    WITH recount AS (
      SELECT s.k, s.sid, hadron_usage_cell(e.created_at) AS cell,
             COUNT(*) FILTER (WHERE e.type = 'read') AS reads, COUNT(*) FILTER (WHERE e.type = 'write') AS writes
      FROM usage_events e
      CROSS JOIN LATERAL (VALUES ('user', e.user_id), ('memory', e.memory_id)) AS s(k, sid)
      WHERE e.created_at >= ${naive(from)}::timestamp AND e.created_at < ${naive(to)}::timestamp
        AND e.type IN ('read', 'write') AND e.deleted_at IS NULL AND s.sid IS NOT NULL
      GROUP BY 1, 2, 3
    ), stored AS (
      SELECT scope_kind AS k, scope_id AS sid, cell, reads, writes FROM usage_activity_cells
      WHERE cell >= ${naive(from)}::timestamp AND cell < ${naive(to)}::timestamp
    ), diff AS (
      SELECT COALESCE(r.k, c.k) AS k, COALESCE(r.sid, c.sid) AS sid, COALESCE(r.cell, c.cell) AS cell,
             COALESCE(r.reads, 0) AS rr, COALESCE(r.writes, 0) AS rw, COALESCE(c.reads, 0) AS cr, COALESCE(c.writes, 0) AS cw
      FROM recount r FULL JOIN stored c ON c.k = r.k AND c.sid = r.sid AND c.cell = r.cell
    )
    SELECT k, sid, cell, rr, rw, cr, cw, COUNT(*) OVER () AS total FROM diff
    WHERE rr <> cr OR rw <> cw ORDER BY k, sid, cell LIMIT ${limit}`;
  return {
    total: found.length ? Number(found[0].total) : 0,
    rows: found.map((r) => ({
      scopeKind: r.k, scopeId: r.sid, cell: naive(r.cell),
      rollup: { reads: Number(r.cr), writes: Number(r.cw) }, recount: { reads: Number(r.rr), writes: Number(r.rw) },
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import('../integrations/db/client.js');
  const command = process.argv[2];
  if (command === 'backfill') console.log(JSON.stringify(await backfillUsageActivityRollup(db)));
  else if (command === 'drift') console.log(JSON.stringify(await findUsageActivityRollupDrift(db)));
  else console.error('usage: tsx src/jobs/usageActivityRollup.ts backfill|drift');
  await db.$disconnect();
}
