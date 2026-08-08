import { describe, it, expect } from 'vitest';
import {
  memorySegmentOf,
  extractExtension,
  buildStorageKey,
  buildStagingKey,
  isStagingKey,
  parseAssetIdFromKey,
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

describe('parseAssetIdFromKey', () => {
  // The property the orphan reaper (#889) is built on: whatever
  // buildStorageKey emits, this recovers the asset id from — including
  // for encrypted memories, whose storage_key COLUMN is encrypted while
  // the object's actual key is not.
  it('round-trips every key buildStorageKey produces', () => {
    const assetId = '019dd446b8d472e5bd2d2e55b96416e9';
    const cases = [
      { memoryUrn: 'baragaun.com:secureid', filename: 'report.pdf' },
      { memoryUrn: 'holger:jens', filename: 'notes.md' },
      { memoryUrn: 'baragaun.com:juno:user:019dd3cf', filename: 'no-extension' },
    ];
    for (const c of cases) {
      expect(parseAssetIdFromKey(buildStorageKey({ ...c, assetId }))).toBe(assetId);
    }
  });

  it('returns null rather than guessing for keys we did not write', () => {
    // Deleting on the absence of a row means an unparseable key must be
    // left alone, not approximated.
    expect(parseAssetIdFromKey('backups/hadron-2026-08-08.sql.gz')).toBeNull();
    expect(parseAssetIdFromKey('org/seg/not-a-uuid.pdf')).toBeNull();
    expect(parseAssetIdFromKey('toplevel.txt')).toBeNull();
    expect(parseAssetIdFromKey('../escape/00000000000000000000000000000001')).toBeNull();
  });

  it('returns null for a staging key — its basename is an UPLOAD id', () => {
    // A staging basename would parse as an id-shaped string but match no
    // asset row, so treating it as a final key would call every staged
    // object an orphan for the wrong reason.
    const staging = buildStagingKey({
      memoryUrn: 'baragaun.com:secureid',
      uploadId: '019dd446b8d472e5bd2d2e55b96416e9',
      filename: 'report.pdf',
    });
    expect(isStagingKey(staging)).toBe(true);
    expect(parseAssetIdFromKey(staging)).toBeNull();
    expect(isStagingKey(buildStorageKey({
      memoryUrn: 'baragaun.com:secureid',
      assetId: '019dd446b8d472e5bd2d2e55b96416e9',
      filename: 'report.pdf',
    }))).toBe(false);
  });
});
