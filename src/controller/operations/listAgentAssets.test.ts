/**
 * Integration test (US3): listAgentAssets returns the calling user's
 * assets in their per-agent memory, paginated, optionally filtered by
 * MIME, soft-deleted excluded by default.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { listAgentAssets } from './listAgentAssets.js';

let org: { id: string; urn: string };
let user: { id: string };
let otherUser: { id: string };
let agent: { id: string; urn: string };
let app: { id: string };
let memory: { id: string; urn: string };

const resolveTargetMemoryId = vi.fn(async () => ({ memoryId: memory.id }));

async function seedAsset(over: {
  id?: string;
  filename?: string;
  mimeType?: string;
  uploadedBy?: string;
  uploadedAt?: Date;
  deletedAt?: Date | null;
  scanStatus?: 'PENDING' | 'CLEAN' | 'BLOCKED';
}) {
  const id = over.id ?? generateId();
  return db.asset.create({
    data: {
      id,
      memoryId: memory.id,
      filename: over.filename ?? 'file.pdf',
      mimeType: over.mimeType ?? 'application/pdf',
      sizeBytes: 1024,
      storageKey: `asset-org/buno/user/${id}.pdf`,
      scanStatus: over.scanStatus ?? 'CLEAN',
      uploadedAt: over.uploadedAt ?? new Date(),
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
    data: { githubId: 9601, githubUsername: 'list-user', roles: ['READER'] },
  });
  otherUser = await db.user.create({
    data: { githubId: 9602, githubUsername: 'list-other', roles: ['READER'] },
  });
  const sharedUrn = `${org.urn}:buno`;
  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: sharedUrn,
      name: 'Buno',
      type: 'CHATBOT',
      surfaces: ['api'],
    },
  });
  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: sharedUrn,
      name: 'Buno App',
      agentTools: ['asset:upload'],
    },
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
  resolveTargetMemoryId.mockClear();
  resolveTargetMemoryId.mockResolvedValue({ memoryId: memory.id });
});

describe('listAgentAssets', () => {
  it('returns the user\'s assets sorted by uploadedAt DESC', async () => {
    await seedAsset({ filename: 'old.pdf', uploadedAt: new Date(Date.now() - 60_000) });
    await seedAsset({ filename: 'mid.pdf', uploadedAt: new Date(Date.now() - 30_000) });
    await seedAsset({ filename: 'new.pdf', uploadedAt: new Date() });

    const result = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn },
      resolveTargetMemoryId,
    );
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.assets.map((a) => a.filename)).toEqual([
      'new.pdf',
      'mid.pdf',
      'old.pdf',
    ]);
  });

  it('filters by mimeType', async () => {
    await seedAsset({ filename: 'doc.pdf', mimeType: 'application/pdf' });
    await seedAsset({ filename: 'pic.png', mimeType: 'image/png' });
    await seedAsset({ filename: 'pic2.png', mimeType: 'image/png' });

    const result = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn, mimeType: 'image/png' },
      resolveTargetMemoryId,
    );
    expect(result.total).toBe(2);
    expect(result.assets.every((a) => a.mimeType === 'image/png')).toBe(true);
  });

  it('paginates with skip + count', async () => {
    for (let i = 0; i < 25; i++) {
      await seedAsset({
        filename: `f${i}.pdf`,
        uploadedAt: new Date(Date.now() + i * 1000),
      });
    }
    const page1 = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn, skip: 0, count: 10 },
      resolveTargetMemoryId,
    );
    expect(page1.total).toBe(25);
    expect(page1.hasMore).toBe(true);
    expect(page1.assets).toHaveLength(10);

    const page3 = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn, skip: 20, count: 10 },
      resolveTargetMemoryId,
    );
    expect(page3.assets).toHaveLength(5);
    expect(page3.hasMore).toBe(false);
  });

  it('excludes soft-deleted assets by default', async () => {
    await seedAsset({ filename: 'live.pdf' });
    await seedAsset({ filename: 'gone.pdf', deletedAt: new Date() });

    const result = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn },
      resolveTargetMemoryId,
    );
    expect(result.total).toBe(1);
    expect(result.assets[0].filename).toBe('live.pdf');
  });

  it('includes soft-deleted when includeDeleted=true', async () => {
    await seedAsset({ filename: 'live.pdf' });
    await seedAsset({ filename: 'gone.pdf', deletedAt: new Date() });

    const result = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn, includeDeleted: true },
      resolveTargetMemoryId,
    );
    expect(result.total).toBe(2);
  });

  it('only returns the calling user\'s assets (per-user scope)', async () => {
    await seedAsset({ filename: 'mine.pdf', uploadedBy: user.id });
    await seedAsset({ filename: 'theirs.pdf', uploadedBy: otherUser.id });

    const result = await listAgentAssets(
      db,
      { userId: user.id },
      { agentUrn: agent.urn },
      resolveTargetMemoryId,
    );
    expect(result.total).toBe(1);
    expect(result.assets[0].filename).toBe('mine.pdf');
  });

  it('returns TOOL_NOT_ENABLED when the agent\'s App lacks the tool', async () => {
    await db.app.update({ where: { id: app.id }, data: { agentTools: [] } });
    await expect(
      listAgentAssets(
        db,
        { userId: user.id },
        { agentUrn: agent.urn },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_ENABLED' });
  });

  it('returns NOT_FOUND when the agent does not exist', async () => {
    await expect(
      listAgentAssets(
        db,
        { userId: user.id },
        { agentUrn: 'asset-org:does-not-exist' },
        resolveTargetMemoryId,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
