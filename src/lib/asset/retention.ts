/**
 * Soft-delete recovery window for assets.
 *
 * Per spec 004-asset-upload US5: assets are soft-deleted (the row's
 * `deleted_at` is set; the R2 object is retained) and can be
 * restored within 24h. After 24h the janitor sweeps both.
 */

export const ASSET_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a presigned upload URL stays valid.
 *
 * Lives here rather than next to `beginAssetUpload` because it is the
 * basis of `ORPHAN_MIN_AGE_MS` below: the orphan reaper deletes objects
 * for the *absence* of a row, and an upload in flight is an object with
 * no row by definition.
 */
export const PRESIGN_TTL_SECONDS = 5 * 60;

/**
 * How old an object with no Asset row must be before the orphan reaper
 * will touch it (spec 004 FR-018 follow-up, #889).
 *
 * `beginAssetUpload` presigns, the client PUTs, and `completeAssetUpload`
 * writes the row afterwards — so during that whole window the bucket
 * legitimately holds an object no row references. Reaping inside it would
 * delete a user's file mid-upload. The threshold is therefore a large
 * multiple of the presign TTL, and generous besides: nothing about
 * reclaiming dead bytes is urgent, while deleting live ones has no undo.
 */
export const ORPHAN_MIN_AGE_MS = Math.max(
  24 * 60 * 60 * 1000,
  48 * PRESIGN_TTL_SECONDS * 1000,
);

/** Returns true if the asset is still within its restore window. */
export function isWithinRetentionWindow(
  deletedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!deletedAt) return false;
  return now.getTime() - deletedAt.getTime() < ASSET_RETENTION_WINDOW_MS;
}
