/**
 * #851: src/index.ts applies the keep-alive and headers timeouts to the server `app.listen` returns. Without this
 * wiring the helper is dead code and Node's 5 s keep-alive still resets connections a proxy reuses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ server: undefined as undefined | { keepAliveTimeout: number; headersTimeout: number }, listenCallback: true }));
let portDir = '';
vi.mock('./instrument.js', () => ({}));
vi.mock('./lib/automation/config.js', () => ({}));
vi.mock('./server.js', () => ({
  createServer: async () => ({
    listen: (_port: number, cb?: () => void) => {
      state.server = { keepAliveTimeout: 5_000, headersTimeout: 60_000, address: () => ({ port: 4321 }), close: () => undefined, closeIdleConnections: () => undefined } as never;
      // The real listen callback runs after the call returns (once the socket is bound), never synchronously.
      if (state.listenCallback) queueMicrotask(() => cb?.());
      return state.server;
    },
    locals: {},
  }),
}));
vi.mock('./controller/controller.js', () => ({ controller: { startup: () => Promise.resolve() } }));
vi.mock('./integrations/db/client.js', () => ({ db: { $disconnect: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  state.server = undefined;
  state.listenCallback = true;
  portDir = mkdtempSync(join(tmpdir(), 'hadron-851-idx-'));
  process.env.HADRON_PORT_FILE = join(portDir, 'port');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  delete process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  delete process.env.HTTP_HEADERS_TIMEOUT_MS;
  vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once);
});
afterEach(() => {
  delete process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  delete process.env.HTTP_HEADERS_TIMEOUT_MS;
  delete process.env.HADRON_PORT_FILE;
  rmSync(portDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('#851 index wiring', () => {
  it('sets 120 s keep-alive and 125 s headers on the listening server by default', async () => {
    await import('./index.js');
    expect(state.server?.keepAliveTimeout).toBe(120_000);
    expect(state.server?.headersTimeout).toBe(125_000);
  });

  it('honours the env variables', async () => {
    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS = '100000';
    process.env.HTTP_HEADERS_TIMEOUT_MS = '110000';
    await import('./index.js');
    expect(state.server?.keepAliveTimeout).toBe(100_000);
    expect(state.server?.headersTimeout).toBe(110_000);
  });

  it('writes the bound port for the HEALTHCHECK, and clears a stale one first', async () => {
    writeFileSync(process.env.HADRON_PORT_FILE!, '9999\n');
    await import('./index.js');
    await new Promise((r) => setTimeout(r, 10));
    expect(readFileSync(process.env.HADRON_PORT_FILE!, 'utf8').trim()).toBe('4321');
  });

  it('removes a stale port file at start, before the server is listening (a previous run\'s port is never read)', async () => {
    state.listenCallback = false; // the socket never reports listening: only the start-up clear can have run
    writeFileSync(process.env.HADRON_PORT_FILE!, '9999\n');
    await import('./index.js');
    await new Promise((r) => setTimeout(r, 10));
    expect(() => readFileSync(process.env.HADRON_PORT_FILE!, 'utf8')).toThrow();
  });
});
