/**
 * usageActivityRollup — the one-time backfill and the read-only drift check for the usage-activity rollup
 * (#2719 slice 2; prisma/usage-activity-rollup-invariants.sql maintains it from then on).
 *
 * BACKFILL fills every cell BEFORE the state row's `applies_from` from usage_events, then flips `complete`. Each
 * chunk is a whole number of cells and is OVERWRITTEN (delete the span, insert the recount), never added to, so a
 * rerun, a resumed run or a crash between chunks cannot double count. The triggers ignore cells before
 * `applies_from`, so no live write touches the span being rewritten; an event inserted with a past `created_at`
 * while the backfill runs can be missed, which the drift check reports. Deploying the migration without running this
 * is correct: the reader answers those cells from usage_events. RUNNING IT ON PRODUCTION NEEDS ITS OWN GRANT.
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
  options: { chunkCells?: number } = {},
): Promise<BackfillResult> {
  const chunkMs = Math.max(1, Math.trunc(options.chunkCells ?? DEFAULT_CHUNK_CELLS)) * ROLLUP_CELL_MS;
  const [state] = await db.$queryRaw<Array<{ applies_from: Date; complete: boolean }>>`
    SELECT applies_from, complete FROM usage_activity_rollup_state WHERE id = 1`;
  if (!state) throw new Error('usage_activity_rollup_state has no row: the migration did not run');
  if (state.complete) return { alreadyComplete: true, chunks: 0, cellsWritten: 0 };

  // The first cell the triggers maintain: applies_from rounded up to a cell edge (it is aligned unless set by hand).
  const end = Math.ceil(state.applies_from.getTime() / ROLLUP_CELL_MS) * ROLLUP_CELL_MS;
  const [{ first }] = await db.$queryRaw<Array<{ first: Date | null }>>`
    SELECT MIN(created_at) AS first FROM usage_events
    WHERE created_at < ${naive(new Date(end))}::timestamp AND type IN ('read', 'write') AND deleted_at IS NULL`;
  let chunks = 0;
  let cellsWritten = 0;
  if (first) {
    for (let start = floorCell(first.getTime()); start < end; start += chunkMs) {
      const a = naive(new Date(start));
      const b = naive(new Date(Math.min(start + chunkMs, end)));
      const [, inserted] = await db.$transaction([
        db.$executeRaw`DELETE FROM usage_activity_cells WHERE cell >= ${a}::timestamp AND cell < ${b}::timestamp`,
        db.$executeRaw`
          INSERT INTO usage_activity_cells (scope_kind, scope_id, cell, reads, writes)
          SELECT s.k, s.sid, hadron_usage_cell(e.created_at),
                 COUNT(*) FILTER (WHERE e.type = 'read'), COUNT(*) FILTER (WHERE e.type = 'write')
          FROM usage_events e
          CROSS JOIN LATERAL (VALUES ('user', e.user_id), ('memory', e.memory_id)) AS s(k, sid)
          WHERE e.created_at >= ${a}::timestamp AND e.created_at < ${b}::timestamp
            AND e.type IN ('read', 'write') AND e.deleted_at IS NULL AND s.sid IS NOT NULL
          GROUP BY 1, 2, 3`,
      ]);
      chunks++;
      cellsWritten += inserted;
    }
  }
  // Guarded on the boundary the run read: a state row moved under us is not marked complete by a stale run.
  const done = await db.$executeRaw`
    UPDATE usage_activity_rollup_state SET complete = true
    WHERE id = 1 AND NOT complete AND applies_from = ${naive(state.applies_from)}::timestamp`;
  if (done !== 1) throw new Error('usage_activity_rollup_state changed during the backfill; rerun it');
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
