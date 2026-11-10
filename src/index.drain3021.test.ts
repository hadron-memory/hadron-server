/**
 * #3021 part 2: a bounded window between `readiness.markStopping()` and
 * `httpServer.close()`, so a proxy polling `/ready` can see `503 stopping`
 * before the listener refuses connections.
 *
 * Pins: the window's default, its bound, that nothing closes inside it, that
 * readiness already says stopping inside it, that the existing ten-second
 * hard deadline still starts at the signal, and that `/health` is untouched.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountHealthRoutes } from './api/health.js';
import type { ReadinessSource } from './api/health.js';

const state = vi.hoisted(() => ({
  close: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), events: [] as string[],
  readiness: undefined as undefined | { stopping(): boolean },
}));
vi.mock('./instrument.js', () => ({}));
vi.mock('./lib/automation/config.js', () => ({}));
vi.mock('./server.js', () => ({ createServer: async (opts: { readiness: { stopping(): boolean } }) => {
  state.readiness = opts.readiness;
  return { listen: () => ({ close: state.close, closeIdleConnections: () => undefined }), locals: { stopEmbeddingWorker: state.stop } };
} }));
vi.mock('./controller/controller.js', () => ({ controller: { startup: vi.fn() } }));
vi.mock('./integrations/db/client.js', () => ({ db: { $disconnect: state.disconnect } }));

let signals: Map<string, () => void>;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function boot(windowEnv?: string) {
  if (windowEnv === undefined) delete process.env.STOPPING_DRAIN_WINDOW_MS;
  else process.env.STOPPING_DRAIN_WINDOW_MS = windowEnv;
  await import('./index.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.events.length = 0;
  signals = new Map();
  state.close.mockImplementation((cb: (e?: Error) => void) => { state.events.push('close'); cb(); });
  state.stop.mockImplementation(async () => true);
  state.disconnect.mockImplementation(async () => { state.events.push('disconnect'); });
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') { signals.set(event, listener); return process; }
    return once(event, listener);
  }) as typeof process.once);
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { state.events.push(`exit:${code}`); }) as never);
});

afterEach(() => {
  delete process.env.STOPPING_DRAIN_WINDOW_MS;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks();
});

describe('#3021 stopping drain window', () => {
  it('holds the listener open for the default 6000 ms while /ready already says stopping', async () => {
    await boot();
    signals.get('SIGTERM')!();
    await flush();
    expect(state.readiness!.stopping()).toBe(true);
    expect(state.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5999);
    expect(state.close).not.toHaveBeenCalled();
    expect(state.readiness!.stopping()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.close).toHaveBeenCalledTimes(1);
    await flush();
    expect(state.events).toEqual(['close', 'disconnect', 'exit:0']);
  });

  it('honors STOPPING_DRAIN_WINDOW_MS inside the bound (0 closes at once)', async () => {
    await boot('0');
    signals.get('SIGTERM')!();
    await flush();
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('accepts the 30000 ms ceiling and waits all of it', async () => {
    await boot('30000');
    signals.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(29999);
    expect(state.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it.each(['30001', '600000', '-1', '1.5', 'abc', '', ' ', '1e3', '0x10'])(
    'a value outside the bound or malformed (%j) falls back to 6000, never widening the window',
    async raw => {
      await boot(raw);
      signals.get('SIGTERM')!();
      await vi.advanceTimersByTimeAsync(5999);
      expect(state.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.close).toHaveBeenCalledTimes(1);
    },
  );

  it('the hard deadline is the window plus ten seconds, so a long window never eats the drain', async () => {
    state.close.mockImplementation((_cb: (e?: Error) => void) => { state.events.push('close'); }); // never drains
    await boot('8000');
    signals.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(17999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.events.at(-1)).toBe('exit:1');
  });

  it('with the window off the deadline is the original ten seconds from the signal', async () => {
    state.close.mockImplementation((_cb: (e?: Error) => void) => { state.events.push('close'); });
    await boot('0');
    signals.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(9999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.events.at(-1)).toBe('exit:1');
  });

  it('a second signal inside the window neither restarts nor shortens it', async () => {
    await boot();
    signals.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(1000);
    signals.get('SIGINT')!();
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.close).toHaveBeenCalledTimes(1);
  });
});

describe('#3021 /health is unchanged while stopping', () => {
  it('answers 200 on /health and 503 stopping on /ready for a stopping source', async () => {
    vi.useRealTimers();
    const readiness: ReadinessSource = { startup: () => 'settled', stopping: () => true };
    const app = express();
    mountHealthRoutes(app, { $queryRaw: (async () => [{ '?column?': 1 }]) as never }, { readiness });
    const server = await new Promise<Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ok: false, error: 'stopping' });
    } finally { server.close(); }
  });
});
