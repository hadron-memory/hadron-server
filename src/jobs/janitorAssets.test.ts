import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ASSET_RETENTION_WINDOW_MS } from '../lib/asset/retention.js';
import { runAssetJanitor } from './janitorAssets.js';

const deleteObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../integrations/r2/client.js', () => ({
  deleteObject: deleteObjectMock,
}));

let org: { id: string; urn: string };
let user: { id: string };
let memory: { id: string; urn: string };

async function seed(over: { deletedAt?: Date | null }) {
  const assetId = generateId();
  return db.asset.create({
    data: {
      id: assetId,
      memoryId: memory.id,
      filename: `${assetId}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: `asset-org/buno/user/${assetId}.pdf`,
      scanStatus: 'CLEAN',
      uploadedBy: user.id,
      deletedAt: over.deletedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);

  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  user = await db.user.create({
    data: { githubId: 10001, githubUsername: 'janitor-user', roles: ['READER'] },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:buno:user:${generateId()}`,
      name: 'user-memory',
      visibility: 'PRIVATE',
    },
  });
});

describe('runAssetJanitor', () => {
  it('purges assets whose deletedAt is past the retention window', async () => {
    const old = await seed({
      deletedAt: new Date(Date.now() - (ASSET_RETENTION_WINDOW_MS + 5_000)),
    });
    const recent = await seed({
      deletedAt: new Date(Date.now() - 60_000), // 1 min ago
    });
    const live = await seed({ deletedAt: null });

    const outcome = await runAssetJanitor(db);
    expect(outcome.scanned).toBe(1);
    expect(outcome.purged).toBe(1);
    expect(outcome.errors).toBe(0);

    expect(deleteObjectMock).toHaveBeenCalledWith(old.storageKey);

    expect(await db.asset.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.asset.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.asset.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it('is a no-op when no assets are past the window', async () => {
    await seed({ deletedAt: null });
    await seed({ deletedAt: new Date(Date.now() - 60_000) });

    const outcome = await runAssetJanitor(db);
    expect(outcome.scanned).toBe(0);
    expect(outcome.purged).toBe(0);
    expect(outcome.errors).toBe(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('records errors but continues when an R2 delete fails', async () => {
    const cutoff = new Date(Date.now() - (ASSET_RETENTION_WINDOW_MS + 5_000));
    const a1 = await seed({ deletedAt: cutoff });
    const a2 = await seed({ deletedAt: cutoff });

    deleteObjectMock
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce(undefined);

    const outcome = await runAssetJanitor(db);
    expect(outcome.scanned).toBe(2);
    expect(outcome.errors).toBe(1);
    expect(outcome.purged).toBe(1);

    // The successful one was hard-deleted; the failed one stays.
    const remaining = await db.asset.findMany({
      where: { id: { in: [a1.id, a2.id] } },
      orderBy: { id: 'asc' },
    });
    expect(remaining).toHaveLength(1);
  });

  it('respects an injected `now` for deterministic testing', async () => {
    const t = new Date('2026-04-29T12:00:00Z');
    // Asset deleted exactly at the window boundary; janitor with `now=t`
    // sees deletedAt at (t - window), so cutoff equals deletedAt and it
    // gets purged (lte semantics).
    await seed({ deletedAt: new Date(t.getTime() - ASSET_RETENTION_WINDOW_MS) });
    const outcome = await runAssetJanitor(db, t);
    expect(outcome.purged).toBe(1);
  });
});
