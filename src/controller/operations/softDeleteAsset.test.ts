import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { softDeleteAsset } from './softDeleteAsset.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { isOrgAdminFor as isAdminFor } from '../../api/graphql/schema/resolvers.helpers.js';
import type { Prisma } from '../../generated/prisma/index.js';

let org: { id: string; urn: string };
let user: { id: string };
let admin: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let assetId: string;

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

  it('refuses the former uploader of a carried Asset after Memory transfer', async () => {
    await seed();
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next delete owner', urn: 'next-delete-asset-owner',
    } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            transferred = true;
            await resolvers.Mutation.transferMemoryOwnership(null, {
              memoryRef: memory.id, orgRef: nextOrg.id,
            }, { db, userId: admin.id, roles: ['ADMIN'] });
            return transaction(work as never);
          };
        }
        return Reflect.get(target, key);
      },
    });

    await expect(softDeleteAsset(raceDb, { userId: user.id }, { assetId }, isAdminFor))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(transferred).toBe(true);
    expect((await db.asset.findUniqueOrThrow({ where: { id: assetId } })).deletedAt).toBeNull();
  });

  it('holds transfer behind the final Asset write transaction', async () => {
    await seed();
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Concurrent delete owner', urn: 'concurrent-delete-asset-owner',
    } });
    let reachedFinalWrite!: () => void;
    let releaseWriter!: () => void;
    const atFinalWrite = new Promise<void>((resolve) => { reachedFinalWrite = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => transaction(async (tx) => {
            const result = await (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
            reachedFinalWrite();
            await release;
            return result;
          });
        }
        return Reflect.get(target, key);
      },
    });
    const writer = softDeleteAsset(raceDb, { userId: user.id }, { assetId }, isAdminFor);
    await atFinalWrite;
    let transferCommitted = false;
    const transfer = resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, orgRef: nextOrg.id,
    }, { db, userId: admin.id, roles: ['ADMIN'] }).then(() => { transferCommitted = true; });
    try {
      // The transfer must wait on the Memory FOR SHARE lock even after the
      // Asset's authorization and update have both completed inside the tx.
      await db.$executeRaw`SELECT pg_sleep(0.05)`;
      expect(transferCommitted).toBe(false);
    } finally {
      releaseWriter();
      await writer;
      await transfer;
    }
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).organizationId).toBe(nextOrg.id);
    expect((await db.asset.findUniqueOrThrow({ where: { id: assetId } })).deletedAt).toBeInstanceOf(Date);
  });

  it('uses the receiving organization for the admin grant after transfer', async () => {
    await seed();
    const receiverAdmin = await db.user.create({ data: {
      githubId: 9804, githubUsername: 'sd-receiver-admin', roles: ['READER'],
    } });
    const formerAdmin = await db.user.create({ data: {
      githubId: 9805, githubUsername: 'sd-former-admin', roles: ['READER'],
    } });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Receiving delete org', urn: 'receiving-delete-org',
    } });
    await db.orgMember.createMany({ data: [
      { organizationId: org.id, userId: formerAdmin.id, role: 'ADMIN' },
      { organizationId: nextOrg.id, userId: receiverAdmin.id, role: 'ADMIN' },
    ] });
    await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, orgRef: nextOrg.id,
    }, { db, userId: admin.id, roles: ['ADMIN'] });

    await expect(softDeleteAsset(db, { userId: formerAdmin.id }, { assetId }, isAdminFor))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const result = await softDeleteAsset(db, { userId: receiverAdmin.id }, { assetId }, isAdminFor);
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
