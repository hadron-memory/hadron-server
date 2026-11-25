/**
 * #5124 (follow-up (b) of #5017's re-gate; cor:dmo:060:13, cor:acl:150:02): deleting a memory soft-deletes its files in the same
 * transaction and at the same instant, on every memory-delete path (deleteMemory, an Agent's system memory on deleteAgent, the source of
 * a merge that deletes it), so the retention janitor reclaims their bytes and rows after the window and `assetBytes` drains.
 *
 * Red on main: each path leaves the files live, so the count keeps them and the janitor never takes them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ASSET_RETENTION_WINDOW_MS } from '../../lib/asset/retention.js';
import { OWNER_LIMIT_KEYS } from '../../lib/ownerLimits/keys.js';
import { runAssetJanitor } from '../../jobs/janitorAssets.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

const deleteObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../integrations/objectstore/index.js', () => ({ deleteObject: deleteObjectMock }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string };

const ctx = (userId: string, over: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...over }) as Context;
const orgMemory = (slug: string) =>
  db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
const file = (memoryId: string, sizeBytes = 1000, over: Record<string, unknown> = {}) =>
  db.asset.create({
    data: { id: generateId(), memoryId, filename: 'f.pdf', mimeType: 'application/pdf', sizeBytes, storageKey: `k/${generateId()}.pdf`, scanStatus: 'CLEAN', ...over } as never,
  });
const used = () => OWNER_LIMIT_KEYS.assetBytes.count(db, { organizationId: org.id });
const deletedAtOf = async (id: string) => (await db.asset.findUniqueOrThrow({ where: { id } })).deletedAt;
const memoryDeletedAt = async (id: string) => (await db.memory.findUniqueOrThrow({ where: { id } })).deletedAt;

beforeEach(async () => {
  await cleanDb(db);
  deleteObjectMock.mockClear();
  org = await db.organization.create({ data: { id: generateId(), name: 'md-org', urn: 'md-org' } });
  admin = await db.user.create({ data: { githubId: 512401, githubUsername: 'md-admin', handle: 'md-admin', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await orgMemory('files');
});

describe('#5124 deleteMemory', () => {
  it('soft-deletes the memory\'s live files at the memory\'s own instant; a file already deleted keeps its instant; the count drains', async () => {
    const a = await file(memory.id, 1000);
    const b = await file(memory.id, 2000, { scanStatus: 'PENDING' });
    const earlier = new Date(Date.now() - 60_000);
    const c = await file(memory.id, 4000, { deletedAt: earlier });
    expect(await used()).toBe(3000n);
    await M.deleteMemory({}, { ref: memory.id }, ctx(admin.id));
    const at = await memoryDeletedAt(memory.id);
    expect(at).not.toBeNull();
    expect(await deletedAtOf(a.id)).toEqual(at);
    expect(await deletedAtOf(b.id)).toEqual(at);
    expect(await deletedAtOf(c.id)).toEqual(earlier);
    expect(await used()).toBe(0n);
  });

  it('after the retention window the janitor reclaims the bytes and then the rows', async () => {
    const a = await file(memory.id);
    await M.deleteMemory({}, { ref: memory.id }, ctx(admin.id));
    const at = (await memoryDeletedAt(memory.id))!;
    expect((await runAssetJanitor(db, new Date(at.getTime() + ASSET_RETENTION_WINDOW_MS - 1000))).purged).toBe(0);
    expect((await runAssetJanitor(db, new Date(at.getTime() + ASSET_RETENTION_WINDOW_MS + 1000))).purged).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledOnce();
    expect(await db.asset.findUnique({ where: { id: a.id } })).toBeNull();
  });

  it('a re-delete changes nothing, and a file added to another memory is untouched', async () => {
    const other = await orgMemory('other');
    const keep = await file(other.id);
    await file(memory.id);
    await M.deleteMemory({}, { ref: memory.id }, ctx(admin.id));
    const at = await memoryDeletedAt(memory.id);
    await M.deleteMemory({}, { ref: memory.id }, ctx(admin.id));
    expect(await memoryDeletedAt(memory.id)).toEqual(at);
    expect(await deletedAtOf(keep.id)).toBeNull();
  });

  it('the files and the memory are one transaction: when the file soft delete fails, the memory is not deleted either', async () => {
    const a = await file(memory.id);
    const failing = db.$extends({ query: { asset: { updateMany() { throw new Error('fixture-asset-fault-5124'); } } } });
    await expect(M.deleteMemory({}, { ref: memory.id }, ctx(admin.id, { db: failing as unknown as Context['db'] }))).rejects.toThrow('fixture-asset-fault-5124');
    expect(await memoryDeletedAt(memory.id)).toBeNull();
    expect(await deletedAtOf(a.id)).toBeNull();
  });
});

describe('#5124 deleteAgent: the Agent\'s system memory', () => {
  it('soft-deletes the system memory\'s files at the system memory\'s instant', async () => {
    const agent = await M.createAgent({}, { orgRef: org.id, name: 'md-agent' }, ctx(admin.id));
    const row = await db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { systemMemoryId: true } });
    expect(row.systemMemoryId).toBeTruthy();
    const a = await file(row.systemMemoryId!);
    await M.deleteAgent({}, { ref: agent.id }, ctx(admin.id));
    const at = await memoryDeletedAt(row.systemMemoryId!);
    expect(at).not.toBeNull();
    expect(await deletedAtOf(a.id)).toEqual(at);
  });
});

describe('#5124 mergeMemories with deleteSourceMem', () => {
  it('soft-deletes the source memory\'s files with it (a merge moves no files); the target\'s files are untouched', async () => {
    const target = await orgMemory('target');
    const src = await file(memory.id);
    const tgt = await file(target.id);
    await M.mergeMemories({}, { input: { source: memory.id, target: target.id, deleteSourceMem: true } }, ctx(admin.id));
    const at = await memoryDeletedAt(memory.id);
    expect(at).not.toBeNull();
    expect(await deletedAtOf(src.id)).toEqual(at);
    expect(await deletedAtOf(tgt.id)).toBeNull();
  });

  it('without deleteSourceMem the source and its files stay live', async () => {
    const target = await orgMemory('target2');
    const src = await file(memory.id);
    await M.mergeMemories({}, { input: { source: memory.id, target: target.id } }, ctx(admin.id));
    expect(await memoryDeletedAt(memory.id)).toBeNull();
    expect(await deletedAtOf(src.id)).toBeNull();
  });
});
