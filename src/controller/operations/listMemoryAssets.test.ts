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
  // 008: personal-class memory requires app_id (chk_memory_class_app_id). Seed
  // a minimal Agent + App so the personal memory has somewhere to pivot from.
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:list-agent`, name: 'list-agent' },
  });
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:list-app`,
      name: 'list-app',
      appAgents: { create: { agentId: agent.id } },
    },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:list-mem`,
      name: 'list-mem',
      class: 'personal',
      visibility: null,
      userId: user.id,
      appId: app.id,
      // 023 FR-004/FR-032: chk_memory_personal_agent_id requires the
      // (App, Agent, User) scope to be complete.
      userMemoryOfAgentId: agent.id,
    },
  });
});

describe('listMemoryAssets', () => {
  it('returns the calling user\'s assets in the memory, newest first (input by ID)', async () => {
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

  // 007-entity-id-or-urn: paired URN-input case — same memory, same
  // result. Asserts identical effect for the two input shapes.
  it('returns the calling user\'s assets in the memory (input by URN)', async () => {
    await makeAsset({ filename: 'one.pdf' });
    await makeAsset({ filename: 'two.pdf' });

    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: memory.id },
      select: { urn: true },
    });
    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memoryRow.urn },
    );
    expect(result.total).toBe(2);
    expect(result.assets).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('returns the calling user\'s assets in the memory (input by prefixed URN)', async () => {
    await makeAsset({ filename: 'one.pdf' });

    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: memory.id },
      select: { urn: true },
    });
    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: `urn:memory:${memoryRow.urn}` },
    );
    expect(result.total).toBe(1);
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

  // ── The gate is the memory's read access; `mine` is only a filter ──

  it("lists another user's uploads in the same readable memory", async () => {
    // An Asset is bound to a Memory (cor:dmo:060:10) — whoever may read
    // the memory may see the files attached to it. Spec 004 also
    // filtered `uploadedBy = caller`, which hid a colleague's file in a
    // shared memory; that filter is now opt-in via `mine`.
    await makeAsset({ filename: 'mine.pdf' });
    await seedOtherUsersAsset('theirs.pdf');

    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id },
    );
    expect(result.total).toBe(2);
    expect(result.assets.map((a) => a.filename).sort()).toEqual([
      'mine.pdf',
      'theirs.pdf',
    ]);
  });

  it('narrows to the caller\'s own uploads with mine: true', async () => {
    await makeAsset({ filename: 'mine.pdf' });
    await seedOtherUsersAsset('theirs.pdf');

    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id, mine: true },
    );
    expect(result.total).toBe(1);
    expect(result.assets[0]!.filename).toBe('mine.pdf');
  });

  it('lists run-created assets (uploadedBy NULL)', async () => {
    // hadron_store_file writes uploadedBy: null; the old
    // `uploadedBy = caller` filter made those invisible to everyone.
    await db.asset.create({
      data: {
        id: generateId(),
        memoryId: memory.id,
        filename: 'run-output.csv',
        mimeType: 'text/csv',
        sizeBytes: 512,
        storageKey: `key-${generateId()}`,
        scanStatus: 'CLEAN',
        uploadedBy: null,
      },
    });

    const result = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id },
    );
    expect(result.total).toBe(1);
    expect(result.assets[0]!.filename).toBe('run-output.csv');

    // ...but `mine` still excludes them — NULL is not the caller.
    const mine = await listMemoryAssets(
      db,
      { userId: user.id },
      { memoryId: memory.id, mine: true },
    );
    expect(mine.total).toBe(0);
  });
});

/** Seed an asset in the shared memory uploaded by somebody else. */
async function seedOtherUsersAsset(filename: string) {
  const otherUser = await db.user.create({
    data: {
      githubId: 9503 + filename.length,
      githubUsername: `list-other-${filename.replace(/\W/g, '')}`,
      roles: ['READER'],
    },
  });
  return db.asset.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      filename,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: `key-${generateId()}`,
      scanStatus: 'CLEAN',
      uploadedBy: otherUser.id,
    },
  });
}
