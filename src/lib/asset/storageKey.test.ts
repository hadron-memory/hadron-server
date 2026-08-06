import { describe, it, expect } from 'vitest';
import {
  memorySegmentOf,
  extractExtension,
  buildStorageKey,
  validateStorageKey,
} from './storageKey.js';

describe('memorySegmentOf', () => {
  it('strips the org prefix', () => {
    expect(memorySegmentOf('baragaun.com:secureid', 'baragaun.com')).toBe('secureid');
  });

  it('handles multi-segment memory paths', () => {
    expect(memorySegmentOf('baragaun.com:foo:bar', 'baragaun.com')).toBe('foo:bar');
  });

  it('throws when memory URN is not under the org', () => {
    expect(() => memorySegmentOf('other.com:foo', 'baragaun.com')).toThrow(
      /MEMORY_URN_NOT_UNDER_ORG/,
    );
  });
});

describe('extractExtension', () => {
  it.each([
    ['business-plan.pdf', 'pdf'],
    ['photo.JPEG', 'jpeg'],
    ['archive.tar.gz', 'gz'],
    ['no-extension', ''],
    ['weird.', ''],
    ['hidden.', ''],
    ['file.with-dash', ''],
  ])('extension of %s = "%s"', (filename, expected) => {
    expect(extractExtension(filename)).toBe(expected);
  });
});

describe('buildStorageKey', () => {
  it('produces a valid key for a typical PDF upload', () => {
    const key = buildStorageKey({
      memoryUrn: 'baragaun.com:secureid',
      assetId: '01900000-0000-7000-8000-000000000001',
      filename: 'business-plan.pdf',
    });
    expect(key).toBe(
      'baragaun.com/secureid/01900000-0000-7000-8000-000000000001.pdf',
    );
    expect(validateStorageKey(key)).toBe(true);
  });

  it('omits the extension when filename has none', () => {
    const key = buildStorageKey({
      memoryUrn: 'baragaun.com:notes',
      assetId: '01900000-0000-7000-8000-000000000002',
      filename: 'README',
    });
    expect(key).toBe(
      'baragaun.com/notes/01900000-0000-7000-8000-000000000002',
    );
  });

  it('builds a key for a spec-047 USER-OWNED memory (no organization)', () => {
    // The reason the org parameter went away. A user-owned memory has no
    // organization, so the old org-prefix derivation could not produce a
    // key at all and beginAssetUpload rejected the upload outright —
    // which ruled out personal memories, the obvious place for a personal
    // file. User-owned urns are the same two-atom shape, so nothing about
    // the format changes.
    const key = buildStorageKey({
      memoryUrn: 'holger:jens',
      assetId: '019dd446b8d472e5bd2d2e55b96416e9',
      filename: 'notes.md',
    });
    expect(key).toBe('holger/jens/019dd446b8d472e5bd2d2e55b96416e9.md');
    expect(validateStorageKey(key)).toBe(true);
  });

  it('explodes per-user memory URN colons into directory segments', () => {
    const key = buildStorageKey({
      memoryUrn: 'baragaun.com:juno:user:019dd3cfdc43783e827690ee7e0c85dd',
      assetId: '019dd446b8d472e5bd2d2e55b96416e9',
      filename: 'photo.jpeg',
    });
    expect(key).toBe(
      'baragaun.com/juno/user/019dd3cfdc43783e827690ee7e0c85dd/019dd446b8d472e5bd2d2e55b96416e9.jpeg',
    );
    expect(validateStorageKey(key)).toBe(true);
  });
});

describe('validateStorageKey', () => {
  it.each([
    ['baragaun.com/secureid/01900000-0000-7000-8000-000000000001.pdf', true],
    ['org/seg/00000000000000000000000000000001', true],
    ['../escape/01900000-0000-7000-8000-000000000001.pdf', false],
    ['no-uuid/seg/abc.pdf', false],
    ['org/seg/01900000-0000-7000-8000-000000000001.PDF', false],
  ])('%s → %s', (key, expected) => {
    expect(validateStorageKey(key)).toBe(expected);
  });
});
