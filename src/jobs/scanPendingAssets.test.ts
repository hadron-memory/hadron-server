/**
 * runAssetScanSweep — the retry path for rows the inline scan could
 * not settle (#896). Queue semantics per the PR-908 review hardening:
 * `scanDueAt` is the queue (due rows only, SQL-selected), every touch
 * pushes the stamp forward (no starvation), BLOCKED rows get purge
 * retries, and encrypted-no-key deferral burns no attempt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runAssetScanSweep, ENCRYPTED_RECHECK_MS } from './scanPendingAssets.js';
import { PURGE_RETRY_MS } from '../lib/asset/scan.js';

const mintGetUrlMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue('https://bucket/presigned-get'),
);
const deleteObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../integrations/r2/client.js', () => ({
  mintGetUrl: mintGetUrlMock,
  deleteObject: deleteObjectMock,
}));

const scanUrlMock = vi.hoisted(() => vi.fn());
const isScanConfiguredMock = vi.hoisted(() => vi.fn().mockReturnValue(true));
vi.mock('../lib/scanClient.js', () => ({
  scanUrl: scanUrlMock,
  isScanConfigured: isScanConfiguredMock,
}));

let org: { id: string; urn: string };
let user: { id: string };
let memory: { id: string };

async function seedAsset(over: {
  scanStatus?: 'PENDING' | 'CLEAN' | 'BLOCKED';
  scanAttempts?: number;
  scanDueAt?: Date | null;
  memoryId?: string;
  storageKey?: string;
  deletedAt?: Date;
}) {
  const id = generateId();
  return db.asset.create({
    data: {
      id,
      memoryId: over.memoryId ?? memory.id,
      filename: `${id}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: over.storageKey ?? `scan-org/mem/${id}.pdf`,
      scanStatus: over.scanStatus ?? 'PENDING',
      scanAttempts: over.scanAttempts ?? 0,
      scanDueAt: over.scanDueAt === undefined ? new Date() : over.scanDueAt,
      uploadedBy: user.id,
      deletedAt: over.deletedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  mintGetUrlMock.mockClear();
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  scanUrlMock.mockReset();
  isScanConfiguredMock.mockReturnValue(true);

  org = await db.organization.create({
    data: { id: generateId(), name: 'scan-org', urn: 'scan-org' },
  });
  user = await db.user.create({
    data: { githubId: 12001, githubUsername: 'sweep-user', roles: ['READER'] },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:buno:user:${generateId()}`,
      name: 'sweep-memory',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('runAssetScanSweep', () => {
  it('no-ops when the scan tool is not configured', async () => {
    isScanConfiguredMock.mockReturnValue(false);
    await seedAsset({});
    const out = await runAssetScanSweep(db);
    expect(out.skipped).toBe(true);
    expect(scanUrlMock).not.toHaveBeenCalled();
  });

  it('flips a due PENDING row to CLEAN and clears its due stamp', async () => {
    const asset = await seedAsset({});
    scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

    const out = await runAssetScanSweep(db);

    expect(out.cleaned).toBe(1);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('CLEAN');
    expect(row.scanDueAt).toBeNull();
  });

  it('flips an infected row to BLOCKED, deletes its object, clears the stamp', async () => {
    const asset = await seedAsset({});
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'infected',
      signature: 'Eicar-Signature',
    });

    const out = await runAssetScanSweep(db);

    expect(out.blocked).toBe(1);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanSignature).toBe('Eicar-Signature');
    expect(row.scanDueAt).toBeNull(); // purge succeeded — nothing left to do
    expect(deleteObjectMock).toHaveBeenCalledWith(asset.storageKey);
  });

  it('does not select rows whose due stamp is in the future', async () => {
    await seedAsset({ scanDueAt: new Date(Date.now() + 60 * 60 * 1000) });

    const out = await runAssetScanSweep(db);

    expect(out.examined).toBe(0);
    expect(scanUrlMock).not.toHaveBeenCalled();
  });

  it('pushes the due stamp to the backoff slot on an unavailable verdict', async () => {
    const now = new Date();
    const asset = await seedAsset({ scanAttempts: 1, scanDueAt: now });
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'unavailable',
      reason: 'tool down',
    });

    const out = await runAssetScanSweep(db, now);

    expect(out.inconclusive).toBe(1);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('PENDING');
    expect(row.scanAttempts).toBe(2);
    // Attempt 2 → 10min backoff; the row cannot re-head the next batch.
    expect(row.scanDueAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('restamps encrypted-no-key rows for recheck without burning an attempt', async () => {
    const encMemory = await db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:buno:enc:${generateId()}`,
        name: 'encrypted-memory',
        visibility: 'ORGANIZATION',
        isEncrypted: true,
      },
    });
    const now = new Date();
    const asset = await seedAsset({
      memoryId: encMemory.id,
      storageKey: 'enc:v1:ciphertext-storage-key',
      scanDueAt: now,
    });

    const out = await runAssetScanSweep(db, now);

    expect(out.deferred).toBe(1);
    expect(scanUrlMock).not.toHaveBeenCalled();
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('PENDING');
    expect(row.scanAttempts).toBe(0);
    // The starvation fix: the stamp moved forward, so this row rotates
    // behind other due work instead of re-heading every batch.
    expect(row.scanDueAt!.getTime()).toBe(now.getTime() + ENCRYPTED_RECHECK_MS);
  });

  it('retries the purge for a due BLOCKED row and clears the stamp on success', async () => {
    const asset = await seedAsset({ scanStatus: 'BLOCKED', scanDueAt: new Date() });

    const out = await runAssetScanSweep(db);

    expect(out.purged).toBe(1);
    expect(scanUrlMock).not.toHaveBeenCalled(); // verdict settled; bytes only
    expect(deleteObjectMock).toHaveBeenCalledWith(asset.storageKey);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanDueAt).toBeNull();
  });

  it('restamps a BLOCKED purge retry that fails again', async () => {
    const now = new Date();
    const asset = await seedAsset({ scanStatus: 'BLOCKED', scanDueAt: now });
    deleteObjectMock.mockRejectedValueOnce(new Error('store down'));

    const out = await runAssetScanSweep(db, now);

    expect(out.purged).toBe(0);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanDueAt!.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + PURGE_RETRY_MS - 1000,
    );
  });

  it('never touches settled, undue, or soft-deleted rows', async () => {
    await seedAsset({ scanStatus: 'CLEAN', scanDueAt: null });
    await seedAsset({ scanStatus: 'BLOCKED', scanDueAt: null }); // bytes gone
    await seedAsset({ deletedAt: new Date() });

    const out = await runAssetScanSweep(db);

    expect(out.examined).toBe(0);
    expect(scanUrlMock).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});
