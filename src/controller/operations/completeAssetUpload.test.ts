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
const readObjectPrefixMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\n')),
);

vi.mock('../../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
  deleteObject: deleteObjectMock,
  readObjectPrefix: readObjectPrefixMock,
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
    // The magic bytes were actually consulted, not just the ticket.
    expect(readObjectPrefixMock).toHaveBeenCalledWith(entry.storageKey, 16);
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
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.storageKey);
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
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.storageKey);
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
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.storageKey);
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
    expect(deleteObjectMock).toHaveBeenCalledWith(entry.storageKey);
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
