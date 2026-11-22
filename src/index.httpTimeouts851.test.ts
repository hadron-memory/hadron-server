/**
 * #851: src/index.ts applies the keep-alive and headers timeouts to the server `app.listen` returns. Without this
 * wiring the helper is dead code and Node's 5 s keep-alive still resets connections a proxy reuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ server: undefined as undefined | { keepAliveTimeout: number; headersTimeout: number } }));
vi.mock('./instrument.js', () => ({}));
vi.mock('./lib/automation/config.js', () => ({}));
vi.mock('./server.js', () => ({
  createServer: async () => ({
    listen: () => {
      state.server = { keepAliveTimeout: 5_000, headersTimeout: 60_000, close: () => undefined, closeIdleConnections: () => undefined } as never;
      return state.server;
    },
    locals: {},
  }),
}));
vi.mock('./controller/controller.js', () => ({ controller: { startup: vi.fn() } }));
vi.mock('./integrations/db/client.js', () => ({ db: { $disconnect: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  state.server = undefined;
  vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once);
});
afterEach(() => {
  delete process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  delete process.env.HTTP_HEADERS_TIMEOUT_MS;
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
});
