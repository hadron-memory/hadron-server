import { ApolloServer } from '@apollo/server';
import { afterEach, expect, it, vi } from 'vitest';
import { memoryPressurePlugin, readMemoryPressureConfig } from './memoryPressurePlugin.js';

afterEach(() => vi.useRealTimers());
it('logs the allocating in-flight operation at threshold, without query, variables or principal credentials', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const memory = { heapUsed: 1, rss: 1 };
  const log = vi.fn();
  const api = new ApolloServer({
    typeDefs: 'type Query { allocate(secret:String): String }',
    resolvers: { Query: { allocate: async () => { memory.heapUsed = 100; await blocked; return 'ok'; } } },
    plugins: [memoryPressurePlugin({ heapBytes: 100, rssBytes: 200 }, { memory: () => memory, log })],
  });
  await api.start();
  try {
    const contextValue = { userId: 'private-user-id', apiKeyId: 'private-key-id', authorization: 'Bearer secret' };
    const pending = api.executeOperation({ query: 'query NodeLiveRevisionsMinted($secret:String){allocate(secret:$secret)}', variables: { secret: 'hdr_user_NEVER_LOG_ME' } }, { contextValue });
    await vi.waitFor(() => expect(memory.heapUsed).toBe(100));
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledTimes(1);
    const event = JSON.parse(log.mock.calls[0]![0]);
    expect(event).toMatchObject({ event: 'graphql.memory_pressure', heapUsed: 100, inFlight: 1, operations: [{ operationName: 'NodeLiveRevisionsMinted', principal: 'user' }], omitted: 0 });
    expect(log.mock.calls[0]![0]).not.toMatch(/NEVER_LOG_ME|private-user|private-key|Bearer|variables|allocate/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toHaveBeenCalledTimes(1);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ inFlight: 0, operations: [] });
  } finally { release(); await api.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds tracked operations and emitted entries; cleans up overflow and omitted metadata', async () => {
  vi.useFakeTimers();
  let t = 0;
  const log = vi.fn();
  const plugin = memoryPressurePlugin({ heapBytes: 1, rssBytes: 1 }, { memory: () => ({ heapUsed: 1, rss: 1 }), now: () => t, log });
  const listeners: any[] = [];
  for (let i = 0; i < 1005; i++) {
    const listener = await plugin.requestDidStart!({} as any);
    listeners.push(listener);
    await listener!.didResolveOperation!({ operationName: 'not a valid name: secret', contextValue: { appId: 'secret-app' } } as any);
  }
  t = 60_001;
  await listeners[0].willSendResponse();
  const event = JSON.parse(log.mock.calls.at(-1)![0]);
  expect(event.inFlight).toBe(1005);
  expect(event.operations).toHaveLength(20);
  expect(event.omitted).toBe(985);
  expect(event.operations.every((op: any) => op.operationName === null && op.principal === 'app')).toBe(true);
  expect(log.mock.calls.at(-1)![0]).not.toContain('secret');
  for (const listener of listeners.slice(0, 1000)) await listener.willSendResponse();
  t += 60_001;
  const overflow = await plugin.requestDidStart!({} as any);
  await overflow!.willSendResponse!({} as any);
  // The last five requests are counted, but no metadata is retained for them.
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ inFlight: 5, operations: [], omitted: 5 });
  for (const listener of listeners.slice(1000)) await listener.willSendResponse();
  t += 60_001;
  const empty = await plugin.requestDidStart!({} as any);
  await empty!.willSendResponse!({} as any);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ inFlight: 0, operations: [], omitted: 0 });
});

it('a logging failure does not fail a request; RSS alone triggers; config refuses invalid input without echoing it', async () => {
  const log = vi.fn(() => { throw new Error('sink unavailable'); });
  const plugin = memoryPressurePlugin({ heapBytes: 100, rssBytes: 100 }, { memory: () => ({ heapUsed: 1, rss: 101 }), log });
  const listener = await plugin.requestDidStart!({} as any);
  await expect(listener!.didResolveOperation!({ operationName: 'Read', contextValue: {} } as any)).resolves.toBeUndefined();
  await listener!.willSendResponse!({} as any);
  expect(log).toHaveBeenCalledOnce();
  expect(readMemoryPressureConfig({})).toEqual({ heapBytes: 2147483648, rssBytes: 3221225472 });
  expect(() => readMemoryPressureConfig({ GRAPHQL_MEMORY_LOG_HEAP_BYTES: 'hdr_user_secret' })).toThrow('GRAPHQL_MEMORY_LOG_HEAP_BYTES must be a positive integer.');
  expect(readMemoryPressureConfig({ GRAPHQL_MEMORY_LOG_HEAP_BYTES: '123' }).heapBytes).toBe(123);
});
