/**
 * checkAssetRowObjects — find Asset rows whose bytes are missing from the object
 * store and alarm on them. Issue #1140 slice B; slice A alarms the same condition
 * where the restore path happens to discover it.
 *
 * This is the mirror of `reapOrphanAssetObjects.ts` (#889), which finds the other
 * direction (an object with no row). Nothing else looks at a row and asks whether
 * its object exists: the retention janitor and the purge path only call
 * `deleteObject`, so a row whose bytes were lost sits unnoticed until a user asks
 * for them.
 *
 * It only ever reports. It never deletes or repairs a row, so a bug here costs a
 * false alarm, not data. The rules below keep the alarm honest:
 *
 *  1. *Which rows.* Attached rows (`memoryId` set) that should have bytes: not
 *     soft-deleted, or soft-deleted and still inside the retention window. A
 *     tombstone past the window is the expected "gone" case and the janitor's
 *     business; a BLOCKED row's bytes were deleted on purpose (#896).
 *  2. *Age.* Only rows older than `ORPHAN_MIN_AGE_MS`, the same guard the orphan
 *     reaper uses, so an upload in flight is never an inconsistency.
 *  3. *A store that cannot answer aborts the run.* `headObject` maps only a
 *     genuine not-found to `exists: false`; any other failure throws, and the run
 *     aborts instead of reading an outage as "everything is missing".
 *  4. *Encrypted memories* are checked only while a session key is cached
 *     (the stored key is ciphertext). Otherwise the row is skipped and counted,
 *     never alarmed.
 *  5. *Confirm before alarming.* A miss re-reads the row: if it was deleted, aged
 *     out of the window or blocked while the run was in flight, that is the
 *     janitor or a memory delete doing its job, not an inconsistency.
 *
 * **Bounded runs without stored state.** A run checks at most `batchSize` rows. The
 * eligible ids are sorted, cut into `ceil(count / batchSize)` consecutive windows,
 * and the UTC day picks the window, so every row is checked once per cycle. The
 * position comes from the clock, not from a cursor, so a restart (every deploy)
 * cannot send the sweep back to the start and starve the later rows, and no column
 * or table is needed. When rows are added or removed the windows shift, so a row may
 * wait one extra cycle or be checked twice in one; never more than `batchSize` a run.
 *
 * Run by hand with:
 *   tsx src/jobs/checkAssetRowObjects.ts
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { headObject, isObjectStoreConfigured } from '../integrations/r2/client.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { reportAssetBytesMissing, reportAssetBytesMissingSummary } from '../lib/asset/bytesMissingAlarm.js';
import { ASSET_RETENTION_WINDOW_MS, ORPHAN_MIN_AGE_MS } from '../lib/asset/retention.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';

/** Rows checked per run when `ASSET_ROW_CHECK_BATCH` is unset. */
const DEFAULT_BATCH_SIZE = 2000;

/** Individual alarm events per run before the rest is summarised as one count. */
const DEFAULT_MAX_EVENTS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows loaded per query when resolving a window's ids to rows. */
const LOAD_CHUNK = 500;

export interface AssetRowCheckOutcome {
  /** Rows whose object was looked up. */
  checked: number;
  /** Rows confirmed to have no object. */
  missing: number;
  /** Rows of an encrypted memory with no cached session key; not checked. */
  skippedEncrypted: number;
  /** Misses that did not hold up on re-read (deleted, expired or blocked mid-run). */
  vanished: number;
  /** Missing rows past `maxEvents`, counted in the one summary event. */
  suppressed: number;
  /** Window this run covered, and how many windows make a cycle. */
  slice: number;
  slices: number;
}

/** Thrown when the run cannot safely continue. Never swallowed. */
export class AssetRowCheckAbortedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AssetRowCheckAbortedError';
  }
}

export interface AssetRowCheckOptions {
  db?: PrismaClient;
  now?: Date;
  /** Most rows checked per run. Defaults to `ASSET_ROW_CHECK_BATCH`, then 2000. */
  batchSize?: number;
  /** Individual alarm events per run. Defaults to 50. */
  maxEvents?: number;
}

const intFromEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export async function checkAssetRowObjects(opts: AssetRowCheckOptions = {}): Promise<AssetRowCheckOutcome> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? intFromEnv('ASSET_ROW_CHECK_BATCH', DEFAULT_BATCH_SIZE);
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const ageCutoff = new Date(now.getTime() - ORPHAN_MIN_AGE_MS);
  const windowStart = new Date(now.getTime() - ASSET_RETENTION_WINDOW_MS);

  const eligible = {
    memoryId: { not: null },
    scanStatus: { not: 'BLOCKED' as const },
    uploadedAt: { lte: ageCutoff },
    OR: [{ deletedAt: null }, { deletedAt: { gt: windowStart } }],
  };

  const outcome: AssetRowCheckOutcome = {
    checked: 0, missing: 0, skippedEncrypted: 0, vanished: 0, suppressed: 0, slice: 0, slices: 1,
  };

  let ids: string[];
  try {
    const rows = await db.asset.findMany({ where: eligible, select: { id: true }, orderBy: { id: 'asc' } });
    outcome.slices = Math.max(1, Math.ceil(rows.length / batchSize));
    outcome.slice = Math.floor(now.getTime() / DAY_MS) % outcome.slices;
    ids = rows.map((r) => r.id).slice(outcome.slice * batchSize, (outcome.slice + 1) * batchSize);
  } catch (err) {
    throw new AssetRowCheckAbortedError('asset lookup failed — aborting the row check', err);
  }

  let eventsSent = 0;
  for (let from = 0; from < ids.length; from += LOAD_CHUNK) {
    let rows;
    try {
      rows = await db.asset.findMany({
        where: { id: { in: ids.slice(from, from + LOAD_CHUNK) } },
        select: { id: true, memoryId: true, storageKey: true, memory: { select: { id: true, isEncrypted: true } } },
      });
    } catch (err) {
      throw new AssetRowCheckAbortedError('asset lookup failed — aborting the row check', err);
    }

    for (const row of rows) {
      if (!row.memory) {
        outcome.vanished += 1;
        continue;
      }
      // Decided from the memory's state, not from the key's shape: a locked memory can hold a
      // plaintext-shaped leftover key, which decryptStorageKey would pass through unchanged.
      const sessionKey = row.memory.isEncrypted ? sessionKeyCache.getByMemoryId(row.memory.id) : null;
      if (row.memory.isEncrypted && !sessionKey) {
        outcome.skippedEncrypted += 1;
        continue;
      }
      let plainKey: string;
      try {
        plainKey = decryptStorageKey(row.storageKey, sessionKey);
      } catch {
        outcome.skippedEncrypted += 1;
        continue;
      }

      let exists: boolean;
      try {
        exists = (await headObject(plainKey)).exists;
      } catch (err) {
        throw new AssetRowCheckAbortedError('object store lookup failed — aborting rather than reading an outage as missing bytes', err);
      }
      outcome.checked += 1;
      if (exists) continue;

      // Confirm before alarming: the row may have been purged or aged out since the list.
      let stillOwed: boolean;
      try {
        stillOwed = (await db.asset.count({ where: { id: row.id, ...eligible } })) > 0;
      } catch (err) {
        throw new AssetRowCheckAbortedError('asset lookup failed — aborting the row check', err);
      }
      if (!stillOwed) {
        outcome.vanished += 1;
        continue;
      }

      outcome.missing += 1;
      if (eventsSent >= maxEvents) {
        outcome.suppressed += 1;
        continue;
      }
      if (reportAssetBytesMissing({ assetId: row.id, memoryId: row.memory.id, source: 'sweep' }, now)) eventsSent += 1;
    }
  }

  if (outcome.suppressed > 0) reportAssetBytesMissingSummary({ suppressed: outcome.suppressed, source: 'sweep' });
  return outcome;
}

/**
 * Run the row check on an interval for the server's lifetime. Daily, like the
 * orphan sweep: the window is picked by the UTC day, so the interval must stay a day.
 * No-ops when asset storage is unconfigured, so a deployment without it stays quiet.
 */
export function startAssetRowCheckLoop(
  db?: PrismaClient,
  intervalMs = DAY_MS,
  initialDelayMs = 30 * 60 * 1000,
): NodeJS.Timeout {
  const run = async () => {
    if (!isObjectStoreConfigured()) return;
    try {
      const o = await checkAssetRowObjects({ db });
      if (o.missing > 0 || o.skippedEncrypted > 0 || o.vanished > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[janitor:row-check] window ${o.slice + 1}/${o.slices}: checked ${o.checked}, missing ${o.missing}` +
            ` (${o.suppressed} beyond the event cap), skipped encrypted ${o.skippedEncrypted}, vanished mid-run ${o.vanished}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[janitor:row-check] run failed:', err);
    }
  };

  let timer: NodeJS.Timeout;
  const initial = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), intervalMs);
    void timer;
  }, initialDelayMs);
  return initial;
}

// Allow `tsx src/jobs/checkAssetRowObjects.ts` to run it directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  checkAssetRowObjects()
    .then((outcome) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...outcome, ranAt: new Date().toISOString() }));
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
