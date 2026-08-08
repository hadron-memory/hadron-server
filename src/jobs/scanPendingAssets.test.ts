/**
 * runAssetScanSweep — the retry path for rows the inline scan could
 * not settle (#896). Covers: unconfigured no-op, verdict application,
 * exponential-backoff deferral, and the encrypted-memory
 * no-session-key deferral (which must NOT burn an attempt).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import {
  runAssetScanSweep,
  nextDueAt,
  SCAN_RETRY_BASE_MS,
  SCAN_RETRY_MAX_MS,
} from './scanPendingAssets.js';

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

async function seedPending(over: {
  scanAttempts?: number;
  scannedAt?: Date | null;
  memoryId?: string;
  storageKey?: string;
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
      scanStatus: 'PENDING',
      scanAttempts: over.scanAttempts ?? 0,
      scannedAt: over.scannedAt ?? null,
      uploadedBy: user.id,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  mintGetUrlMock.mockClear();
  deleteObjectMock.mockClear();
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

describe('nextDueAt', () => {
  it('doubles per attempt and caps at the ceiling', () => {
    const at = new Date('2026-08-08T00:00:00Z');
    expect(nextDueAt(at, 1).getTime() - at.getTime()).toBe(SCAN_RETRY_BASE_MS);
    expect(nextDueAt(at, 2).getTime() - at.getTime()).toBe(
      SCAN_RETRY_BASE_MS * 2,
    );
    expect(nextDueAt(at, 30).getTime() - at.getTime()).toBe(SCAN_RETRY_MAX_MS);
  });
});

describe('runAssetScanSweep', () => {
  it('no-ops when the scan tool is not configured', async () => {
    isScanConfiguredMock.mockReturnValue(false);
    await seedPending({});
    const out = await runAssetScanSweep(db);
    expect(out.skipped).toBe(true);
    expect(scanUrlMock).not.toHaveBeenCalled();
  });

  it('flips a due PENDING row to CLEAN', async () => {
    const asset = await seedPending({});
    scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

    const out = await runAssetScanSweep(db);

    expect(out.cleaned).toBe(1);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('CLEAN');
  });

  it('flips an infected row to BLOCKED and deletes its object', async () => {
    const asset = await seedPending({});
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'infected',
      signature: 'Eicar-Signature',
    });

    const out = await runAssetScanSweep(db);

    expect(out.blocked).toBe(1);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('BLOCKED');
    expect(row.scanSignature).toBe('Eicar-Signature');
    expect(deleteObjectMock).toHaveBeenCalledWith(asset.storageKey);
  });

  it('defers a row still inside its backoff window without calling the tool', async () => {
    const now = new Date();
    // Attempt 1 ran a minute ago; first backoff is 5 minutes.
    await seedPending({
      scanAttempts: 1,
      scannedAt: new Date(now.getTime() - 60 * 1000),
    });

    const out = await runAssetScanSweep(db, now);

    expect(out.deferred).toBe(1);
    expect(out.inconclusive).toBe(0);
    expect(scanUrlMock).not.toHaveBeenCalled();
  });

  it('retries a row whose backoff has elapsed', async () => {
    const now = new Date();
    await seedPending({
      scanAttempts: 1,
      scannedAt: new Date(now.getTime() - SCAN_RETRY_BASE_MS - 1000),
    });
    scanUrlMock.mockResolvedValueOnce({ verdict: 'clean' });

    const out = await runAssetScanSweep(db, now);

    expect(out.cleaned).toBe(1);
  });

  it('counts an unavailable verdict as inconclusive and keeps the row PENDING', async () => {
    const asset = await seedPending({});
    scanUrlMock.mockResolvedValueOnce({
      verdict: 'unavailable',
      reason: 'tool down',
    });

    const out = await runAssetScanSweep(db);

    expect(out.inconclusive).toBe(1);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('PENDING');
    expect(row.scanAttempts).toBe(1);
  });

  it('defers encrypted-memory rows with no cached session key without burning an attempt', async () => {
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
    const asset = await seedPending({
      memoryId: encMemory.id,
      storageKey: 'enc:v1:ciphertext-storage-key',
    });

    const out = await runAssetScanSweep(db);

    expect(out.deferred).toBe(1);
    expect(scanUrlMock).not.toHaveBeenCalled();
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.scanStatus).toBe('PENDING');
    expect(row.scanAttempts).toBe(0);
  });

  it('never touches soft-deleted or already-settled rows', async () => {
    await db.asset.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        filename: 'settled.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: `scan-org/mem/${generateId()}.pdf`,
        scanStatus: 'CLEAN',
        uploadedBy: user.id,
      },
    });
    const softDeleted = await seedPending({});
    await db.asset.update({
      where: { id: softDeleted.id },
      data: { deletedAt: new Date() },
    });

    const out = await runAssetScanSweep(db);

    expect(out.examined).toBe(0);
    expect(scanUrlMock).not.toHaveBeenCalled();
  });
});
