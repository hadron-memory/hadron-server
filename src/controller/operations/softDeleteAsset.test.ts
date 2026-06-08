import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { softDeleteAsset } from './softDeleteAsset.js';

let org: { id: string; urn: string };
let user: { id: string };
let admin: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let assetId: string;

const isAdminFor = async (_db: unknown, userId: string, _orgId: string) => userId === admin.id;

async function seed(over: { uploadedBy?: string; deletedAt?: Date | null } = {}) {
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
      deletedAt: over.deletedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'asset-org', urn: 'asset-org' },
  });
  user = await db.user.create({
    data: { githubId: 9801, githubUsername: 'sd-user', roles: ['READER'] },
  });
  admin = await db.user.create({
    data: { githubId: 9802, githubUsername: 'sd-admin', roles: ['ADMIN'] },
  });
  outsider = await db.user.create({
    data: { githubId: 9803, githubUsername: 'sd-outsider', roles: ['READER'] },
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

describe('softDeleteAsset', () => {
  it('marks deletedAt for an uploader-owned asset', async () => {
    await seed();
    const result = await softDeleteAsset(
      db,
      { userId: user.id },
      { assetId },
      isAdminFor,
    );
    expect(result.deletedAt).toBeInstanceOf(Date);
  });

  it('allows an org admin to soft-delete an asset they did not upload', async () => {
    await seed({ uploadedBy: user.id });
    const result = await softDeleteAsset(
      db,
      { userId: admin.id },
      { assetId },
      isAdminFor,
    );
    expect(result.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects non-uploader, non-admin callers with PERMISSION_DENIED', async () => {
    await seed({ uploadedBy: user.id });
    await expect(
      softDeleteAsset(
        db,
        { userId: outsider.id },
        { assetId },
        isAdminFor,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects already-deleted assets with NOT_FOUND', async () => {
    await seed({ deletedAt: new Date() });
    await expect(
      softDeleteAsset(db, { userId: user.id }, { assetId }, isAdminFor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects unknown asset ids with NOT_FOUND', async () => {
    await expect(
      softDeleteAsset(db, { userId: user.id }, { assetId: 'nope' }, isAdminFor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
