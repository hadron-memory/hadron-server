// In-flight upload registry. Bridges beginAssetUpload (presign + ticket) to
// completeAssetUpload (HeadObject + persist node) without writing partial
// rows. Lives in process memory; entries auto-expire at the presigned URL
// TTL.
//
// TODO(scaling): when we run multiple server instances, swap this for an
// HMAC-signed ticket envelope so any instance can verify a complete-call
// without shared state. Single-instance v1 is fine with the local Map.

export interface UploadRegistryEntry {
  uploadId: string;
  assetId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  expectedSizeBytes: number;
  description?: string;
  agentId: string;
  memoryId: string;
  appId: string;
  userId: string;
  uploadIntent: 'USER' | 'AGENT_REQUEST';
  uploadRequestId?: string;
  expiresAt: number; // epoch ms
}

const store = new Map<string, UploadRegistryEntry>();

export function recordUpload(entry: UploadRegistryEntry): void {
  store.set(entry.uploadId, entry);
}

export function consumeUpload(uploadId: string): UploadRegistryEntry | null {
  const entry = store.get(uploadId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(uploadId);
    return null;
  }
  store.delete(uploadId);
  return entry;
}

export function peekUpload(uploadId: string): UploadRegistryEntry | null {
  const entry = store.get(uploadId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(uploadId);
    return null;
  }
  return entry;
}

export function pruneExpired(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, entry] of store) {
    if (entry.expiresAt < now) {
      store.delete(id);
      removed += 1;
    }
  }
  return removed;
}

// Test-only.
export function _resetRegistry(): void {
  store.clear();
}
