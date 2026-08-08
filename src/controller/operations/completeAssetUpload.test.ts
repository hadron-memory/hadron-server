/**
 * Integration test (US2 / FR-009 + FR-014): completeAssetUpload
 * verifies size+MIME against the begin-upload promise, persists the
 * Asset row, and encrypts `storage_key` in encrypted memories.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { recordUpload } from '../../lib/asset/uploadRegistry.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { generateDataKey, parseDataKey } from '../../lib/crypto.js';
import { isEncryptedStorageKey } from '../../lib/asset/encryption.js';
import { completeAssetUpload } from './completeAssetUpload.js';

const headObjectMock = vi.hoisted(() => vi.fn());
const deleteObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// Fixtures declare application/pdf, so the default prefix is a valid %PDF
// header — otherwise every test would now trip the magic-byte check.
const copyObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const readObjectPrefixMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\n')),
);
const mintGetUrlMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue('https://bucket/presigned-get'),
);

vi.mock('../../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
  deleteObject: deleteObjectMock,
  readObjectPrefix: readObjectPrefixMock,
  copyObject: copyObjectMock,
  mintGetUrl: mintGetUrlMock,
}));

// #896 inline scan. Default: scanner NOT configured, so the pre-scanner
// tests keep their born-PENDING / autoClean semantics untouched.
const isScanConfiguredMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const scanUrlMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/scanClient.js', () => ({
  isScanConfigured: isScanConfiguredMock,
  scanUrl: scanUrlMock,
}));

let org: { id: string; urn: string };
let user: { id: string };
let memory: { id: string; urn: string };

function buildEntry(over: Partial<Parameters<typeof recordUpload>[0]> = {}) {
  const uploadId = generateId();
  const assetId = generateId();
  const entry = {
    uploadId,
    assetId,
    // Distinct from storageKey on purpose — the presigned PUT only ever
    // reaches staging, and verification happens there.
    stagingKey: `staging/asset-org/buno/user/${uploadId}.pdf`,
    storageKey: `asset-org/buno/user/${assetId}.pdf`,
    filename: 'business-plan.pdf',
    mimeType: 'application/pdf',
    expectedSizeBytes: 1024,
    description: undefined,
    agentId: 'agent-id',
    memoryId: memory.id,
    appId: null,
    userId: user.id,
    uploadIntent: 'USER' as const,
    uploadRequestId: undefined,
    expiresAt: Date.now() + 5 * 60 * 1000,
    ...over,
  };
  recordUpload(entry);
  return entry;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  user = await db.user.create({
    data: { githubId: 9501, githubUsername: 'asset-complete-user', roles: ['READER'] },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:buno:user:${generateId()}`,
      name: 'user-memory',
      visibility: 'ORGANIZATION',
    },
  });
  headObjectMock.mockReset();
  deleteObjectMock.mockClear();
  copyObjectMock.mockClear();
  readObjectPrefixMock.mockClear();
  mintGetUrlMock.mockClear();
  isScanConfiguredMock.mockReturnValue(false);
  scanUrlMock.mockReset();
});

describe('completeAssetUpload', () => {
  it('persists an Asset row when HeadObject matches the ticket', async () => {
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });

    const asset = await completeAssetUpload(
      db,
      { userId: user.id },
      { uploadId: entry.uploadId },
    );

    expect(asset.id).toBe(entry.assetId);
    expect(asset.memoryId).toBe(memory.id);
    expect(asset.filename).toBe('business-plan.pdf');
    expect(asset.mimeType).toBe('application/pdf');
    // The magic bytes were actually consulted, not just the ticket — and
    // at the STAGING key, which is the only one the PUT could reach.
    expect(readObjectPrefixMock).toHaveBeenCalledWith(entry.stagingKey, 16);
    // Verified bytes were promoted to a key that was never presigned,
    // and the staging object cleaned up.
    expect(copyObjectMock).toHaveBeenCalledWith(entry.stagingKey, entry.storageKey);
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
    expect(asset.storageKey).toBe(entry.storageKey);
    expect(asset.sizeBytes).toBe(1024);
    expect(asset.storageKey).toBe(entry.storageKey); // plaintext (memory is unencrypted)
    expect(asset.scanStatus).toBe('PENDING');
    expect(asset.uploadedBy).toBe(user.id);
  });

  it('rejects with NOT_FOUND when the upload ticket is missing or expired', async () => {
    await expect(
      completeAssetUpload(
        db,
        { userId: user.id },
        { uploadId: 'never-recorded' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects when the caller userId does not match the ticket', async () => {
    const entry = buildEntry();
    await expect(
      completeAssetUpload(
        db,
        { userId: 'different-user' },
        { uploadId: entry.uploadId },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('deletes the orphan and rejects when the size mismatches', async () => {
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: 9999,
      contentType: entry.mimeType,
    });
    await expect(
      completeAssetUpload(
        db,
        { userId: user.id },
        { uploadId: entry.uploadId },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
  });

  it('deletes the orphan and rejects when the MIME mismatches', async () => {
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: 'image/png',
    });
    await expect(
      completeAssetUpload(
        db,
        { userId: user.id },
        { uploadId: entry.uploadId },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
  });

  it('rejects with NOT_FOUND when no object exists at the storage key', async () => {
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({ exists: false });
    await expect(
      completeAssetUpload(
        db,
        { userId: user.id },
        { uploadId: entry.uploadId },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('encrypts storage_key when the memory is encrypted (FR-014)', async () => {
    // Mark the memory encrypted and cache a session key.
    await db.memory.update({
      where: { id: memory.id },
      data: { isEncrypted: true },
    });
    const keyB64 = generateDataKey().raw.toString('base64');
    const key = parseDataKey(keyB64);
    sessionKeyCache.set(generateId(), memory.id, key);

    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });

    const asset = await completeAssetUpload(
      db,
      { userId: user.id },
      { uploadId: entry.uploadId },
    );
    expect(asset.storageKey).not.toBe(entry.storageKey);
    expect(isEncryptedStorageKey(asset.storageKey)).toBe(true);
  });

  it('returns MEMORY_ENCRYPTED_NO_KEY when an encrypted memory has no session key', async () => {
    await db.memory.update({
      where: { id: memory.id },
      data: { isEncrypted: true },
    });
    // Clear any cached key for this memory.
    // (sessionKeyCache.set was not called for this memory.id in this test.)

    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });
    await expect(
      completeAssetUpload(
        db,
        { userId: user.id },
        { uploadId: entry.uploadId },
      ),
    ).rejects.toMatchObject({ code: 'MEMORY_ENCRYPTED_NO_KEY' });
    // The orphan was cleaned up.
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
  });

  // ── Declared type vs actual content (#896 interim hardening) ──
  // Both values the earlier checks compare are CLIENT-supplied, so
  // until this landed an executable uploaded as application/pdf passed
  // every gate and the allowlist was advisory.

  it('rejects a file whose bytes do not match its declared type', async () => {
    const entry = buildEntry(); // declares application/pdf
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });
    // MZ — a Windows executable, uploaded claiming to be a PDF.
    readObjectPrefixMock.mockResolvedValueOnce(Buffer.from([0x4d, 0x5a, 0x90, 0x00]));

    await expect(
      completeAssetUpload(db, { userId: user.id }, { uploadId: entry.uploadId }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // The bytes must not survive a rejected upload.
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
    expect(await db.asset.count({ where: { id: entry.assetId } })).toBe(0);
  });

  it('accepts a type it cannot verify rather than guessing', async () => {
    // text/plain has no magic bytes. Abstaining is deliberate: a false
    // reject breaks a legitimate upload, a false accept only leaves us
    // where we already were.
    const entry = buildEntry({ mimeType: 'text/plain', filename: 'notes.txt' } as never);
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: 'text/plain',
    });
    readObjectPrefixMock.mockResolvedValueOnce(Buffer.from('hello, world'));

    const asset = await completeAssetUpload(
      db,
      { userId: user.id },
      { uploadId: entry.uploadId },
    );
    expect(asset.mimeType).toBe('text/plain');
  });

  it('never promotes bytes that failed verification', async () => {
    // The whole point of staging: a rejected upload leaves nothing at the
    // key a download would read.
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });
    readObjectPrefixMock.mockResolvedValueOnce(Buffer.from([0x4d, 0x5a, 0x90, 0x00]));

    await expect(
      completeAssetUpload(db, { userId: user.id }, { uploadId: entry.uploadId }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(copyObjectMock).not.toHaveBeenCalled();
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
    // Nothing was ever written to the final key.
    expect(deleteObjectMock).not.toHaveBeenCalledWith(entry.storageKey);
  });

  it('cleans up BOTH objects when the row write fails after promotion', async () => {
    // The copy already landed, so a failed insert would otherwise leave
    // an orphan at the final key that no row references.
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });
    // Force the insert to fail on a duplicate primary key.
    await db.asset.create({
      data: {
        id: entry.assetId,
        memoryId: memory.id,
        filename: 'squatter.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: `occupied-${entry.assetId}`,
        scanStatus: 'CLEAN',
      },
    });

    await expect(
      completeAssetUpload(db, { userId: user.id }, { uploadId: entry.uploadId }),
    ).rejects.toBeTruthy();

    expect(copyObjectMock).toHaveBeenCalledWith(entry.stagingKey, entry.storageKey);
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.storageKey);
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.stagingKey);
  });

  it('accepts when the object is empty or unreadable rather than failing closed', async () => {
    const entry = buildEntry();
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });
    readObjectPrefixMock.mockResolvedValueOnce(null);

    const asset = await completeAssetUpload(
      db,
      { userId: user.id },
      { uploadId: entry.uploadId },
    );
    expect(asset.id).toBe(entry.assetId);
  });
});

describe('completeAssetUpload — inline malware scan (#896)', () => {
  function headOk(entry: ReturnType<typeof buildEntry>) {
    headObjectMock.mockResolvedValueOnce({
      exists: true,
      contentLength: entry.expectedSizeBytes,
      contentType: entry.mimeType,
    });
  }

  beforeEach(() => {
    isScanConfiguredMock.mockReturnValue(true);
  });

  it('returns a CLEAN asset when the scan verdict is clean', async () => {
    const entry = buildEntry();
    headOk(entry);
    scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

    const asset = await completeAssetUpload(
      db,
      { userId: user.id },
      { uploadId: entry.uploadId },
    );

    expect(asset.scanStatus).toBe('CLEAN');
    expect(asset.scanAttempts).toBe(1);
    // The scan URL was minted on the PROMOTED key — never the staging
    // key, which stays re-PUTtable for its whole presign TTL.
    expect(mintGetUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: entry.storageKey }),
    );
  });

  it('scanner wins over HADRON_ASSET_SCAN_AUTO_CLEAN when both are on', async () => {
    vi.stubEnv('HADRON_ASSET_SCAN_AUTO_CLEAN', 'true');
    try {
      const entry = buildEntry();
      headOk(entry);
      scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

      const asset = await completeAssetUpload(
        db,
        { userId: user.id },
        { uploadId: entry.uploadId },
      );

      // CLEAN via a real verdict, not born-CLEAN: the scan actually ran.
      expect(asset.scanStatus).toBe('CLEAN');
      expect(scanUrlMock).toHaveBeenCalledTimes(1);
      expect(asset.scanAttempts).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects an infected upload with MALWARE_BLOCKED, keeps the tombstone, deletes the bytes', async () => {
    const entry = buildEntry();
    headOk(entry);
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'infected',
      signature: 'Eicar-Signature',
    });

    await expect(
      completeAssetUpload(db, { userId: user.id }, { uploadId: entry.uploadId }),
    ).rejects.toMatchObject({ code: 'MALWARE_BLOCKED' });

    const row = await db.asset.findUniqueOrThrow({
      where: { id: entry.assetId },
    });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanSignature).toBe('Eicar-Signature');
    // The promoted object's bytes were purged; the row remains as the
    // audit tombstone.
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.storageKey);
  });

  it('succeeds with a PENDING asset when the scan tool is unavailable', async () => {
    const entry = buildEntry();
    headOk(entry);
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'unavailable',
      reason: 'tool down',
    });

    const asset = await completeAssetUpload(
      db,
      { userId: user.id },
      { uploadId: entry.uploadId },
    );

    // Fail-closed but not fail-broken: the upload lands, downloads stay
    // gated, and the sweep settles the row later.
    expect(asset.scanStatus).toBe('PENDING');
    expect(asset.scanAttempts).toBe(1);
  });
});
