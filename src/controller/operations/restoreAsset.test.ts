import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ASSET_RETENTION_WINDOW_MS } from '../../lib/asset/retention.js';
import { restoreAsset } from './restoreAsset.js';

const headObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
}));

let org: { id: string; urn: string };
let user: { id: string };
let admin: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let assetId: string;

const isAdminFor = async (_db: unknown, userId: string, _orgId: string) => userId === admin.id;

async function seed(over: { deletedAt?: Date | null; uploadedBy?: string } = {}) {
  assetId = generateId();
  return db.asset.create({
    data: {
      id: assetId,
      memoryId: memory.id,
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: `asset-org/buno/user/${assetId}.pdf`,
      scanStatus: 'CLEAN',
      uploadedBy: over.uploadedBy ?? user.id,
      // Default: soft-deleted just now. Explicit `null` means live;
      // we have to disambiguate from `undefined` (use the default).
      deletedAt: 'deletedAt' in over ? over.deletedAt ?? null : new Date(),
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  headObjectMock.mockReset();
  headObjectMock.mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'application/pdf' });

  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  user = await db.user.create({
    data: { githubId: 9901, githubUsername: 'rs-user', roles: ['READER'] },
  });
  admin = await db.user.create({
    data: { githubId: 9902, githubUsername: 'rs-admin', roles: ['ADMIN'] },
  });
  outsider = await db.user.create({
    data: { githubId: 9903, githubUsername: 'rs-outsider', roles: ['READER'] },
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
});

describe('restoreAsset', () => {
  it('clears deletedAt for an asset within the window', async () => {
    await seed();
    const result = await restoreAsset(
      db,
      { userId: user.id },
      { assetId },
      isAdminFor,
    );
    expect(result.deletedAt).toBeNull();
  });

  it('rejects with ASSET_NOT_DELETED when the asset is already live', async () => {
    await seed({ deletedAt: null });
    await expect(
      restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_DELETED' });
  });

  it('rejects with ASSET_BYTES_GONE past the retention window', async () => {
    const beyondWindow = new Date(Date.now() - (ASSET_RETENTION_WINDOW_MS + 5_000));
    await seed({ deletedAt: beyondWindow });
    await expect(
      restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor),
    ).rejects.toMatchObject({ code: 'ASSET_BYTES_GONE' });
  });

  it('rejects with ASSET_BYTES_GONE when the R2 object is gone', async () => {
    await seed();
    headObjectMock.mockResolvedValueOnce({ exists: false });
    await expect(
      restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor),
    ).rejects.toMatchObject({ code: 'ASSET_BYTES_GONE' });
  });

  it('rejects non-uploader, non-admin callers with PERMISSION_DENIED', async () => {
    await seed({ uploadedBy: user.id });
    await expect(
      restoreAsset(db, { userId: outsider.id }, { assetId }, isAdminFor),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('allows an org admin to restore an asset they did not upload', async () => {
    await seed({ uploadedBy: user.id });
    const result = await restoreAsset(
      db,
      { userId: admin.id },
      { assetId },
      isAdminFor,
    );
    expect(result.deletedAt).toBeNull();
  });

  it('returns NOT_FOUND for unknown asset ids', async () => {
    await expect(
      restoreAsset(db, { userId: user.id }, { assetId: 'nope' }, isAdminFor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
