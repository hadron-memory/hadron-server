import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ASSET_RETENTION_WINDOW_MS, ORPHAN_MIN_AGE_MS } from '../lib/asset/retention.js';
import { resetAssetBytesMissingDedupe, ASSET_BYTES_MISSING_TAG } from '../lib/asset/bytesMissingAlarm.js';
import { AssetRowCheckAbortedError, checkAssetRowObjects } from './checkAssetRowObjects.js';

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', () => ({ captureMessage }));

const headObjectMock = vi.hoisted(() => vi.fn());
vi.mock('../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
  isObjectStoreConfigured: () => true,
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00Z');
const OLD = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 60_000);
const YOUNG = new Date(NOW.getTime() - 60_000);

let org: { id: string; urn: string };
let memory: { id: string };

const keyFor = (assetId: string) => `asset-org/rows/${assetId}.pdf`;

async function seedAsset(
  over: {
    deletedAt?: Date;
    scanStatus?: 'CLEAN' | 'PENDING' | 'BLOCKED';
    uploadedAt?: Date;
    memoryId?: string;
    storageKey?: string;
  } = {},
) {
  const id = generateId();
  return db.asset.create({
    data: {
      id,
      memoryId: over.memoryId ?? memory.id,
      filename: `${id}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: over.storageKey ?? keyFor(id),
      scanStatus: over.scanStatus ?? 'CLEAN',
      deletedAt: over.deletedAt ?? null,
      uploadedAt: over.uploadedAt ?? OLD,
    },
  });
}

const alarmedAssetIds = (): string[] =>
  captureMessage.mock.calls
    .filter(([, ctx]) => ctx.tags?.[ASSET_BYTES_MISSING_TAG] === 'true' && ctx.fingerprint?.length === 2)
    .map(([, ctx]) => ctx.extra.assetId);

beforeEach(async () => {
  await cleanDb(db);
  captureMessage.mockReset();
  headObjectMock.mockReset();
  headObjectMock.mockResolvedValue({ exists: true });
  resetAssetBytesMissingDedupe();

  org = await db.organization.create({ data: { id: generateId(), name: 'asset-org', urn: 'asset-org' } });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:rows`,
      name: 'rows-memory',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('checkAssetRowObjects (#1140 slice B)', () => {
  it('alarms once for a row that claims bytes the store does not have, and stays quiet for one that has them', async () => {
    const gone = await seedAsset();
    const fine = await seedAsset();
    headObjectMock.mockImplementation(async (key: string) => ({ exists: key !== keyFor(gone.id) }));

    const outcome = await checkAssetRowObjects({ db, now: NOW });

    expect(outcome.checked).toBe(2);
    expect(outcome.missing).toBe(1);
    expect(alarmedAssetIds()).toEqual([gone.id]);
    expect(alarmedAssetIds()).not.toContain(fine.id);
    const [, ctx] = captureMessage.mock.calls[0];
    expect(ctx.level).toBe('error');
    expect(ctx.tags.source).toBe('sweep');
  });

  it('reports one event per asset per UTC day across repeated runs', async () => {
    const gone = await seedAsset();
    headObjectMock.mockResolvedValue({ exists: false });

    await checkAssetRowObjects({ db, now: NOW });
    await checkAssetRowObjects({ db, now: new Date(NOW.getTime() + 60_000) });

    expect(alarmedAssetIds()).toEqual([gone.id]);
  });

  it('checks a soft-deleted row still inside its retention window, but not an expired one', async () => {
    const inside = await seedAsset({ deletedAt: new Date(NOW.getTime() - ASSET_RETENTION_WINDOW_MS / 2) });
    const expired = await seedAsset({ deletedAt: new Date(NOW.getTime() - ASSET_RETENTION_WINDOW_MS - 1000) });
    headObjectMock.mockResolvedValue({ exists: false });

    const outcome = await checkAssetRowObjects({ db, now: NOW });

    expect(outcome.checked).toBe(1);
    expect(alarmedAssetIds()).toEqual([inside.id]);
    expect(headObjectMock).not.toHaveBeenCalledWith(keyFor(expired.id));
  });

  it('never checks a BLOCKED tombstone (its bytes are deleted on purpose) or a row too young to judge', async () => {
    await seedAsset({ scanStatus: 'BLOCKED' });
    await seedAsset({ uploadedAt: YOUNG });
    headObjectMock.mockResolvedValue({ exists: false });

    const outcome = await checkAssetRowObjects({ db, now: NOW });

    expect(outcome.checked).toBe(0);
    expect(headObjectMock).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('aborts the run on a store error that is not "not found", reporting nothing false', async () => {
    await seedAsset();
    await seedAsset();
    headObjectMock.mockRejectedValue(new Error('R2 unavailable'));

    await expect(checkAssetRowObjects({ db, now: NOW })).rejects.toBeInstanceOf(AssetRowCheckAbortedError);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('does not alarm for a row that was purged between the list and the miss', async () => {
    const purged = await seedAsset();
    headObjectMock.mockImplementation(async () => {
      await db.asset.delete({ where: { id: purged.id } });
      return { exists: false };
    });

    const outcome = await checkAssetRowObjects({ db, now: NOW });

    expect(outcome.vanished).toBe(1);
    expect(outcome.missing).toBe(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('skips and counts a row of an encrypted memory while no session key is cached, never alarming it', async () => {
    const encMemory = await db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:enc`,
        name: 'enc-memory',
        visibility: 'ORGANIZATION',
        isEncrypted: true,
      },
    });
    await seedAsset({ memoryId: encMemory.id, storageKey: `enc:v1:${generateId()}` });
    headObjectMock.mockResolvedValue({ exists: false });

    const outcome = await checkAssetRowObjects({ db, now: NOW });

    expect(outcome.skippedEncrypted).toBe(1);
    expect(outcome.checked).toBe(0);
    expect(headObjectMock).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('skips a plaintext-shaped leftover key in a locked encrypted memory instead of probing it', async () => {
    const encMemory = await db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:enc-leftover`,
        name: 'enc-leftover-memory',
        visibility: 'ORGANIZATION',
        isEncrypted: true,
      },
    });
    await seedAsset({ memoryId: encMemory.id });
    headObjectMock.mockResolvedValue({ exists: false });

    const outcome = await checkAssetRowObjects({ db, now: NOW });

    expect(outcome.skippedEncrypted).toBe(1);
    expect(outcome.checked).toBe(0);
    expect(headObjectMock).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('caps the events per run and summarises the remainder as one count event', async () => {
    for (let i = 0; i < 5; i += 1) await seedAsset();
    headObjectMock.mockResolvedValue({ exists: false });

    const outcome = await checkAssetRowObjects({ db, now: NOW, maxEvents: 2 });

    expect(outcome.missing).toBe(5);
    expect(alarmedAssetIds()).toHaveLength(2);
    const summary = captureMessage.mock.calls.filter(([, ctx]) => ctx.extra?.suppressed !== undefined);
    expect(summary).toHaveLength(1);
    expect(summary[0][1].extra.suppressed).toBe(3);
    expect(summary[0][1].level).toBe('error');
  });

  it('never checks more than batchSize rows in one run, whatever the ids look like', async () => {
    for (let i = 0; i < 5; i += 1) await seedAsset();

    for (let day = 0; day < 6; day += 1) {
      headObjectMock.mockClear();
      const outcome = await checkAssetRowObjects({ db, now: new Date(NOW.getTime() + day * DAY), batchSize: 2 });
      expect(outcome.checked).toBeLessThanOrEqual(2);
      expect(headObjectMock.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });

  it('covers every row exactly once over consecutive days when the batch bound is smaller than the table', async () => {
    const seeded = await Promise.all(Array.from({ length: 7 }, () => seedAsset()));
    const seen = new Map<string, number>();
    headObjectMock.mockImplementation(async (key: string) => {
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return { exists: true };
    });

    // 7 rows at 3 per run is 3 windows; the clock picks the window, so a restart cannot reset it.
    const slices = 3;
    let total = 0;
    for (let day = 0; day < slices; day += 1) {
      const outcome = await checkAssetRowObjects({
        db,
        now: new Date(NOW.getTime() + day * DAY),
        batchSize: 3,
      });
      total += outcome.checked;
    }

    expect(total).toBe(7);
    for (const a of seeded) expect(seen.get(keyFor(a.id))).toBe(1);
  });
});
