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
    const { code, lines } = await run([]);
    expect(code).toBe(0);
    expect(lines).toEqual([`${TAG}.owner owner=org:${org.id} files=2 bytes=350`, `${TAG} dry_run owners=1 files=2 bytes=350`]);
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
  });

  it('refuses unknown arguments and a missing URL', async () => {
    expect((await run(['--nope'])).code).toBe(2);
    expect(await main([], { env: {}, log: () => {} })).toBe(2);
  });
});
