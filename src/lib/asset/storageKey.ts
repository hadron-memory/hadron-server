// Storage-key derivation for asset uploads.
// Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-008.
// Format: {orgUrn}/{memoryPath}/{assetId}[.{ext}]
//   memoryPath = Memory.urn after the leading "{orgUrn}:" with each
//                ":" turned into "/" so colon-delimited per-user memories
//                (e.g. "juno:user:019dd...") become directory hierarchies
//                in object storage rather than colon-laden flat keys.

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
  orgUrn: string;
  memoryUrn: string;
  assetId: string;
  filename: string;
}): string {
  const memoryPath = memorySegmentOf(args.memoryUrn, args.orgUrn).replace(/:/g, '/');
  const ext = extractExtension(args.filename);
  const key = ext
    ? `${args.orgUrn}/${memoryPath}/${args.assetId}.${ext}`
    : `${args.orgUrn}/${memoryPath}/${args.assetId}`;
  if (!KEY_REGEX.test(key)) {
    throw new Error(`STORAGE_KEY_INVALID: ${key}`);
  }
  return key;
}

export function validateStorageKey(key: string): boolean {
  return KEY_REGEX.test(key);
}
