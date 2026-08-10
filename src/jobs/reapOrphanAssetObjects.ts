/**
 * reapOrphanAssetObjects — delete object-store objects that no `Asset`
 * row references. Issue #889; the ListObjectsV2 sweep the asset janitor
 * had carried on its TODO since spec 004 v1.
 *
 * **Why this exists.** Every other asset leak is a special case; this is
 * the catch-all. An object outlives its row through at least five routes:
 * a hard-deleted memory (`Asset.memoryId` is `onDelete: Cascade`, and
 * `src/lib/asset/purge.ts` only covers the call sites that know to
 * collect keys first); an encrypted memory, whose `storageKey` a deletion
 * path usually cannot decrypt; an abandoned upload, whose bytes were PUT
 * but never completed; a failed best-effort compensation in
 * `hadron_store_file`; and, once staging becomes reachable, staged assets.
 * All of them look identical from the bucket: an object with no row.
 *
 * **Encryption is not in the way.** `Asset.storageKey` is encrypted at
 * rest for encrypted memories, so bucket keys cannot be matched against
 * that column — but they do not need to be. Encryption covers the DB
 * column, not the path the bytes live at: the object's key is plaintext
 * and its basename IS the asset id (`buildStorageKey`). So the sweep
 * parses the id out of the key and checks for that primary key, which
 * works uniformly for encrypted and unencrypted memories and never
 * decrypts anything.
 *
 * **This is the one janitor that deletes on ABSENCE of evidence** rather
 * than on a tombstone, so a bug here destroys live files instead of
 * leaking dead ones. Four rules follow from that, and none of them are
 * negotiable:
 *
 *  1. *Age.* An upload in flight is an object with no row by definition —
 *     `beginAssetUpload` presigns, the client PUTs, and the row is
 *     written afterwards. Only objects older than `ORPHAN_MIN_AGE_MS`
 *     (a large multiple of the presign TTL) are candidates, and an object
 *     whose age the store did not report is never a candidate.
 *  2. *Shape, and then the database — for every key without exception.*
 *     A key that is not one we write is skipped loudly, never deleted
 *     (`parseObjectIdFromKey` returns null rather than guessing). No
 *     prefix is ever taken as licence to delete unasked: `staging` is a
 *     mintable root name, so a principal called `staging` owns final
 *     keys indistinguishable from staging keys. A genuine staging object
 *     is still reaped — its basename is an upload id, which matches no
 *     Asset row.
 *  3. *A database that cannot answer aborts the sweep.* A failed query
 *     must never read as "no rows exist, delete everything" — so the
 *     lookup throws out of the whole run instead of being caught per
 *     page.
 *  4. *Dry run by default.* Deletion is opt-in via
 *     `ASSET_ORPHAN_REAP_ENABLED=true`; until then the sweep reports what
 *     it would delete and touches nothing.
 *
 * Anything with a row is somebody else's job, whatever state it is in: a
 * soft-deleted asset belongs to the 24h retention sweep in
 * `janitorAssets.ts`, and a #896 BLOCKED tombstone whose bytes survived a
 * failed delete belongs to the scan sweep's purge retry. Only a MISSING
 * row is an orphan.
 *
 * Run by hand with:
 *   tsx src/jobs/reapOrphanAssetObjects.ts            # dry run
 *   tsx src/jobs/reapOrphanAssetObjects.ts --apply    # actually delete
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import {
  deleteObject,
  isObjectStoreConfigured,
  listObjectsPage,
} from '../integrations/r2/client.js';
import { logAssetEvent } from '../lib/asset/audit.js';
import { ORPHAN_MIN_AGE_MS } from '../lib/asset/retention.js';
import { isStagingKey, parseObjectIdFromKey } from '../lib/asset/storageKey.js';

/** Objects requested per ListObjectsV2 call (the S3 maximum). */
const PAGE_SIZE = 1000;

/**
 * Hard stop on paging. A well-behaved store terminates on its own; this
 * only bounds the damage if a continuation token ever fails to advance.
 */
const MAX_PAGES = 10_000;

/** How many orphan keys the outcome carries back for the operator's log. */
const SAMPLE_LIMIT = 20;

/**
 * Cap on per-key "skipped, not ours" log lines per run. A bucket holding
 * foreign objects would otherwise emit one line per object every day
 * forever; the outcome's `unrecognized` count still reports all of them.
 */
const SKIP_LOG_LIMIT = 50;

