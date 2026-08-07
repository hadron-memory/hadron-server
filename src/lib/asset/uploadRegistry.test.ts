import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUpload,
  consumeUpload,
  peekUpload,
  pruneExpired,
  _resetRegistry,
  type UploadRegistryEntry,
} from './uploadRegistry.js';

const baseEntry = (): UploadRegistryEntry => ({
  uploadId: 'u1',
  assetId: 'a1',
  storageKey: 'org/seg/a1.pdf',
  stagingKey: 'staging/org/seg/u1.pdf',
  filename: 'x.pdf',
  mimeType: 'application/pdf',
  expectedSizeBytes: 100,
  agentId: 'agent-1',
  memoryId: 'mem-1',
  appId: 'app-1',
  userId: 'user-1',
  uploadIntent: 'USER',
  expiresAt: Date.now() + 5 * 60_000,
});

describe('uploadRegistry', () => {
  beforeEach(() => _resetRegistry());

  it('records and consumes an entry exactly once', () => {
    recordUpload(baseEntry());
    expect(consumeUpload('u1')?.assetId).toBe('a1');
    expect(consumeUpload('u1')).toBeNull();
  });

  it('returns null for an unknown upload id', () => {
    expect(consumeUpload('nope')).toBeNull();
  });

  it('peek does not consume', () => {
    recordUpload(baseEntry());
    expect(peekUpload('u1')?.assetId).toBe('a1');
    expect(peekUpload('u1')?.assetId).toBe('a1');
    expect(consumeUpload('u1')).not.toBeNull();
  });

  it('expired entries are evicted on consume', () => {
    recordUpload({ ...baseEntry(), expiresAt: Date.now() - 1 });
    expect(consumeUpload('u1')).toBeNull();
  });

  it('pruneExpired drops only expired entries', () => {
    recordUpload({ ...baseEntry(), uploadId: 'a', expiresAt: Date.now() - 1 });
    recordUpload({ ...baseEntry(), uploadId: 'b', expiresAt: Date.now() + 60_000 });
    expect(pruneExpired()).toBe(1);
    expect(peekUpload('a')).toBeNull();
    expect(peekUpload('b')).not.toBeNull();
  });
});
