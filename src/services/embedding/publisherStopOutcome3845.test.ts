import { expect, it, vi } from 'vitest';

const { publish, getBusClient } = vi.hoisted(() => ({
  publish: vi.fn<(...args: unknown[]) => Promise<void>>(),
  getBusClient: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient }));
vi.mock('../../jobs/embedNodes.js', () => ({
  EMBED_WAKE_SUBJECT: 'embed.wake.v1', embeddingDispatcher: vi.fn(), embedNode: vi.fn(),
}));
import { publishEmbedWake, stopEmbeddingPublisherOutcome } from './enqueue.js';

// #3845: the publisher's stop names how it failed, so the graceful stop can log the step.
it('is ok with no publish in flight, grace_timeout when an admitted publish outlives the grace', async () => {
  let release!: () => void;
  publish.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  getBusClient.mockResolvedValue({ publish });
  const pending = publishEmbedWake({});
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(await stopEmbeddingPublisherOutcome(0)).toBe('grace_timeout');
  release();
  await pending;
  expect(await stopEmbeddingPublisherOutcome(0)).toBe('ok');
});
