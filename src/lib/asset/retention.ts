/**
 * Soft-delete recovery window for assets.
 *
 * Per spec 004-asset-upload US5: assets are soft-deleted (the row's
 * `deleted_at` is set; the R2 object is retained) and can be
 * restored within 24h. After 24h the janitor sweeps both.
 */

export const ASSET_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Returns true if the asset is still within its restore window. */
export function isWithinRetentionWindow(
  deletedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!deletedAt) return false;
  return now.getTime() - deletedAt.getTime() < ASSET_RETENTION_WINDOW_MS;
}
