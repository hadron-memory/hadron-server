import { expect, it, vi } from 'vitest';
import { memoryPressurePlugin } from './memoryPressurePlugin.js';

it('#2758 logs heap capacity and external/buffer bytes from the same RSS-triggering sample', async () => {
  const sample = { heapUsed: 7, heapTotal: 101, external: 203, arrayBuffers: 307, rss: 4096 };
  const memory = vi.fn(() => sample);
  const log = vi.fn();
  const plugin = memoryPressurePlugin({ heapBytes: 1000, rssBytes: 4000 }, { memory, log });
  const request = await plugin.requestDidStart!({} as never);
  await request!.didResolveOperation!({ operationName: 'TeamSessions', contextValue: { userId: 'PRIVATE' } } as never);
  expect(memory).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledTimes(1);
  const event = JSON.parse(log.mock.calls[0]![0]);
  expect(event).toMatchObject({
    event: 'graphql.memory_pressure', heapUsed: 7, heapTotal: 101,
    external: 203, arrayBuffers: 307, rss: 4096, inFlight: 1,
    operations: [{ operationName: 'TeamSessions', principal: 'user' }], omitted: 0,
  });
  expect(Object.keys(event).sort()).toEqual([
    'arrayBuffers', 'event', 'external', 'heapTotal', 'heapUsed',
    'inFlight', 'omitted', 'operations', 'rss',
  ]);
  expect(log.mock.calls[0]![0]).not.toContain('PRIVATE');
  await request!.willSendResponse!({} as never);
  expect(log).toHaveBeenCalledTimes(1); // Existing rate limit still applies.
});
