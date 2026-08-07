// Storage-key derivation for asset uploads.
// Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-008.
// Format: {memoryUrn with ":" → "/"}/{assetId}[.{ext}]
//   e.g. "acme.com:docs:team" → "acme.com/docs/team/<assetId>.pdf"
//
// Derived from the MEMORY URN alone. It used to take the org URN
// separately and strip it as a prefix, which produced byte-identical keys
// (a memory urn IS "<orgUrn>:<rest>") but made the whole thing unusable
// for a spec-047 USER-OWNED memory: those have no organization, so
// `beginAssetUpload` rejected them outright with "asset upload is not
// supported for a user-owned memory yet". A user-owned memory is exactly
// where someone puts a personal file, so that ruled out the common case.
//
// User-owned memory urns are the same two-atom shape (`holger:jens`), so
// dropping the org parameter supports them with no key-format change and
// no migration — existing objects keep resolving.
//
// A user handle and an org urn therefore share the top level of the
// keyspace. Harmless: the asset id makes every key unique regardless, and
// `storageKey` is unique-constrained. Nothing may infer tenancy from the
// leading segment — read it off the Asset row's memory instead.

// Each path segment: lowercase alnum + dash/underscore, optionally with
// dotted parts (e.g. "baragaun.com"). Segments cannot start with a dot,
// which blocks traversal patterns like "..". Asset id is 32-or-36 hex
// (UUIDv7 with or without hyphens). Extension is optional.
const SEGMENT = '[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*';
const ASSET_ID = '[0-9a-f-]{32,36}';
const KEY_REGEX = new RegExp(
  `^${SEGMENT}(?:\\/${SEGMENT})+\\/${ASSET_ID}(?:\\.[a-z0-9]+)?$`,
);

export function memorySegmentOf(memoryUrn: string, orgUrn: string): string {
  const prefix = `${orgUrn}:`;
  if (!memoryUrn.startsWith(prefix)) {
    throw new Error(
      `MEMORY_URN_NOT_UNDER_ORG: memoryUrn="${memoryUrn}" orgUrn="${orgUrn}"`,
    );
  }
  return memoryUrn.slice(prefix.length);
}

export function extractExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  const raw = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(raw) ? raw : '';
}

export function buildStorageKey(args: {
  memoryUrn: string;
  assetId: string;
  filename: string;
}): string {
  const memoryPath = args.memoryUrn.replace(/:/g, '/');
  const ext = extractExtension(args.filename);
  const key = ext
    ? `${memoryPath}/${args.assetId}.${ext}`
    : `${memoryPath}/${args.assetId}`;
  if (!KEY_REGEX.test(key)) {
    throw new Error(`STORAGE_KEY_INVALID: ${key}`);
  }
  return key;
}

export function validateStorageKey(key: string): boolean {
  return KEY_REGEX.test(key);
}

/**
 * The key an upload's bytes land on BEFORE they have been verified.
 *
 * A presigned PUT URL stays valid for its whole TTL — nothing can revoke
 * it once issued — so an uploader who has had their bytes accepted can
 * simply PUT the same key again with different content. Both signed
 * values (ContentLength, ContentType) are trivially reproducible by
 * padding, so the replacement passes the signature and the Asset row,
 * already marked CLEAN, now points at bytes nobody checked.
 *
 * The fix is to never presign the key the Asset will use. Bytes are
 * uploaded here, verified here, then server-side copied to the real key
 * and this one deleted. The presigned URL only ever addressed staging,
 * so re-PUTting it after completion writes to an object no row
 * references — and the janitor's orphan sweep reclaims it.
 *
 * Shape mirrors the final key so it satisfies the same validator, under
 * a distinct `staging` root that no final key can collide with (a final
 * key always begins with a memory URN's root atom).
 */
export function buildStagingKey(args: {
  memoryUrn: string;
  uploadId: string;
  filename: string;
}): string {
  const memoryPath = args.memoryUrn.replace(/:/g, '/');
  const ext = extractExtension(args.filename);
  const key = ext
    ? `staging/${memoryPath}/${args.uploadId}.${ext}`
    : `staging/${memoryPath}/${args.uploadId}`;
  if (!KEY_REGEX.test(key)) {
    throw new Error(`STORAGE_KEY_INVALID: ${key}`);
  }
  return key;
}
