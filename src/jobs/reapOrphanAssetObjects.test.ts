import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ORPHAN_MIN_AGE_MS } from '../lib/asset/retention.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { ObjectPage } from '../integrations/r2/client.js';
import {
  OrphanSweepAbortedError,
  reapOrphanAssetObjects,
} from './reapOrphanAssetObjects.js';

const deleteObjectMock = vi.hoisted(() => vi.fn());
const listObjectsPageMock = vi.hoisted(() => vi.fn());

vi.mock('../integrations/r2/client.js', () => ({
  deleteObject: deleteObjectMock,
  listObjectsPage: listObjectsPageMock,
  isObjectStoreConfigured: () => true,
}));

const NOW = new Date('2026-08-08T12:00:00Z');
const OLD = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 60_000);
const YOUNG = new Date(NOW.getTime() - 60_000);

let memory: { id: string; urn: string };

/** A single-page listing of the given objects. */
function singlePage(
  objects: Array<{ key: string; size?: number; lastModified?: Date | null }>,
): void {
  listObjectsPageMock.mockResolvedValue({
    objects: objects.map((o) => ({
      key: o.key,
      size: o.size ?? 1024,
      lastModified: o.lastModified === undefined ? OLD : o.lastModified,
    })),
    nextToken: null,
  } satisfies ObjectPage);
}

/** Final-shape key for an asset id, matching buildStorageKey's output. */
function finalKey(assetId: string): string {
  return `asset-org/orphans/${assetId}.pdf`;
}

async function seedAsset(over: { deletedAt?: Date } = {}) {
  const assetId = generateId();
  return db.asset.create({
    data: {
      id: assetId,
      memoryId: memory.id,
      filename: `${assetId}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: finalKey(assetId),
      scanStatus: 'CLEAN',
      deletedAt: over.deletedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  listObjectsPageMock.mockReset();

  const org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:orphans`,
      name: 'orphan-memory',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('reapOrphanAssetObjects', () => {
  it('reaps an aged object with no Asset row and leaves one that has a row', async () => {
    const live = await seedAsset();
    const orphanKey = finalKey(generateId());
    singlePage([{ key: finalKey(live.id) }, { key: orphanKey, size: 4096 }]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.listed).toBe(2);
    expect(outcome.orphans).toBe(1);
    expect(outcome.orphanBytes).toBe(4096);
    expect(outcome.reaped).toBe(1);
    expect(outcome.errors).toBe(0);
    expect(outcome.sample).toEqual([orphanKey]);
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(orphanKey);
  });

  it('deletes nothing in a dry run but still reports what it would delete', async () => {
    const orphanKey = finalKey(generateId());
    singlePage([{ key: orphanKey, size: 2048 }]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: false });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.orphans).toBe(1);
    expect(outcome.orphanBytes).toBe(2048);
    expect(outcome.reaped).toBe(0);
    expect(outcome.sample).toEqual([orphanKey]);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('defaults to a dry run when ASSET_ORPHAN_REAP_ENABLED is not set', async () => {
    const prior = process.env.ASSET_ORPHAN_REAP_ENABLED;
    delete process.env.ASSET_ORPHAN_REAP_ENABLED;
    try {
      singlePage([{ key: finalKey(generateId()) }]);
      const outcome = await reapOrphanAssetObjects({ db, now: NOW });
      expect(outcome.dryRun).toBe(true);
      expect(outcome.reaped).toBe(0);
      expect(deleteObjectMock).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.ASSET_ORPHAN_REAP_ENABLED;
      else process.env.ASSET_ORPHAN_REAP_ENABLED = prior;
    }
  });

  it('never touches an object younger than the age threshold', async () => {
    // Row-less, so it would be an orphan on shape alone — the only thing
    // protecting an in-flight upload is its age.
    singlePage([{ key: finalKey(generateId()), lastModified: YOUNG }]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.tooYoung).toBe(1);
    expect(outcome.orphans).toBe(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('never touches an object whose age the store did not report', async () => {
    singlePage([{ key: finalKey(generateId()), lastModified: null }]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.tooYoung).toBe(1);
    expect(outcome.orphans).toBe(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('leaves a soft-deleted asset alone — it still has a row', async () => {
    const soft = await seedAsset({ deletedAt: new Date(NOW.getTime() - 1000) });
    singlePage([{ key: finalKey(soft.id) }]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.orphans).toBe(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('skips keys that are not a shape this platform writes', async () => {
    singlePage([
      { key: 'backups/hadron-2026-08-08.sql.gz' },
      { key: 'asset-org/orphans/not-a-uuid.pdf' },
      { key: 'toplevel.txt' },
    ]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.unrecognized).toBe(3);
    expect(outcome.orphans).toBe(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('reaps an aged staging object on age alone (no row can vouch for one)', async () => {
    const stagingKey = `staging/asset-org/orphans/${generateId()}.pdf`;
    singlePage([{ key: stagingKey }]);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.orphans).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(stagingKey);
  });

  it('pages through the whole listing', async () => {
    const first = finalKey(generateId());
    const second = finalKey(generateId());
    listObjectsPageMock
      .mockResolvedValueOnce({
        objects: [{ key: first, size: 1, lastModified: OLD }],
        nextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        objects: [{ key: second, size: 1, lastModified: OLD }],
        nextToken: null,
      });

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.listed).toBe(2);
    expect(outcome.reaped).toBe(2);
    expect(listObjectsPageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ continuationToken: 'page-2' }),
    );
  });

  it('aborts instead of treating an unreachable database as "no rows exist"', async () => {
    singlePage([{ key: finalKey(generateId()) }]);
    const brokenDb = {
      asset: { findMany: vi.fn().mockRejectedValue(new Error('connection refused')) },
    } as unknown as PrismaClient;

    await expect(
      reapOrphanAssetObjects({ db: brokenDb, now: NOW, apply: true }),
    ).rejects.toBeInstanceOf(OrphanSweepAbortedError);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('counts a failed delete and continues with the rest of the page', async () => {
    const a = finalKey(generateId());
    const b = finalKey(generateId());
    singlePage([{ key: a }, { key: b }]);
    deleteObjectMock
      .mockRejectedValueOnce(new Error('object store unavailable'))
      .mockResolvedValueOnce(undefined);

    const outcome = await reapOrphanAssetObjects({ db, now: NOW, apply: true });

    expect(outcome.orphans).toBe(2);
    expect(outcome.reaped).toBe(1);
    expect(outcome.errors).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
  });

  it('scopes the listing to the configured prefix', async () => {
    singlePage([]);

    await reapOrphanAssetObjects({ db, now: NOW, prefix: 'assets/' });

    expect(listObjectsPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'assets/' }),
    );
  });
});