export interface OrphanSweepOutcome {
  /** Objects the listing returned, across every page. */
  listed: number;
  /** Recognized, old-enough objects with no Asset row. */
  orphans: number;
  /** Bytes those orphans occupy. */
  orphanBytes: number;
  /** Orphans actually deleted — always 0 in a dry run. */
  reaped: number;
  /** Objects too young to judge, or whose age the store did not report. */
  tooYoung: number;
  /** Objects whose key is not a shape this platform writes. Never deleted. */
  unrecognized: number;
  /** Delete failures. The sweep continues past them. */
  errors: number;
  /** True when nothing was deleted (the default). */
  dryRun: boolean;
  /** Up to SAMPLE_LIMIT orphan keys, for the log line. */
  sample: string[];
}

/** Thrown when the sweep cannot safely continue. Never swallowed. */
export class OrphanSweepAbortedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OrphanSweepAbortedError';
  }
}

export interface OrphanSweepOptions {
  db?: PrismaClient;
  now?: Date;
  /**
   * Delete for real. Defaults to `ASSET_ORPHAN_REAP_ENABLED === 'true'`,
   * i.e. dry-run unless an operator has opted in.
   */
  apply?: boolean;
  /**
   * Restrict the listing to this key prefix. Defaults to
   * `ASSET_ORPHAN_SWEEP_PREFIX` (unset ⇒ the whole bucket). Mandatory if
   * the bucket is ever shared with another consumer — the sweep deletes
   * anything old and unmatched inside its scope.
   */
  prefix?: string;
  pageSize?: number;
}

/** A page object that survived the age and shape filters. */
interface Candidate {
  key: string;
  size: number;
  /**
   * Id parsed from the key's basename — an Asset PK for a final key, an
   * upload id for a staging one. Looked up either way; only a real row
   * spares the object.
   */
  objectId: string;
}

/**
 * Sweep the bucket for objects with no Asset row and (when applying)
 * delete them. Idempotent and safe to re-run.
 */
