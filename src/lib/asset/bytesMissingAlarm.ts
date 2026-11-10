/**
 * The alarm for an Asset row whose bytes are missing from object storage
 * (#1140): a row that claims bytes and a store that has none is genuine
 * server-state inconsistency, the mirror of the orphan-object sweep
 * (`jobs/reapOrphanAssetObjects.ts`, #889).
 *
 * Fired where the inconsistency is DISCOVERED (today the restore path; the
 * row sweep joins it in slice B), not in the GraphQL error formatter, which
 * only fires when a user happens to ask for the bytes.
 *
 * Contract: one error-level Sentry event per asset per UTC day, tagged
 * `asset.bytes_missing`, fingerprinted by asset id. The event carries ids only,
 * never a storage key or filename. The dedupe set is in-process and bounded, so
 * a bucket loss cannot grow it without limit; a restart or eviction costs at
 * most one repeat event per asset.
 */

import * as Sentry from '@sentry/node';

export const ASSET_BYTES_MISSING_TAG = 'asset.bytes_missing';

/** Cap on remembered (asset, day) pairs; the oldest is forgotten past it. */
export const DEDUPE_MAX_ENTRIES = 1000;

export interface AssetBytesMissing {
  assetId: string;
  memoryId: string | null;
  /** Which discovery site saw it. */
  source: 'restore' | 'sweep';
}

// Map preserves insertion order, so the first key is the oldest.
const reportedOn = new Map<string, string>();

/** Test hook: forget every remembered report. */
export function resetAssetBytesMissingDedupe(): void {
  reportedOn.clear();
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Report a row-without-bytes once per asset per UTC day. Returns whether an
 * event was sent. Never throws: an alarm must not break the caller's own path.
 */
export function reportAssetBytesMissing(found: AssetBytesMissing, now: Date = new Date()): boolean {
  const day = utcDay(now);
  if (reportedOn.get(found.assetId) === day) return false;
  reportedOn.delete(found.assetId);
  reportedOn.set(found.assetId, day);
  if (reportedOn.size > DEDUPE_MAX_ENTRIES) {
    const oldest = reportedOn.keys().next().value;
    if (oldest !== undefined) reportedOn.delete(oldest);
  }
  try {
    Sentry.captureMessage('Asset row has no object in storage', {
      level: 'error',
      tags: { [ASSET_BYTES_MISSING_TAG]: 'true', source: found.source },
      fingerprint: [ASSET_BYTES_MISSING_TAG, found.assetId],
      extra: { assetId: found.assetId, memoryId: found.memoryId },
    });
  } catch {
    return false;
  }
  return true;
}

/**
 * One summary event for a sweep run that found more missing rows than it may
 * report individually (#1140). A bucket loss would otherwise make a single run
 * emit one event per row; past the per-run cap the remainder is counted here.
 * Counts only, no ids. Never throws.
 */
export function reportAssetBytesMissingSummary(found: { total: number; unreported: number }): boolean {
  try {
    Sentry.captureMessage('Asset rows have no object in storage (sweep summary)', {
      level: 'error',
      tags: { [ASSET_BYTES_MISSING_TAG]: 'true', source: 'sweep' },
      fingerprint: [ASSET_BYTES_MISSING_TAG, 'sweep-summary'],
      extra: { total: found.total, unreported: found.unreported },
    });
  } catch {
    return false;
  }
  return true;
}
