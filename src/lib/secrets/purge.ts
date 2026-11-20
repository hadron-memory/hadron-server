/**
 * #4003 (S8 of #3991) — the two retention purges of the App secret store. Both run in the secret sweep loop
 * (`src/jobs/secretSweep.ts`, hourly) under the serve role, in bounded batches, each batch its own transaction.
 *
 * - {@link purgeSupersededVersions} (open question 10, ruled R5, Holger 2026-11-12): a version superseded longer than
 *   `SECRET_VERSION_RETENTION_DAYS` (default 30) is hard-deleted, and the kept-versions cap (R24,
 *   {@link MAX_SECRET_VERSIONS}) purges the oldest superseded versions early in the same pass. The current version
 *   (`superseded_at IS NULL`) is never deleted. Each purged version writes one `PURGE` event (decision 13).
 * - {@link purgeExpiredSecretEvents} (R25): an owner's events are kept while its App exists and for one year after its
 *   deletion, counted from `secret_owner_tombstones`; then they are purged, and the tombstone last. The
 *   `secret_events` guard refuses every other delete, so the predicates here mirror it exactly.
 *
 * Every predicate that selects a row is repeated on the OUTER DELETE (finding
 * `hrn:node:hadronmemory.com:hadron-server:findings:purge-key-subquery-must-recheck-expiry`): a row the candidate
 * subquery picked can change before the delete reaches it (a version made current again cannot happen, but a
 * restored App can), and the delete must then skip it rather than act on a stale choice or trip the guard.
 *
 * Times are the database clock throughout, so the purge and the guard agree. Nothing here reads or logs a value.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { MAX_SECRET_VERSIONS } from './appSecrets.js';
import { secretVersionRetentionDays } from './retention.js';

export interface PurgeBounds {
  /** Rows per batch (one transaction each). Default 500. */
  batchSize?: number;
  /** Batches per call; a backlog beyond them waits for the next pass. Default 20. */
  maxBatches?: number;
}

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_BATCHES = 20;

interface PurgedVersion {
  secret_id: string;
  version_no: number;
  app_id: string;
}

/**
 * Delete superseded versions past the retention window or beyond the kept-versions cap, oldest first, and write one
 * `PURGE` event per deleted version (no actor: the platform did it). Returns how many were deleted and whether a full
 * last batch suggests more remain. Concurrent passes (two instances) skip each other's locked rows.
 */
export async function purgeSupersededVersions(
  db: PrismaClient,
  bounds: PurgeBounds = {},
): Promise<{ purged: number; more: boolean }> {
  const batchSize = bounds.batchSize ?? DEFAULT_BATCH;
  const maxBatches = bounds.maxBatches ?? DEFAULT_MAX_BATCHES;
  const days = secretVersionRetentionDays();
  const cap = MAX_SECRET_VERSIONS;
  let purged = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const n = await db.$transaction(async (tx) => {
      const gone = await tx.$queryRaw<PurgedVersion[]>`
        WITH cand AS (
          SELECT v.id FROM secret_versions v
          WHERE v.superseded_at IS NOT NULL
            AND v.version_no < (SELECT max(m.version_no) FROM secret_versions m WHERE m.secret_id = v.secret_id)
            AND (v.superseded_at <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
                 OR v.version_no <= (SELECT max(m.version_no) FROM secret_versions m WHERE m.secret_id = v.secret_id) - ${cap}::int)
          ORDER BY v.secret_id, v.version_no
          LIMIT ${batchSize}::int
          FOR UPDATE OF v SKIP LOCKED
        )
        DELETE FROM secret_versions v USING cand
        WHERE v.id = cand.id
          AND v.superseded_at IS NOT NULL
          AND v.version_no < (SELECT max(m.version_no) FROM secret_versions m WHERE m.secret_id = v.secret_id)
          AND (v.superseded_at <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
               OR v.version_no <= (SELECT max(m.version_no) FROM secret_versions m WHERE m.secret_id = v.secret_id) - ${cap}::int)
        RETURNING v.secret_id, v.version_no, v.app_id`;
      if (gone.length === 0) return 0;
      const names = new Map(
        (await tx.secret.findMany({ where: { id: { in: [...new Set(gone.map((g) => g.secret_id))] } }, select: { id: true, name: true } }))
          .map((s) => [s.id, s.name]),
      );
      await tx.secretEvent.createMany({
        data: gone.map((g) => ({
          ownerType: 'app', ownerId: g.app_id, secretId: g.secret_id, secretName: names.get(g.secret_id) ?? '',
          versionNo: g.version_no, kind: 'PURGE', outcome: 'OK',
        })),
      });
      return gone.length;
    });
    purged += n;
    if (n < batchSize) return { purged, more: false };
  }
  return { purged, more: true };
}

/**
 * Purge the events of every owner whose tombstone is at least one year old and whose App is not live, then delete
 * each such tombstone that has no events left (the tombstone goes last, so a pass cut short by its bound leaves it
 * for the next one). Returns the counts deleted.
 */
export async function purgeExpiredSecretEvents(
  db: PrismaClient,
  bounds: PurgeBounds = {},
): Promise<{ events: number; tombstones: number }> {
  const batchSize = bounds.batchSize ?? DEFAULT_BATCH;
  const maxBatches = bounds.maxBatches ?? DEFAULT_MAX_BATCHES;
  let events = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const n = await db.$executeRaw`
      DELETE FROM secret_events e
      WHERE e.id IN (
          SELECT c.id FROM secret_events c
          JOIN secret_owner_tombstones t ON t.owner_type = c.owner_type AND t.owner_id = c.owner_id
          WHERE t.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year'
            AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = c.owner_id AND a.deleted_at IS NULL)
          LIMIT ${batchSize}::int)
        AND EXISTS (SELECT 1 FROM secret_owner_tombstones t
                    WHERE t.owner_type = e.owner_type AND t.owner_id = e.owner_id
                      AND t.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year')
        AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = e.owner_id AND a.deleted_at IS NULL)`;
    events += n;
    if (n < batchSize) {
      const tombstones = await db.$executeRaw`
        DELETE FROM secret_owner_tombstones t
        WHERE t.deleted_at <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 year'
          AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = t.owner_id AND a.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM secret_events e WHERE e.owner_type = t.owner_type AND e.owner_id = t.owner_id)`;
      return { events, tombstones };
    }
  }
  return { events, tombstones: 0 };
}
