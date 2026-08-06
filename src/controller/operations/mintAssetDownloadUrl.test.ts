/**
 * Integration test (US4 / US6 part 2): mintAssetDownloadUrl returns
 * a short-TTL presigned GET URL when the asset is scan-clean and the
 * caller can read its holding memory. Gated on scan_status; encrypts →
 * decrypts the storage_key on the request stack for encrypted
 * memories.
 *
 * The gate is the MEMORY's read access, not uploader identity — see
 * mintAssetDownloadUrl.ts for why that changed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { generateDataKey, parseDataKey } from '../../lib/crypto.js';
import { encryptStorageKeyForMemory } from '../../lib/asset/encryption.js';
import { mintAssetDownloadUrl } from './mintAssetDownloadUrl.js';

const mintGetUrlMock = vi.hoisted(() => vi.fn());

vi.mock('../../integrations/r2/client.js', () => ({
  mintGetUrl: mintGetUrlMock,
}));

let org: { id: string; urn: string };
let user: { id: string };
let otherUser: { id: string };
let memory: { id: string; urn: string };
let assetId: string;

async function seedAsset(over: Partial<{
  scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
  storageKey: string;
  uploadedBy: string | null;
  deletedAt: Date | null;
  memoryId: string;
}> = {}) {
  assetId = generateId();
  return db.asset.create({
    data: {
      id: assetId,
      memoryId: over.memoryId ?? memory.id,
      filename: 'business-plan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: over.storageKey ?? `asset-org/buno/user/${assetId}.pdf`,
      scanStatus: over.scanStatus ?? 'CLEAN',
      uploadedBy: over.uploadedBy === undefined ? user.id : over.uploadedBy,
      deletedAt: over.deletedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  mintGetUrlMock.mockReset();
  mintGetUrlMock.mockResolvedValue('https://r2.example/presigned-get');

  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  user = await db.user.create({
    data: { githubId: 9701, githubUsername: 'mint-user', roles: ['READER'] },
  });
  otherUser = await db.user.create({
    data: { githubId: 9702, githubUsername: 'mint-other', roles: ['READER'] },
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
  // The gate is the MEMORY's read access, so the caller needs genuine
  // read access to it. `otherUser` is deliberately left OUT of the org
  // — it is the unreadable-memory case.
  await db.orgMember.create({
    data: { userId: user.id, organizationId: org.id, role: 'CONTRIBUTOR' },
  });
});

describe('mintAssetDownloadUrl', () => {
  it('returns a presigned URL for a clean, owned asset', async () => {
    await seedAsset();
    const result = await mintAssetDownloadUrl(
      db,
      { userId: user.id },
      { assetId },
    );
    expect(result.url).toBe('https://r2.example/presigned-get');
    expect(result.filename).toBe('business-plan.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(1024);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('honors a caller-supplied ttlSeconds (clamped to MAX)', async () => {
    await seedAsset();
    const result = await mintAssetDownloadUrl(
      db,
      { userId: user.id },
      { assetId, ttlSeconds: 99999 }, // way over max
    );
    // Max is 1 hour
    expect(result.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3600 * 1000 + 1000);
  });

  it('rejects PENDING assets with SCAN_PENDING', async () => {
    await seedAsset({ scanStatus: 'PENDING' });
    await expect(
      mintAssetDownloadUrl(db, { userId: user.id }, { assetId }),
    ).rejects.toMatchObject({ code: 'SCAN_PENDING' });
  });

  it('rejects BLOCKED assets with SCAN_BLOCKED', async () => {
    await seedAsset({ scanStatus: 'BLOCKED' });
    await expect(
      mintAssetDownloadUrl(db, { userId: user.id }, { assetId }),
    ).rejects.toMatchObject({ code: 'SCAN_BLOCKED' });
  });

  // ── The gate is the memory's read access, not uploader identity ──

  it("allows a co-member to download a colleague's upload in a readable memory", async () => {
    await seedAsset({ uploadedBy: otherUser.id });
    const result = await mintAssetDownloadUrl(
      db,
      { userId: user.id },
      { assetId },
    );
    expect(result.url).toBe('https://r2.example/presigned-get');
  });

  it('allows download of a run-created asset (uploadedBy NULL)', async () => {
    // hadron_store_file writes uploadedBy: null. Under the old
    // uploader-identity gate `null !== userId` held for every caller,
    // so server-authored assets were permanently undownloadable.
    await seedAsset({ uploadedBy: null });
    const result = await mintAssetDownloadUrl(
      db,
      { userId: user.id },
      { assetId },
    );
    expect(result.url).toBe('https://r2.example/presigned-get');
  });

  it('rejects a caller who cannot read the holding memory', async () => {
    await seedAsset();
    // otherUser is not an org member, so the ORGANIZATION-visible
    // memory is unreadable to them.
    await expect(
      mintAssetDownloadUrl(db, { userId: otherUser.id }, { assetId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports an unreadable asset as NOT_FOUND, not PERMISSION_DENIED', async () => {
    // A distinct "exists but forbidden" answer would be an existence
    // oracle over asset ids — an unreadable asset must be
    // indistinguishable from one that does not exist.
    await seedAsset();
    const unreadable = await mintAssetDownloadUrl(
      db,
      { userId: otherUser.id },
      { assetId },
    ).catch((e) => e);
    const unknown = await mintAssetDownloadUrl(
      db,
      { userId: otherUser.id },
      { assetId: 'nope' },
    ).catch((e) => e);
    expect(unreadable.code).toBe(unknown.code);
    expect(unreadable.message).toBe(unknown.message);
  });

  it('rejects soft-deleted assets with NOT_FOUND', async () => {
    await seedAsset({ deletedAt: new Date() });
    await expect(
      mintAssetDownloadUrl(db, { userId: user.id }, { assetId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects unknown asset ids with NOT_FOUND', async () => {
    await expect(
      mintAssetDownloadUrl(db, { userId: user.id }, { assetId: 'nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('decrypts storage_key for encrypted memories and signs the plaintext key', async () => {
    await db.memory.update({
      where: { id: memory.id },
      data: { isEncrypted: true },
    });
    const keyB64 = generateDataKey().raw.toString('base64');
    const key = parseDataKey(keyB64);
    sessionKeyCache.set(generateId(), memory.id, key);

    const plainKey = `asset-org/buno/user/${generateId()}.pdf`;
    const enc = encryptStorageKeyForMemory(plainKey, { isEncrypted: true }, key);
    await seedAsset({ storageKey: enc });

    await mintAssetDownloadUrl(db, { userId: user.id }, { assetId });

    expect(mintGetUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: plainKey }),
    );
  });

  it('returns MEMORY_ENCRYPTED_NO_KEY when the encrypted memory has no session key', async () => {
    await db.memory.update({
      where: { id: memory.id },
      data: { isEncrypted: true },
    });
    // Don't cache a key.

    // Simulate an encrypted storage_key in the DB. Use a fresh key
    // just to encrypt; we won't cache it in sessionKeyCache, so the
    // resolver can't find it.
    const ephemeralKey = parseDataKey(generateDataKey().raw.toString('base64'));
    const plainKey = `asset-org/buno/user/${generateId()}.pdf`;
    const enc = encryptStorageKeyForMemory(plainKey, { isEncrypted: true }, ephemeralKey);
    await seedAsset({ storageKey: enc });

    await expect(
      mintAssetDownloadUrl(db, { userId: user.id }, { assetId }),
    ).rejects.toMatchObject({ code: 'MEMORY_ENCRYPTED_NO_KEY' });
  });
});