export async function reapOrphanAssetObjects(
  opts: OrphanSweepOptions = {},
): Promise<OrphanSweepOutcome> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  const apply = opts.apply ?? process.env.ASSET_ORPHAN_REAP_ENABLED === 'true';
  const prefix = opts.prefix ?? process.env.ASSET_ORPHAN_SWEEP_PREFIX ?? '';
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const ageCutoff = now.getTime() - ORPHAN_MIN_AGE_MS;

  const outcome: OrphanSweepOutcome = {
    listed: 0,
    orphans: 0,
    orphanBytes: 0,
    reaped: 0,
    tooYoung: 0,
    unrecognized: 0,
    errors: 0,
    dryRun: !apply,
    sample: [],
  };

  let skipsLogged = 0;
  const logSkipped = (key: string, reason: string): void => {
    if (skipsLogged >= SKIP_LOG_LIMIT) return;
    skipsLogged += 1;
    logAssetEvent({ operation: 'orphan-skipped', key, reason });
  };

  let token: string | null = null;
  let pages = 0;
  do {
    const page = await listObjectsPage({
      prefix,
      continuationToken: token,
      maxKeys: pageSize,
    });
    token = page.nextToken;
    pages += 1;

    const candidates: Candidate[] = [];
    for (const obj of page.objects) {
      outcome.listed += 1;

      // Unknown age is treated exactly like "too young": the object may
      // be an upload in flight and we cannot prove otherwise.
      if (!obj.lastModified || obj.lastModified.getTime() > ageCutoff) {
        outcome.tooYoung += 1;
        continue;
      }

      // Every key is treated the same way: parse the id out of its
      // basename and let the database decide. The `staging/` prefix is
      // NOT a licence to delete without asking — `staging` is a mintable
      // root name, so a principal called `staging` has final keys that
      // look exactly like staging keys, and trusting the prefix would
      // delete every asset they own (PR #907 review, Codex P1). A real
      // staging object is still reaped: its basename is an UPLOAD id,
      // which by construction matches no Asset row.
      const objectId = parseObjectIdFromKey(obj.key);
      if (!objectId) {
        outcome.unrecognized += 1;
        logSkipped(obj.key, 'key is not a shape this platform writes');
        continue;
      }
      candidates.push({ key: obj.key, size: obj.size, objectId });
    }

    const present = await loadPresentAssetIds(
      db,
      candidates.map((c) => c.objectId),
    );

    for (const candidate of candidates) {
      // Any row at all — including a soft-deleted one (the retention
      // sweep owns those) and a #896 BLOCKED tombstone (the scan sweep
      // owns its purge retry) — means this is not an orphan.
      if (present.has(candidate.objectId)) continue;

      const staging = isStagingKey(candidate.key);
      outcome.orphans += 1;
      outcome.orphanBytes += candidate.size;
      if (outcome.sample.length < SAMPLE_LIMIT) outcome.sample.push(candidate.key);

      // The id is only reported as an assetId for a final key; on a
      // staging key it is an upload id and would be a lie in the audit
      // trail.
      const identity = staging
        ? { reason: 'abandoned staging object' }
        : { assetId: candidate.objectId };

      if (!apply) {
        logAssetEvent({
          operation: 'orphan-reaped',
          ...identity,
          key: candidate.key,
          bytes: candidate.size,
          dryRun: true,
        });
        continue;
      }

      try {
        await deleteObject(candidate.key);
        outcome.reaped += 1;
        logAssetEvent({
          operation: 'orphan-reaped',
          ...identity,
          key: candidate.key,
          bytes: candidate.size,
          dryRun: false,
        });
      } catch (err) {
        outcome.errors += 1;
        logAssetEvent({
          operation: 'orphan-reaped',
          ...identity,
          key: candidate.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (token && pages >= MAX_PAGES) {
      logAssetEvent({
        operation: 'orphan-skipped',
        count: outcome.listed,
        error: `listing stopped after ${MAX_PAGES} pages — bucket not fully swept`,
      });
      break;
    }
  } while (token);

  return outcome;
}

/**
 * Which of these asset ids exist, as one batched query.
 *
 * Existence of the ROW is the whole test — the object's key is never
 * compared against `Asset.storageKey`. That column is encrypted at rest
 * for encrypted memories (so the comparison is impossible there), and
 * matching on the primary key is the conservative direction anyway: if a
 * live asset's row somehow disagreed with where its bytes sit, id
 * matching leaves the object alone, while key matching would delete it.
 *
 * A database that cannot answer must abort the sweep. Catching this and
 * carrying on would turn a transient outage into "no rows exist" — and
 * this sweep deletes on the absence of rows.
 */
async function loadPresentAssetIds(
  db: PrismaClient,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const rows = await db.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    throw new OrphanSweepAbortedError(
      'asset lookup failed — aborting rather than treating an unreachable database as "no rows exist"',
      err,
    );
  }
}

/**
 * Run the orphan sweep on an interval for the server's lifetime.
 *
 * Daily rather than the retention sweep's hourly: a full bucket listing
 * is not free, and nothing about reclaiming dead bytes is urgent. The
 * sweep no-ops when asset storage is unconfigured, so a deployment
 * without object storage stays quiet.
 */
export function startOrphanObjectReaperLoop(
  db?: PrismaClient,
  intervalMs = 24 * 60 * 60 * 1000,
  initialDelayMs = 15 * 60 * 1000,
): NodeJS.Timeout {
  const run = async () => {
    if (!isObjectStoreConfigured()) return;
    try {
      const outcome = await reapOrphanAssetObjects({ db });
      if (outcome.orphans > 0 || outcome.errors > 0 || outcome.unrecognized > 0) {
        const verb = outcome.dryRun ? 'would reap' : 'reaped';
        // eslint-disable-next-line no-console
        console.log(
          `[janitor:orphans] listed ${outcome.listed}, ${verb} ${outcome.orphans} ` +
            `(${outcome.orphanBytes} bytes), unrecognized ${outcome.unrecognized}, ` +
            `errors ${outcome.errors}` +
            (outcome.dryRun
              ? ' — dry run; set ASSET_ORPHAN_REAP_ENABLED=true to delete'
              : ''),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[janitor:orphans] sweep failed:', err);
    }
  };

  // Same timer shape as the retention janitor: the initial timeout is
  // returned so callers can cancel it; the interval that replaces it
  // lives for the server's lifetime by design.
  let timer: NodeJS.Timeout;
  const initial = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), intervalMs);
    void timer;
  }, initialDelayMs);
  return initial;
}

// Allow `tsx src/jobs/reapOrphanAssetObjects.ts [--apply]` to run it directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  // `--apply` forces a real run; without it the env flag decides (so a
  // hand-run on a host with reaping enabled behaves like the loop does).
  const apply = process.argv.includes('--apply') ? true : undefined;
  reapOrphanAssetObjects({ apply })
    .then((outcome) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...outcome, ranAt: new Date().toISOString() }));
      process.exit(outcome.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
