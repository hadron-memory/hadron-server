// Storage-key derivation for asset uploads.
// Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-008.
// Format: {orgUrn}/{memorySegment}/{assetId}.{ext}
// memorySegment = Memory.urn after the leading "{orgUrn}:"

const KEY_REGEX = /^[a-z0-9.-]+\/[a-z0-9-]+\/[0-9a-f-]{32,36}(?:\.[a-z0-9]+)?$/;

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
  const segment = memorySegmentOf(args.memoryUrn, args.orgUrn);
  const ext = extractExtension(args.filename);
  const key = ext
    ? `${args.orgUrn}/${segment}/${args.assetId}.${ext}`
    : `${args.orgUrn}/${segment}/${args.assetId}`;
  if (!KEY_REGEX.test(key)) {
    throw new Error(`STORAGE_KEY_INVALID: ${key}`);
  }
  return key;
}

export function validateStorageKey(key: string): boolean {
  return KEY_REGEX.test(key);
}
