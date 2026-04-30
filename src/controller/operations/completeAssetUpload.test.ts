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

vi.mock('../../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
  deleteObject: deleteObjectMock,
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
      visibility: 'PRIVATE',
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
});
