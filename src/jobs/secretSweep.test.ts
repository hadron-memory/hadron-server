/**
 * #4003 (S8 of #3991) — the secret sweep loop: one tick runs both retention purges; the boot gate honours
 * DISABLE_SECRET_SWEEP and NODE_ENV=test, and says so when disabled; a failed purge logs a code, never ids or values.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretSweepDisabledReason, secretSweepTick, startSecretSweepLoop } from './secretSweep.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('secretSweepTick', () => {
  it('runs the version purge, then the event purge, and reports both counts', async () => {
    const calls: string[] = [];
    const out = await secretSweepTick({} as never, {
      purgeVersions: async () => { calls.push('versions'); return { purged: 3, more: false }; },
      purgeEvents: async () => { calls.push('events'); return { events: 2, tombstones: 1 }; },
    });
    expect(calls).toEqual(['versions', 'events']);
    expect(out).toEqual({ versions: 3, events: 2, tombstones: 1, deleted: 0 });
  });

  it('a failing version purge still lets the event purge run, and logs only a code', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await secretSweepTick({} as never, {
      purgeVersions: async () => { throw Object.assign(new Error('secret-id-abc value=CANARY'), { code: 'P2010' }); },
      purgeEvents: async () => ({ events: 1, tombstones: 0 }),
    });
    expect(out).toEqual({ versions: 0, events: 1, tombstones: 0, deleted: 0 });
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('P2010');
    expect(logged).not.toContain('CANARY');
    expect(logged).not.toContain('secret-id-abc');
  });
});

describe('secretSweepDisabledReason', () => {
  it('is null when enabled, and names the reason otherwise', () => {
    expect(secretSweepDisabledReason({ NODE_ENV: 'production' })).toBeNull();
    expect(secretSweepDisabledReason({ NODE_ENV: 'production', DISABLE_SECRET_SWEEP: 'false' })).toBeNull();
    expect(secretSweepDisabledReason({ NODE_ENV: 'production', DISABLE_SECRET_SWEEP: 'true' })).toBe('DISABLE_SECRET_SWEEP');
    expect(secretSweepDisabledReason({ NODE_ENV: 'test' })).toBe('NODE_ENV=test');
  });
});

it('#4001 runs deletion every minute but retention hourly, and isolates a deletion-leg failure', async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const autoDelete = vi.fn().mockRejectedValueOnce(Object.assign(new Error('CANARY'), { code: 'P2010' })).mockResolvedValue(0);
  const purgeVersions = vi.fn().mockResolvedValue({ purged: 0, more: false });
  const purgeEvents = vi.fn().mockResolvedValue({ events: 0, tombstones: 0 });
  try {
    startSecretSweepLoop({} as never, { legs: { autoDelete, purgeVersions, purgeEvents } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(autoDelete).toHaveBeenCalledTimes(1); expect(purgeVersions).toHaveBeenCalledTimes(1); expect(purgeEvents).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('CANARY');
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(autoDelete).toHaveBeenCalledTimes(60); expect(purgeVersions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(purgeVersions).toHaveBeenCalledTimes(2);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

describe('the loop itself (#4573)', () => {
  const legs = (autoDelete: () => Promise<number>) => ({
    autoDelete, purgeVersions: vi.fn().mockResolvedValue({ purged: 0, more: false }), purgeEvents: vi.fn().mockResolvedValue({ events: 0, tombstones: 0 }),
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('waits the initial delay, then ticks at the interval', async () => {
    vi.useFakeTimers();
    const autoDelete = vi.fn().mockResolvedValue(0);
    startSecretSweepLoop({} as never, { initialDelayMs: 500, intervalMs: 100, legs: legs(autoDelete) });
    await vi.advanceTimersByTimeAsync(499); expect(autoDelete).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1); expect(autoDelete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99); expect(autoDelete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(autoDelete).toHaveBeenCalledTimes(2);
  });

  it('ticks never overlap: a tick still running when the next is due is skipped, and the loop resumes after it', async () => {
    vi.useFakeTimers();
    let finish!: (n: number) => void;
    const autoDelete = vi.fn().mockImplementationOnce(() => new Promise<number>((r) => { finish = r; })).mockResolvedValue(0);
    startSecretSweepLoop({} as never, { initialDelayMs: 10, intervalMs: 10, legs: legs(autoDelete) });
    await vi.advanceTimersByTimeAsync(100);
    expect(autoDelete).toHaveBeenCalledTimes(1);
    finish(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(autoDelete).toHaveBeenCalledTimes(2);
  });

  it.each([['before the first tick', 5], ['after it', 25]])('stop() ends it %s: no timer is left and nothing ticks again', async (_n, at) => {
    vi.useFakeTimers();
    const autoDelete = vi.fn().mockResolvedValue(0);
    const loop = startSecretSweepLoop({} as never, { initialDelayMs: 10, intervalMs: 10, legs: legs(autoDelete) });
    await vi.advanceTimersByTimeAsync(at);
    const ticks = autoDelete.mock.calls.length;
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(autoDelete).toHaveBeenCalledTimes(ticks);
  });

  it('the hand-run guard compares file URLs, so a path with a space or # still runs one tick', () => {
    const src = readFileSync(new URL('./secretSweep.ts', import.meta.url), 'utf8');
    expect(src).toContain("import.meta.url === pathToFileURL(process.argv[1] ?? '').href");
  });
});
