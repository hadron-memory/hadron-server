/**
 * #3845: when the graceful stop decides exit 1 it logs one `shutdown.step_failed step=<step> outcome=<token>` line per
 * failing step (never an error message); a clean stop logs none and exits 0. Exit codes and timings are the #446/#3021
 * ones (src/index.shutdown446.test.ts, src/index.drain3021.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ close: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), events: [] as string[] }));
vi.mock('./instrument.js', () => ({}));
vi.mock('./lib/automation/config.js', () => ({}));
vi.mock('./server.js', () => ({ createServer: async () => ({
  listen: () => ({ close: state.close, closeIdleConnections: () => undefined }), locals: { stopEmbeddingWorker: state.stop },
}) }));
vi.mock('./controller/controller.js', () => ({ controller: { startup: vi.fn() } }));
vi.mock('./integrations/db/client.js', () => ({ db: { $disconnect: state.disconnect } }));

const OK = { worker: 'ok', publisher: 'ok' };
let signals: Map<string, () => void>;
let logged: string[];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const stepLines = () => logged.filter(l => l.startsWith('shutdown.step_failed'));

async function stopWith(opts: { close?: (cb: (e?: Error) => void) => void; stop?: () => Promise<unknown> }) {
  state.close.mockImplementation(opts.close ?? ((cb: (e?: Error) => void) => cb()));
  state.stop.mockImplementation(opts.stop ?? (async () => OK));
  await import('./index.js');
  signals.get('SIGTERM')!();
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  process.env.STOPPING_DRAIN_WINDOW_MS = '0';
  state.events.length = 0;
  logged = [];
  signals = new Map();
  state.disconnect.mockImplementation(async () => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') { signals.set(event, listener); return process; }
    return once(event, listener);
  }) as typeof process.once);
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { state.events.push(`exit:${code}`); }) as never);
});
afterEach(() => { delete process.env.STOPPING_DRAIN_WINDOW_MS; vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('#3845 shutdown.step_failed', { timeout: 30_000 }, () => {
  it('a clean stop logs no step_failed line and exits 0', async () => {
    await stopWith({});
    expect(stepLines()).toEqual([]);
    expect(state.events).toEqual(['exit:0']);
  });

  it('listener close error: exit 1, names the step and the error code, not its message', async () => {
    await stopWith({ close: cb => cb(Object.assign(new Error('secret https://x.example/?t=1'), { code: 'ERR_SERVER_NOT_RUNNING' })) });
    expect(stepLines()).toEqual(['shutdown.step_failed step=http_listener outcome=close_error:ERR_SERVER_NOT_RUNNING']);
    expect(state.events).toEqual(['exit:1']);
  });

  it.each(['grace_timeout', 'jobs_unsettled', 'bus_stop_rejected'])('embedding worker %s: exit 1 and a line naming it', async outcome => {
    await stopWith({ stop: async () => ({ ...OK, worker: outcome }) });
    expect(stepLines()).toEqual([`shutdown.step_failed step=embedding_worker outcome=${outcome}`]);
    expect(state.events).toEqual(['exit:1']);
  });

  it('embedding publisher grace timeout: exit 1 and a line naming it', async () => {
    await stopWith({ stop: async () => ({ ...OK, publisher: 'grace_timeout' }) });
    expect(stepLines()).toEqual(['shutdown.step_failed step=embedding_publisher outcome=grace_timeout']);
    expect(state.events).toEqual(['exit:1']);
  });

  it('a rejected stop hook: exit 1, names the step and the error name only', async () => {
    await stopWith({ stop: async () => { throw new TypeError('secret https://y.example'); } });
    expect(stepLines()).toEqual(['shutdown.step_failed step=embedding_worker outcome=rejected:TypeError']);
    expect(logged.join('\n')).not.toContain('secret');
    expect(state.events).toEqual(['exit:1']);
  });

  it('several failing steps log one line each', async () => {
    await stopWith({ close: cb => cb(new Error('m')), stop: async () => ({ worker: 'grace_timeout', publisher: 'grace_timeout' }) });
    expect(stepLines()).toEqual([
      'shutdown.step_failed step=http_listener outcome=close_error:Error',
      'shutdown.step_failed step=embedding_worker outcome=grace_timeout',
      'shutdown.step_failed step=embedding_publisher outcome=grace_timeout',
    ]);
    expect(state.events).toEqual(['exit:1']);
  });
});
