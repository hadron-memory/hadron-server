/** #5136: the one-off backfill that soft-deletes the live files of memories deleted before #5124. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { ASSET_RETENTION_WINDOW_MS } from '../../src/lib/asset/retention.js';
import { OWNER_LIMIT_KEYS } from '../../src/lib/ownerLimits/keys.js';
import { runAssetJanitor } from '../../src/jobs/janitorAssets.js';
import { main, BATCH_SIZE } from './backfill-deleted-memory-assets-5136.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const deleteObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../src/integrations/objectstore/index.js', () => ({ deleteObject: deleteObjectMock }));

const TAG = 'db.backfill_deleted_memory_assets_5136';
let org: { id: string };
const mem = (slug: string, deletedAt: Date | null = null) =>
  db.memory.create({ data: { id: generateId(), name: slug, urn: `bf:${slug}`, class: 'knowledge', organizationId: org.id, deletedAt } });
const file = (memoryId: string | null, sizeBytes = 100, over: Record<string, unknown> = {}) =>
  db.asset.create({ data: { id: generateId(), memoryId, filename: 'f', mimeType: 'text/plain', sizeBytes, storageKey: `k/${generateId()}`, scanStatus: 'CLEAN', ...over } as never });
const at = async (id: string) => (await db.asset.findUniqueOrThrow({ where: { id } })).deletedAt;
const run = async (argv: string[], now?: () => Date) => {
  const lines: string[] = [];
  const code = await main(argv, { env: process.env, log: (l) => lines.push(l), now });
  return { code, lines };
};
const used = () => OWNER_LIMIT_KEYS.assetBytes.count(db, { organizationId: org.id });

beforeEach(async () => {
  await cleanDb(db);
  deleteObjectMock.mockClear();
  org = await db.organization.create({ data: { id: generateId(), name: 'bf', urn: 'bf' } });
});

describe('#5136 backfill', () => {
  it('dry run reports count and bytes per owner and writes nothing', async () => {
    const dead = await mem('dead', new Date(Date.now() - 86_400_000 * 30));
    const a = await file(dead.id, 100);
    await file(dead.id, 250, { scanStatus: 'PENDING' });
    await file(dead.id, 999, { scanStatus: 'BLOCKED' });
    const u = await db.user.create({ data: { githubId: 513601, githubUsername: 'bf-u', handle: 'bf-u', roles: ['READER'] } });
    const mine = await db.memory.create({ data: { id: generateId(), name: 'mine', urn: 'bf:mine', class: 'knowledge', ownerUserId: u.id, deletedAt: new Date() } });
    await file(mine.id, 7);
    const { code, lines } = await run([]);
    expect(code).toBe(0);
    expect(lines).toEqual([`${TAG}.owner owner=org:${org.id} files=2 bytes=350`, `${TAG}.owner owner=user:${u.id} files=1 bytes=7`, `${TAG} dry_run owners=2 files=3 bytes=357`]);
    expect(await at(a.id)).toBeNull();
    expect(await used()).toBe(350n);
  });

  it('apply soft-deletes exactly the live files of deleted memories at the run instant; a second apply changes nothing', async () => {
    const old = new Date(Date.now() - 86_400_000 * 30);
    const dead = await mem('dead', old);
    const live = await mem('live');
    const a = await file(dead.id);
    const pending = await file(dead.id, 100, { scanStatus: 'PENDING' });
    const earlier = new Date(Date.now() - 60_000);
    const already = await file(dead.id, 100, { deletedAt: earlier });
    const blocked = await file(dead.id, 100, { scanStatus: 'BLOCKED' });
    const staged = await file(null);
    const kept = await file(live.id);
    const instant = new Date('2026-11-25T06:00:00.000Z');
    const r = await run(['--apply'], () => instant);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe(`${TAG} applied files=2 at=${instant.toISOString()}`);
    expect(await at(a.id)).toEqual(instant);
    expect(await at(pending.id)).toEqual(instant);
    expect(await at(already.id)).toEqual(earlier);
    for (const x of [blocked, staged, kept]) expect(await at(x.id)).toBeNull();
    expect(await used()).toBe(100n);
    const again = await run(['--apply'], () => new Date());
    expect(again.lines).toEqual([`${TAG} applied files=0 at=${again.lines[0]!.split('at=')[1]}`]);
    expect(await at(a.id)).toEqual(instant);
  });

  it('works in bounded batches', async () => {
    const dead = await mem('dead', new Date());
    await db.asset.createMany({ data: Array.from({ length: BATCH_SIZE + 5 }, () =>
      ({ id: generateId(), memoryId: dead.id, filename: 'f', mimeType: 't/p', sizeBytes: 1, storageKey: `k/${generateId()}`, scanStatus: 'CLEAN' as const })) });
    const { lines } = await run(['--apply']);
    expect(lines.filter((l) => l.includes('.batch'))).toEqual([`${TAG}.batch rows=${BATCH_SIZE} total=${BATCH_SIZE}`, `${TAG}.batch rows=5 total=${BATCH_SIZE + 5}`]);
  });

  it('after the window the janitor reclaims the bytes and assetBytes stays drained', async () => {
    const dead = await mem('dead', new Date(Date.now() - 86_400_000 * 30));
    const a = await file(dead.id);
    const instant = new Date();
    await run(['--apply'], () => instant);
    expect((await runAssetJanitor(db, new Date(instant.getTime() + ASSET_RETENTION_WINDOW_MS - 1000))).purged).toBe(0);
    expect((await runAssetJanitor(db, new Date(instant.getTime() + ASSET_RETENTION_WINDOW_MS + 1000))).purged).toBe(1);
    expect(await db.asset.findUnique({ where: { id: a.id } })).toBeNull();
    expect(deleteObjectMock).toHaveBeenCalledOnce();
    expect(deleteObjectMock.mock.calls[0]![0]).toBe(a.storageKey);
    expect(await used()).toBe(0n);
  });

  it('a whole batch that leaves scope between its read and its write writes nothing, and the run still reaches the rows after it', async () => {
    const dead = await mem('dead', new Date());
    const files = await Promise.all(Array.from({ length: BATCH_SIZE + 1 }, () => file(dead.id)));
    let first = true;
    const afterRead = async () => {
      if (!first) return;
      first = false;
      // The same read the script made: its whole first batch is blocked before the write, so that write counts 0 while a row is still in scope after it.
      const batch = await db.asset.findMany({ where: { memoryId: dead.id, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: BATCH_SIZE });
      await db.asset.updateMany({ where: { id: { in: batch.map((r) => r.id) } }, data: { scanStatus: 'BLOCKED' } });
    };
    const lines: string[] = [];
    const code = await main(['--apply'], { env: process.env, log: (l) => lines.push(l), afterRead });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes(`rows=0 total=0 raced=${BATCH_SIZE}`))).toBe(true);
    const stamped = (await Promise.all(files.map((f) => at(f.id)))).filter((d) => d !== null);
    expect(stamped).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/ applied files=1 /);
  });

  it('a memory restored between the batch read and its write keeps its files', async () => {
    const dead = await mem('dead', new Date());
    const restored = await mem('restored', new Date());
    const x = await file(restored.id);
    const y = await file(dead.id);
    let first = true;
    const afterRead = async () => {
      if (!first) return;
      first = false;
      await db.memory.update({ where: { id: restored.id }, data: { deletedAt: null } });
    };
    const lines: string[] = [];
    const code = await main(['--apply'], { env: process.env, log: (l) => lines.push(l), afterRead });
    expect(code).toBe(0);
    expect(await at(x.id)).toBeNull();
    expect(await at(y.id)).not.toBeNull();
    expect(lines.some((l) => l.includes('raced=1'))).toBe(true);
    expect(lines.at(-1)).toMatch(/ applied files=1 /);
  });

  it('a failure reports what was stamped so far, never the message', async () => {
    const dead = await mem('dead', new Date());
    await file(dead.id);
    const lines: string[] = [];
    const code = await main(['--apply'], { env: process.env, log: (l) => lines.push(l), afterRead: async () => { throw Object.assign(new Error('postgresql://secret@host/db'), { code: 'P1001' }); } });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(new RegExp(`^${TAG}\\.failed applied_so_far=0 at=\\S+ error=Error code=P1001$`));
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('refuses unknown arguments and a missing URL', async () => {
    expect((await run(['--nope'])).code).toBe(2);
    expect(await main([], { env: {}, log: () => {} })).toBe(2);
  });
});
