/**
 * #3845: the embedding worker's stop names HOW it failed (`jobs_unsettled`, `bus_stop_rejected`, `grace_timeout`), so the
 * graceful stop in src/index.ts can log the failing step. The boolean `stopEmbeddingWorker` keeps its old meaning.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';

const { subscribeQueue } = vi.hoisted(() => ({ subscribeQueue: vi.fn() }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => ({ subscribeQueue, publish: vi.fn() })) }));

// The dispatcher is process-wide and stays closed once stopped, so each test loads a fresh module.
let m: typeof import('./embedNodes.js');
let db: PrismaClient;
beforeEach(async () => {
  vi.resetModules();
  m = await import('./embedNodes.js');
  db = {} as unknown as PrismaClient;
  subscribeQueue.mockReset();
});

describe('#3845 stopEmbeddingWorkerOutcome', () => {
  it('is ok when nothing is running', async () => {
    expect(await m.stopEmbeddingWorkerOutcome(db, 50)).toBe('ok');
  });

  it('names a rejected bus stop', async () => {
    subscribeQueue.mockResolvedValue(async () => { throw new Error('secret https://broker.example/token'); });
    await m.startEmbeddingBusListener(db);
    expect(await m.stopEmbeddingWorkerOutcome(db, 50)).toBe('bus_stop_rejected');
  });

  it('names a bus stop that outlives the grace', async () => {
    subscribeQueue.mockResolvedValue(() => new Promise<void>(() => undefined));
    await m.startEmbeddingBusListener(db);
    expect(await m.stopEmbeddingWorkerOutcome(db, 20)).toBe('grace_timeout');
  });

  it('names in-flight jobs that did not settle', async () => {
    vi.spyOn(m.embeddingDispatcher(db), 'stop').mockResolvedValue(false);
    expect(await m.stopEmbeddingWorkerOutcome(db, 50)).toBe('jobs_unsettled');
  });

  it('keeps the boolean wrapper: false on a failure, true when clean', async () => {
    subscribeQueue.mockResolvedValue(async () => { throw new Error('x'); });
    await m.startEmbeddingBusListener(db);
    expect(await m.stopEmbeddingWorker(db, 50)).toBe(false);
    expect(await m.stopEmbeddingWorker(db, 50)).toBe(true);
  });
});
