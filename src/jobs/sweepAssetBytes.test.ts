import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ORPHAN_MIN_AGE_MS } from '../lib/asset/retention.js';
import { resetAssetBytesMissingDedupe } from '../lib/asset/bytesMissingAlarm.js';
import {
  AssetBytesSweepAbortedError,
  MAX_EVENTS_PER_RUN,
  sweepAssetBytes,
} from './sweepAssetBytes.js';

const headObjectMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());

vi.mock('../integrations/r2/client.js', () => ({
  headObject: headObjectMock,
  isObjectStoreConfigured: () => true,
}));
vi.mock('@sentry/node', () => ({ captureMessage: captureMock }));

const NOW = new Date('2026-10-23T12:00:00Z');
const OLD = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 60_000);
const YOUNG = new Date(NOW.getTime() - 60_000);

let memory: { id: string };

async function seed(
  over: {
    uploadedAt?: Date;
    scanStatus?: 'CLEAN' | 'PENDING' | 'BLOCKED';
    deletedAt?: Date;
    bytesCheckedAt?: Date;
    memoryId?: string | null;
  } = {},
) {
  const id = generateId();
  return db.asset.create({
    data: {
      id,
      ...(over.memoryId === null ? {} : { memory: { connect: { id: memory.id } } }),
      filename: `${id}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      storageKey: `sweep-org/bytes/${id}.pdf`,
      scanStatus: over.scanStatus ?? 'CLEAN',
      uploadedAt: over.uploadedAt ?? OLD,
      deletedAt: over.deletedAt ?? null,
      bytesCheckedAt: over.bytesCheckedAt ?? null,
    },
  });
}

const alarmedIds = () =>
  captureMock.mock.calls
    .map((c) => c[1]?.extra?.assetId as string | undefined)
    .filter((x): x is string => !!x);

beforeEach(async () => {
  await cleanDb(db);
  headObjectMock.mockReset();
  captureMock.mockReset();
  resetAssetBytesMissingDedupe();
  const org = await db.organization.create({
    data: { id: generateId(), name: 'sweep-org', urn: 'sweep-org' },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:bytes`,
      name: 'bytes-memory',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('sweepAssetBytes: row changes while HEAD is in flight', () => {
  it('does not alarm when a scan verdict BLOCKS the row and purges its bytes', async () => {
    const row = await seed({ scanStatus: 'PENDING' });
    headObjectMock.mockImplementation(async () => {
      await db.asset.update({ where: { id: row.id }, data: { scanStatus: 'BLOCKED' } });
      return { exists: false };
    });

    const out = await sweepAssetBytes({ now: NOW });

    expect(out).toMatchObject({ missing: 0, changed: 1, reported: 0 });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does not alarm when the row is deleted while HEAD is in flight', async () => {
    const row = await seed();
    headObjectMock.mockImplementation(async () => {
      await db.asset.delete({ where: { id: row.id } });
      return { exists: false };
    });

    const out = await sweepAssetBytes({ now: NOW });

    expect(out).toMatchObject({ missing: 0, changed: 1 });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does not alarm when the row is soft-deleted or re-keyed while HEAD is in flight', async () => {
    const a = await seed();
    const b = await seed();
    headObjectMock.mockImplementation(async (key: string) => {
      if (key.includes(a.id)) {
        await db.asset.update({ where: { id: a.id }, data: { deletedAt: NOW } });
      } else {
        await db.asset.update({ where: { id: b.id }, data: { storageKey: 'sweep-org/bytes/other.pdf' } });
      }
      return { exists: false };
    });

    const out = await sweepAssetBytes({ now: NOW });

    expect(out).toMatchObject({ missing: 0, changed: 2 });
    expect(captureMock).not.toHaveBeenCalled();
    expect((await db.asset.findUniqueOrThrow({ where: { id: b.id } })).bytesCheckedAt).toBeNull();
  });
});

describe('sweepAssetBytes', () => {
  it('alarms a row whose object is missing and stays quiet for one that has it', async () => {
    const gone = await seed();
    const here = await seed();
    headObjectMock.mockImplementation(async (key: string) => ({
      exists: key.includes(here.id),
    }));

    const out = await sweepAssetBytes({ now: NOW });

    expect(out).toMatchObject({ examined: 2, present: 1, missing: 1, reported: 1 });
    expect(alarmedIds()).toEqual([gone.id]);
    expect(captureMock.mock.calls[0][1].tags.source).toBe('sweep');
  });

  it('skips young, BLOCKED, soft-deleted and staged rows', async () => {
    await seed({ uploadedAt: YOUNG });
    await seed({ scanStatus: 'BLOCKED' });
    await seed({ deletedAt: NOW });
    await seed({ memoryId: null });
    headObjectMock.mockResolvedValue({ exists: false });

    const out = await sweepAssetBytes({ now: NOW });

    expect(out.examined).toBe(0);
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it('aborts on a store failure without alarming or stamping the failed row', async () => {
    const row = await seed();
    headObjectMock.mockRejectedValue(new Error('503'));

    await expect(sweepAssetBytes({ now: NOW })).rejects.toBeInstanceOf(AssetBytesSweepAbortedError);

    expect(captureMock).not.toHaveBeenCalled();
    const after = await db.asset.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.bytesCheckedAt).toBeNull();
  });

  it('walks the persisted cursor: never-examined first, then least recently, across runs', async () => {
    const stale = await seed({ bytesCheckedAt: new Date('2026-10-01T00:00:00Z') });
    const fresh = await seed({ bytesCheckedAt: new Date('2026-10-20T00:00:00Z') });
    const never = await seed();
    headObjectMock.mockResolvedValue({ exists: true });
    const order: string[] = [];
    headObjectMock.mockImplementation(async (key: string) => {
      order.push(key);
      return { exists: true };
    });

    await sweepAssetBytes({ now: NOW, batchSize: 1 });
    await sweepAssetBytes({ now: NOW, batchSize: 1 });
    await sweepAssetBytes({ now: NOW, batchSize: 1 });

    expect(order.map((k) => k.split('/').pop())).toEqual([
      `${never.id}.pdf`,
      `${stale.id}.pdf`,
      `${fresh.id}.pdf`,
    ]);
  });

  it('caps individual alarms per run and sends one summary for the rest', async () => {
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 3; i++) await seed();
    headObjectMock.mockResolvedValue({ exists: false });

    const out = await sweepAssetBytes({ now: NOW });

    expect(out.missing).toBe(MAX_EVENTS_PER_RUN + 3);
    expect(out.reported).toBe(MAX_EVENTS_PER_RUN);
    expect(captureMock).toHaveBeenCalledTimes(MAX_EVENTS_PER_RUN + 1);
    const summary = captureMock.mock.calls.at(-1)![1];
    expect(summary.extra).toEqual({ total: MAX_EVENTS_PER_RUN + 3, unreported: 3 });
  });

  it('defers an encrypted memory with no cached session key and rotates it', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    const row = await seed();
    // A ciphertext-shaped key cannot be decrypted without the session key.
    await db.asset.update({ where: { id: row.id }, data: { storageKey: 'enc:v1:not-decryptable' } });
    headObjectMock.mockResolvedValue({ exists: false });

    const out = await sweepAssetBytes({ now: NOW });

    expect(out).toMatchObject({ examined: 1, deferred: 1, missing: 0 });
    expect(headObjectMock).not.toHaveBeenCalled();
    const after = await db.asset.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.bytesCheckedAt).toEqual(NOW);
  });
});
