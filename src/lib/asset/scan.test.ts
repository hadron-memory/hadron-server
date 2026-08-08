/**
 * scanAssetRow — transition + purge semantics (#896).
 *
 * clean → CLEAN; infected → BLOCKED tombstone (signature kept, OBJECT
 * deleted); unavailable → still PENDING with attempt bookkeeping. The
 * BLOCKED row must survive its object's deletion — it is the audit
 * record.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { scanAssetRow } from './scan.js';

const mintGetUrlMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue('https://bucket/presigned-get'),
);
const deleteObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../integrations/r2/client.js', () => ({
  mintGetUrl: mintGetUrlMock,
  deleteObject: deleteObjectMock,
}));

const scanUrlMock = vi.hoisted(() => vi.fn());
vi.mock('../scanClient.js', () => ({
  scanUrl: scanUrlMock,
  isScanConfigured: () => true,
}));

let memory: { id: string };
let user: { id: string };

async function seedPendingAsset() {
  const id = generateId();
  return db.asset.create({
    data: {
      id,
      memoryId: memory.id,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `asset-org/mem/${id}.pdf`,
      scanStatus: 'PENDING',
      scanDueAt: new Date(),
      uploadedBy: user.id,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  mintGetUrlMock.mockClear();
  deleteObjectMock.mockClear();
  deleteObjectMock.mockResolvedValue(undefined);
  scanUrlMock.mockReset();

  const org = await db.organization.create({
    data: { id: generateId(), name: 'scan-org', urn: 'scan-org' },
  });
  user = await db.user.create({
    data: { githubId: 11001, githubUsername: 'scan-user', roles: ['READER'] },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `scan-org:buno:user:${generateId()}`,
      name: 'scan-memory',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('scanAssetRow', () => {
  it('flips CLEAN on a clean verdict', async () => {
    const asset = await seedPendingAsset();
    scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

    const result = await scanAssetRow(db, asset, asset.storageKey, {
      source: 'inline',
    });

    expect(result).toBe('CLEAN');
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('CLEAN');
    expect(row.scanAttempts).toBe(1);
    expect(row.scannedAt).not.toBeNull();
    expect(row.scanDueAt).toBeNull(); // settled — out of the queue
    expect(deleteObjectMock).not.toHaveBeenCalled();
    // The presigned GET was minted on the key the caller supplied.
    expect(mintGetUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: asset.storageKey }),
    );
  });

  it('flips BLOCKED, records the signature, and deletes the object on infected', async () => {
    const asset = await seedPendingAsset();
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'infected',
      signature: 'Eicar-Signature',
    });

    const result = await scanAssetRow(db, asset, asset.storageKey, {
      source: 'inline',
    });

    expect(result).toBe('BLOCKED');
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanSignature).toBe('Eicar-Signature');
    expect(row.scanDueAt).toBeNull(); // purge confirmed — nothing left to do
    // Bytes gone, tombstone row kept.
    expect(deleteObjectMock).toHaveBeenCalledWith(asset.storageKey);
  });

  it('keeps the BLOCKED tombstone and stamps a purge retry when the delete fails', async () => {
    const asset = await seedPendingAsset();
    scanUrlMock.mockResolvedValueOnce({ verdict: 'infected', signature: null });
    deleteObjectMock.mockRejectedValueOnce(new Error('store down'));

    const result = await scanAssetRow(db, asset, asset.storageKey, {
      source: 'sweep',
    });

    expect(result).toBe('BLOCKED');
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    // A failed delete leaves a retryable trail, not a swallowed error:
    // the sweep retries the purge via the still-set due stamp.
    expect(row.scanDueAt).not.toBeNull();
  });

  it('never lets a clean verdict overwrite a BLOCKED tombstone (lost claim)', async () => {
    const asset = await seedPendingAsset();
    // Another worker settled the row between our read and our verdict.
    await db.asset.update({
      where: { id: asset.id },
      data: { scanStatus: 'BLOCKED', scanSignature: 'Other-Sig', scanDueAt: null },
    });
    scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

    const result = await scanAssetRow(db, asset, asset.storageKey, {
      source: 'sweep',
    });

    expect(result).toBe('BLOCKED'); // reports the winner's verdict
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanSignature).toBe('Other-Sig');
  });

  it('stays PENDING with attempt bookkeeping when the tool is unavailable', async () => {
    const asset = await seedPendingAsset();
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'unavailable',
      reason: 'scan tool timed out',
    });

    const result = await scanAssetRow(db, asset, asset.storageKey, {
      source: 'sweep',
    });

    expect(result).toBe('PENDING');
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('PENDING');
    expect(row.scanAttempts).toBe(1);
    expect(row.scannedAt).not.toBeNull();
    // Requeued at the first backoff slot, not left due-now.
    expect(row.scanDueAt!.getTime()).toBeGreaterThan(Date.now());
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('stays PENDING when presigning itself fails', async () => {
    const asset = await seedPendingAsset();
    mintGetUrlMock.mockRejectedValueOnce(
      new Error('ASSET_STORAGE_NOT_CONFIGURED'),
    );

    const result = await scanAssetRow(db, asset, asset.storageKey, {
      source: 'sweep',
    });

    expect(result).toBe('PENDING');
    expect(scanUrlMock).not.toHaveBeenCalled();
  });
});
