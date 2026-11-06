import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ASSET_RETENTION_WINDOW_MS } from '../../lib/asset/retention.js';
import { restoreAsset } from './restoreAsset.js';
import { resetAssetBytesMissingDedupe } from '../../lib/asset/bytesMissingAlarm.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { isOrgAdminFor as isAdminFor } from '../../api/graphql/schema/resolvers.helpers.js';

const headObjectMock = vi.hoisted(() => vi.fn());
const captureMessage = vi.hoisted(() => vi.fn());

vi.mock('@sentry/node', () => ({ captureMessage }));

vi.mock('../../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
}));

let org: { id: string; urn: string };
let user: { id: string };
let admin: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let assetId: string;

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
  captureMessage.mockReset();
  resetAssetBytesMissingDedupe();
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
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  ] });
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

  it('refuses the former uploader of a carried Asset before probing R2', async () => {
    await seed();
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next restore owner', urn: 'next-restore-asset-owner',
    } });
    await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, orgRef: nextOrg.id,
    }, { db, userId: admin.id, roles: ['ADMIN'] });

    await expect(restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(headObjectMock).not.toHaveBeenCalled();
    expect((await db.asset.findUniqueOrThrow({ where: { id: assetId } })).deletedAt).toBeInstanceOf(Date);
  });

  it('refuses a restore when Memory transfers during the R2 byte check', async () => {
    await seed();
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Concurrent restore owner', urn: 'concurrent-restore-asset-owner',
    } });
    headObjectMock.mockImplementationOnce(async () => {
      await resolvers.Mutation.transferMemoryOwnership(null, {
        memoryRef: memory.id, orgRef: nextOrg.id,
      }, { db, userId: admin.id, roles: ['ADMIN'] });
      return { exists: true, contentLength: 1024, contentType: 'application/pdf' };
    });

    await expect(restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(headObjectMock).toHaveBeenCalledOnce();
    expect((await db.asset.findUniqueOrThrow({ where: { id: assetId } })).deletedAt).toBeInstanceOf(Date);
  });

  it('lets the receiving organization admin restore a carried Asset', async () => {
    await seed();
    const receiverAdmin = await db.user.create({ data: {
      githubId: 9904, githubUsername: 'rs-receiver-admin', roles: ['READER'],
    } });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Receiving restore org', urn: 'receiving-restore-org',
    } });
    await db.orgMember.create({ data: {
      organizationId: nextOrg.id, userId: receiverAdmin.id, role: 'ADMIN',
    } });
    await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, orgRef: nextOrg.id,
    }, { db, userId: admin.id, roles: ['ADMIN'] });

    const result = await restoreAsset(db, { userId: receiverAdmin.id }, { assetId }, isAdminFor);
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
    // Expected, not an inconsistency (#1140): the bytes are meant to be gone.
    expect(captureMessage).not.toHaveBeenCalled();
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it('rejects with ASSET_BYTES_GONE and alarms when a row INSIDE the window has no object', async () => {
    await seed();
    headObjectMock.mockResolvedValueOnce({ exists: false });
    await expect(
      restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor),
    ).rejects.toMatchObject({
      code: 'ASSET_BYTES_GONE',
      message: expect.stringMatching(/missing from storage.*within its retention window/i),
    });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [, ctx] = captureMessage.mock.calls[0];
    expect(ctx.tags['asset.bytes_missing']).toBe('true');
    expect(ctx.fingerprint).toEqual(['asset.bytes_missing', assetId]);
  });

  it('does not alarm when the object is present', async () => {
    await seed();
    await restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('does not alarm when headObject itself fails (a store outage is not a missing object)', async () => {
    await seed();
    headObjectMock.mockRejectedValueOnce(new Error('503 store down'));
    await expect(
      restoreAsset(db, { userId: user.id }, { assetId }, isAdminFor),
    ).rejects.toThrow(/503/);
    expect(captureMessage).not.toHaveBeenCalled();
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
