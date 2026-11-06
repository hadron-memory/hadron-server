import { expect, it, vi } from 'vitest';

const { publish, getBusClient } = vi.hoisted(() => ({
  publish: vi.fn<(...args: unknown[]) => Promise<void>>(),
  getBusClient: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient }));
vi.mock('../../jobs/embedNodes.js', () => ({
  EMBED_WAKE_SUBJECT: 'embed.wake.v1', embeddingDispatcher: vi.fn(), embedNode: vi.fn(),
}));
import { publishEmbedWake, stopEmbeddingPublisher } from './enqueue.js';

it('internal#4 coalesces a burst to one in-flight publish plus one dirty bit, then closes boundedly', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  publish.mockImplementationOnce(() => held).mockResolvedValue(undefined);
  getBusClient.mockResolvedValue({ publish });
  const first = publishEmbedWake({ nodeId: 'first' });
  for (let i = 0; i < 1_000; i++) expect(publishEmbedWake({ nodeId: `discarded-${i}` })).toBe(first);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  expect(getBusClient).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]).toEqual(['embed.wake.v1', {}, { idempotencyKey: expect.any(String) }]);
  release();
  await first;
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

  let releaseShutdown!: () => void;
  // Wait for the already admitted coalesced publish to retire before starting the shutdown probe.
  await publishEmbedWake({});
  await new Promise<void>(resolve => setImmediate(resolve));
  publish.mockImplementationOnce(() => new Promise<void>(resolve => { releaseShutdown = resolve; }));
  const pending = publishEmbedWake({ nodeId: 'shutdown' });
  await vi.waitFor(() => expect(releaseShutdown).toBeTypeOf('function'));
  expect(await stopEmbeddingPublisher(0)).toBe(false);
  const admitted = publish.mock.calls.length;
  await publishEmbedWake({ nodeId: 'after-close' });
  expect(publish).toHaveBeenCalledTimes(admitted);
  releaseShutdown();
  await pending;
  expect(await stopEmbeddingPublisher(0)).toBe(true);
  expect(publish).toHaveBeenCalledTimes(admitted);
});
