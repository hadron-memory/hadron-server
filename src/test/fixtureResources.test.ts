import { expect, it } from 'vitest';
import { createServer, get, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { closeFixtureResources } from './fixtureResources.js';
import { FixtureLifetime } from './fixtureLifetime.js';

const listen = async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
};
const dispose = async (server: Server) => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

it.each([undefined, 'primitive', Object.freeze(new Error('frozen'))])('attempts the listener despite a persistent client rejection and preserves %s', async failure => {
  const server = await listen();
  let calls = 0;
  const client = { close: async () => { calls++; throw failure; } };
  const resources = { client: client as typeof client | undefined, server: server as Server | undefined };
  const lifetime = new FixtureLifetime(), entered = deferred(), release = deferred();
  const body = lifetime.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const cleanup = lifetime.drain(() => closeFixtureResources(resources));
  const outcome = cleanup.then(() => ({ rejected: false, error: undefined }), error => ({ rejected: true, error }));
  void outcome.then(() => { settled = true; });
  try {
    // The synchronous close invocation stops listening before its callback.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(server.listening).toBe(false);
    expect(settled).toBe(false);
    expect(() => lifetime.run(async () => {})).toThrow('during cleanup');
    expect(resources.client).toBe(client);
  } finally { release.resolve(); await body; await outcome; await dispose(server); }
  expect(await outcome).toEqual({ rejected: true, error: failure });
  expect(calls).toBe(2);
  expect(server.listening).toBe(false);
  expect(resources.server).toBeUndefined();
});

it('accounts for callback errors and retains failed resources for retry', async () => {
  const failure = Object.freeze(new Error('callback'));
  let closes = 0;
  const server = { closeAllConnections() {}, close(callback: (error?: Error) => void) { closes++; callback(failure); } } as unknown as Server;
  const resources = { server };
  await expect(closeFixtureResources(resources)).rejects.toBe(failure);
  expect(resources.server).toBe(server);
  await expect(closeFixtureResources(resources)).rejects.toBe(failure);
  expect(closes).toBe(2);
  const clientError = new Error('first');
  await expect(closeFixtureResources({ server, client: { close: async () => { throw clientError; } } })).rejects.toBe(clientError);
});

it('rejects a non-ERR_SERVER_NOT_RUNNING callback code with identity and retains the server', async () => {
  const failure = Object.assign(new Error('io'), { code: 'EIO' });
  const server = { closeAllConnections() {}, close(callback: (error?: Error) => void) { callback(failure); } } as unknown as Server;
  const resources = { server: server as Server | undefined };
  await expect(closeFixtureResources(resources)).rejects.toBe(failure);
  expect(resources.server).toBe(server);
  await expect(closeFixtureResources(resources)).rejects.toBe(failure);
  expect(resources.server).toBe(server);
});

it('does not clear replacements and closes resources created by a live tail', async () => {
  const first = await listen(), tail = await listen();
  const replacement = { close: async () => {} };
  const resources: { client?: { close(): Promise<void> }; server?: Server } = { server: first };
  resources.client = { close: async () => { resources.client = replacement; resources.server = tail; } };
  try {
    await closeFixtureResources(resources);
    expect(resources.client).toBe(replacement);
    expect(resources.server).toBe(tail);
    expect(first.listening).toBe(false);
    await closeFixtureResources(resources);
    expect(resources).toEqual({ client: undefined, server: undefined });
    expect(tail.listening).toBe(false);
  } finally { await dispose(first); await dispose(tail); }
  const lifetime = new FixtureLifetime(), entered = deferred(), release = deferred();
  const body = lifetime.run(async () => { entered.resolve(); await release.promise; resources.server = await listen(); });
  await entered.promise;
  const cleanup = lifetime.drain(() => closeFixtureResources(resources));
  release.resolve();
  try { await body; await cleanup; expect(resources.server).toBeUndefined(); }
  finally { if (resources.server) await dispose(resources.server); }
});

it('clears already-closed and never-listened servers and permits repeated drains', async () => {
  const stopped = await listen();
  await dispose(stopped);
  for (const server of [stopped, createServer()]) {
    const resources = { server: server as Server | undefined };
    const lifetime = new FixtureLifetime();
    await lifetime.drain(() => closeFixtureResources(resources));
    expect(resources.server).toBeUndefined();
    await lifetime.drain(() => closeFixtureResources(resources));
  }
});

it('closes an owned active stream before awaiting the close callback', async () => {
  const server = createServer((_request, response) => { response.writeHead(200); response.write('open'); });
  let socket: Socket | undefined;
  server.once('connection', value => { socket = value; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let response: IncomingMessage | undefined;
  const request = get(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, value => { response = value; });
  const connected = new Promise<void>((resolve, reject) => { request.once('response', () => resolve()); request.once('error', reject); });
  let cleanup: Promise<void> | undefined;
  try {
    await connected;
    cleanup = closeFixtureResources({ server });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(socket).toBeDefined();
    expect(socket!.destroyed).toBe(true);
    await cleanup;
  } finally {
    response?.destroy(); request.destroy();
    await dispose(server);
    await cleanup;
  }
});
