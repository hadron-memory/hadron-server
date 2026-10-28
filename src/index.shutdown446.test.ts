import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  close: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), events: [] as string[],
}));
vi.mock('./instrument.js', () => ({}));
vi.mock('./lib/automation/config.js', () => ({}));
vi.mock('./server.js', () => ({ createServer: async () => ({
  listen: () => ({ close: state.close }), locals: { stopEmbeddingWorker: state.stop },
}) }));
vi.mock('./controller/controller.js', () => ({ controller: { startup: vi.fn() } }));
vi.mock('./integrations/db/client.js', () => ({ db: { $disconnect: state.disconnect } }));

let closeDone: (error?: Error) => void;
let stopDone: (ok: boolean) => void;
let disconnectDone: () => void;
let signals: Map<string, () => void>;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  state.events.length = 0;
  signals = new Map();
  state.close.mockImplementation((cb) => { state.events.push('close'); closeDone = cb; });
  state.stop.mockImplementation(() => new Promise<boolean>(resolve => { stopDone = resolve; }));
  state.disconnect.mockImplementation(() => {
    state.events.push('disconnect');
    return new Promise<void>(resolve => { disconnectDone = resolve; });
  });
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') { signals.set(event, listener); return process; }
    return once(event, listener);
  }) as typeof process.once);
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { state.events.push(`exit:${code}`); }) as never);
  await import('./index.js');
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('#446 Prisma disconnect inside graceful shutdown deadline', () => {
  it.each(['SIGTERM', 'SIGINT'])('%s drains HTTP and worker before disconnect, then exits after disconnect', async signal => {
    signals.get(signal)!();
    await flush();
    expect(state.events).toEqual(['close']);
    closeDone();
    await flush();
    expect(state.events).toEqual(['close']);
    stopDone(true);
    await flush();
    expect(state.events).toEqual(['close', 'disconnect']);
    disconnectDone();
    await flush();
    expect(state.events).toEqual(['close', 'disconnect', 'exit:0']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('disconnect rejection preserves the drain exit code (drain failed=%s)', async failed => {
    state.disconnect.mockImplementationOnce(async () => { state.events.push('disconnect'); throw new Error('disconnect failed'); });
    signals.get('SIGTERM')!();
    closeDone(failed ? new Error('HTTP drain failed') : undefined);
    stopDone(true);
    await flush();
    expect(state.events).toEqual(['close', 'disconnect', `exit:${failed ? 1 : 0}`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for HTTP drain after worker rejection, then disconnects and exits unsuccessfully', async () => {
    state.stop.mockRejectedValueOnce(new Error('worker stop failed'));
    signals.get('SIGTERM')!();
    await flush();
    expect(state.events).toEqual(['close']);
    closeDone();
    await flush();
    expect(state.events).toEqual(['close', 'disconnect']);
    disconnectDone();
    await flush();
    expect(state.events).toEqual(['close', 'disconnect', 'exit:1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original ten-second deadline while disconnect is pending', async () => {
    signals.get('SIGTERM')!();
    closeDone(); stopDone(true);
    await flush();
    expect(state.events).toEqual(['close', 'disconnect']);
    await vi.advanceTimersByTimeAsync(9999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.events.at(-1)).toBe('exit:1');
  });

  it('starts shutdown only once across both signals', async () => {
    signals.get('SIGTERM')!(); signals.get('SIGINT')!();
    closeDone(); stopDone(true);
    await flush();
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(state.disconnect).toHaveBeenCalledTimes(1);
    disconnectDone(); await flush();
    expect(process.exit).toHaveBeenCalledTimes(1);
  });
});
