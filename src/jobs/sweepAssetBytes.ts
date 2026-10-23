/**
 * sweepAssetBytes — find Asset rows whose bytes are missing from object
 * storage. Issue #1140 slice B; the mirror of the orphan-object sweep
 * (`reapOrphanAssetObjects.ts`, #889), which finds bytes with no row.
 *
 * A row that claims bytes and a store that has none is server-state
 * inconsistency (a lost bucket, a failed promotion, a bad delete). Today it
 * surfaces only when a user asks for the file. This sweep looks first and
 * raises the `asset.bytes_missing` alarm (`reportAssetBytesMissing`, source
 * `sweep`), which the restore path already shares.
 *
 * It only READS: one HEAD per row, never a write to the store, and the only
 * database write is the cursor stamp.
 *
 * Rules, each from the orphan sweep's posture:
 *  1. *Age.* Only rows older than `ORPHAN_MIN_AGE_MS` — a row younger than
 *     that may still be mid-promotion.
 *  2. *Scope.* Live rows attached to a memory, scan status CLEAN or PENDING.
 *     BLOCKED rows are tombstones whose bytes were deleted on purpose;
 *     soft-deleted rows belong to the retention janitor; staged rows
 *     (memoryId NULL) hold no promoted bytes.
 *  3. *A store that cannot answer aborts the run.* A failed HEAD other than
 *     not-found throws `AssetBytesSweepAbortedError`; it is never read as
 *     "bytes are gone", and the failed row is not stamped.
 *  4. *Encrypted memories need a cached session key.* Without one the key
 *     cannot be located: the row is counted as deferred and stamped so it
 *     rotates behind other work (the scan sweep's posture).
 *
 * The cursor is `Asset.bytesCheckedAt`, least-recently examined first with
 * NULLs first, so it survives a restart and no row can monopolise a batch.
 *
 * Per-run event cap: at most `MAX_EVENTS_PER_RUN` individual alarms; the rest
 * are counted into one summary event.
 *
 * Run by hand with: tsx src/jobs/sweepAssetBytes.ts
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { headObject, isObjectStoreConfigured } from '../integrations/r2/client.js';
import { logAssetEvent } from '../lib/asset/audit.js';
import {
  reportAssetBytesMissing,
  reportAssetBytesMissingSummary,
} from '../lib/asset/bytesMissingAlarm.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { ORPHAN_MIN_AGE_MS } from '../lib/asset/retention.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';

/** Rows examined per run (one HEAD each). */
export const BYTES_SWEEP_BATCH_SIZE = 200;

/** Individual alarms per run; the remainder is counted into one summary event. */
export const MAX_EVENTS_PER_RUN = 20;

export interface AssetBytesSweepOutcome {
  /** Rows taken from the cursor this run. */
  examined: number;
  /** Rows whose object was found. */
  present: number;
  /** Rows whose object is missing. */
  missing: number;
  /** Missing rows that got an individual alarm (the dedupe may swallow a repeat). */
  reported: number;
  /** Encrypted memory with no cached session key; not examined, rotated. */
  deferred: number;
}

/** Thrown when the store cannot answer; the run stops and nothing is concluded. */
export class AssetBytesSweepAbortedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AssetBytesSweepAbortedError';
  }
}

export interface AssetBytesSweepOptions {
  db?: PrismaClient;
  now?: Date;
  batchSize?: number;
}

/** Examine one batch of rows, least-recently examined first. */
export async function sweepAssetBytes(
  opts: AssetBytesSweepOptions = {},
): Promise<AssetBytesSweepOutcome> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? BYTES_SWEEP_BATCH_SIZE;
  const outcome: AssetBytesSweepOutcome = {
    examined: 0,
    present: 0,
    missing: 0,
    reported: 0,
    deferred: 0,
  };

  const rows = await db.asset.findMany({
    where: {
      deletedAt: null,
      memoryId: { not: null },
      scanStatus: { in: ['CLEAN', 'PENDING'] },
      uploadedAt: { lt: new Date(now.getTime() - ORPHAN_MIN_AGE_MS) },
    },
    orderBy: [{ bytesCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: batchSize,
    include: { memory: { select: { id: true, isEncrypted: true } } },
  });

  const stamp = (id: string) =>
    db.asset.updateMany({ where: { id }, data: { bytesCheckedAt: now } });

  for (const asset of rows) {
    outcome.examined += 1;

    const sessionKey = asset.memory?.isEncrypted
      ? sessionKeyCache.getByMemoryId(asset.memory.id)
      : null;
    let plainStorageKey: string;
    try {
      plainStorageKey = decryptStorageKey(asset.storageKey, sessionKey);
    } catch {
      outcome.deferred += 1;
      await stamp(asset.id);
      continue;
    }

    let exists: boolean;
    try {
      exists = (await headObject(plainStorageKey)).exists;
    } catch (err) {
      throw new AssetBytesSweepAbortedError(
        'object store lookup failed — aborting rather than reading an unreachable store as "bytes are gone"',
        err,
      );
    }

    if (exists) {
      outcome.present += 1;
    } else {
      outcome.missing += 1;
      if (outcome.reported < MAX_EVENTS_PER_RUN) {
        if (
          reportAssetBytesMissing(
            { assetId: asset.id, memoryId: asset.memoryId, source: 'sweep' },
            now,
          )
        ) {
          outcome.reported += 1;
        }
      }
      logAssetEvent({
        operation: 'bytes-missing',
        assetId: asset.id,
        memoryId: asset.memoryId,
        reason: 'sweep: row has no object in storage',
      });
    }
    await stamp(asset.id);
  }

  if (outcome.missing > outcome.reported) {
    reportAssetBytesMissingSummary({
      total: outcome.missing,
      unreported: outcome.missing - outcome.reported,
    });
  }
  return outcome;
}

/**
 * Run the sweep on an interval for the server's lifetime. Hourly: each run is
 * a bounded batch, so the whole table is covered over several runs. No-ops
 * when asset storage is unconfigured.
 */
export function startAssetBytesSweepLoop(
  db?: PrismaClient,
  intervalMs = 60 * 60 * 1000,
  initialDelayMs = 20 * 60 * 1000,
): NodeJS.Timeout {
  const run = async () => {
    if (!isObjectStoreConfigured()) return;
    try {
      const outcome = await sweepAssetBytes({ db });
      if (outcome.missing > 0 || outcome.deferred > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[janitor:asset-bytes] examined ${outcome.examined}, missing ${outcome.missing}, ` +
            `deferred ${outcome.deferred}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[janitor:asset-bytes] sweep failed:', err);
    }
  };

  const initial = setTimeout(() => {
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    void timer;
  }, initialDelayMs);
  return initial;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  sweepAssetBytes()
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
