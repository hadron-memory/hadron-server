/**
 * Integration test: listMemoryAssets — v2 memory-addressed asset
 * listing per spec 006-asset-upload-redesign.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { listMemoryAssets } from './listMemoryAssets.js';

let org: { id: string; urn: string };
let user: { id: string };
let memory: { id: string };

async function makeAsset(overrides: Partial<{
  filename: string;
  mimeType: string;
  uploadedAt: Date;
  scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
  deletedAt: Date | null;
}> = {}): Promise<{ id: string; filename: string }> {
  const a = await db.asset.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      filename: overrides.filename ?? `f-${generateId()}.pdf`,
      mimeType: overrides.mimeType ?? 'application/pdf',
      sizeBytes: 1024,
      storageKey: `key-${generateId()}`,
      scanStatus: overrides.scanStatus ?? 'CLEAN',
      uploadedBy: user.id,
      uploadedAt: overrides.uploadedAt ?? new Date(),
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  return { id: a.id, filename: a.filename };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'list-org', urn: 'list-org' },
  });
  user = await db.user.create({
    data: { githubId: 9501, githubUsername: 'list-user', roles: ['READER'] },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:list-mem`,
      name: 'list-mem',
      class: 'personal',
      visibility: 'PERSONAL',
      userId: user.id,
    },
  });
});

describe('listMemoryAssets', () => {
  it('returns the calling user\'s assets in the memory, newest first', async () => {
    const old = new Date(Date.now() - 60_000);
    const recent = new Date(Date.now() - 1_000);
    await makeAsset({ filename: 'older.pdf', uploadedAt: old });
    await makeAsset({ filename: 'newer.pdf', uploadedAt: recent });

    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id },
    );
    expect(result.total).toBe(2);
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]!.filename).toBe('newer.pdf');
    expect(result.assets[1]!.filename).toBe('older.pdf');
    expect(result.hasMore).toBe(false);
  });

  it('paginates via skip + count and reports hasMore correctly', async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeAsset({
        filename: `f${i}.pdf`,
        uploadedAt: new Date(Date.now() - (5 - i) * 1000),
      });
    }
    const page1 = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id, count: 2 },
    );
    expect(page1.total).toBe(5);
    expect(page1.assets).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id, skip: 4, count: 2 },
    );
    expect(page2.assets).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it('filters by mimeType when provided', async () => {
    await makeAsset({ filename: 'doc.pdf', mimeType: 'application/pdf' });
    await makeAsset({ filename: 'pic.png', mimeType: 'image/png' });

    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id, mimeType: 'image/png' },
    );
    expect(result.total).toBe(1);
    expect(result.assets[0]!.filename).toBe('pic.png');
  });

  it('excludes soft-deleted assets by default; includes when includeDeleted=true', async () => {
    await makeAsset({ filename: 'live.pdf' });
    await makeAsset({ filename: 'gone.pdf', deletedAt: new Date() });

    const defaultResult = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id },
    );
    expect(defaultResult.total).toBe(1);

    const includeDeleted = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id, includeDeleted: true },
    );
    expect(includeDeleted.total).toBe(2);
  });

  it('rejects unknown memory with NOT_FOUND', async () => {
    await expect(
      listMemoryAssets(
        db,
        { userId: user.id },
        { memoryId: 'no-such-memory' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects with PERMISSION_DENIED when caller is not the personal-memory owner', async () => {
    const otherUser = await db.user.create({
      data: { githubId: 9502, githubUsername: 'list-other', roles: ['READER'] },
    });
    await expect(
      listMemoryAssets(
        db,
        { userId: otherUser.id },
        { memoryId: memory.id },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('does not leak another user\'s uploads in the same memory', async () => {
    // Caller's uploads.
    await makeAsset({ filename: 'mine.pdf' });
    // Another user's upload to the same memory.
    const otherUser = await db.user.create({
      data: { githubId: 9503, githubUsername: 'list-other-user', roles: ['READER'] },
    });
    await db.asset.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        filename: 'theirs.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        storageKey: `key-${generateId()}`,
        scanStatus: 'CLEAN',
        uploadedBy: otherUser.id,
      },
    });

    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id },
    );
    expect(result.total).toBe(1);
    expect(result.assets[0]!.filename).toBe('mine.pdf');
  });
});
