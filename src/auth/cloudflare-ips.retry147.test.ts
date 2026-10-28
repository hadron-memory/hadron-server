import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCloudflareIps, getCloudflareIps, _resetCloudflareIpsForTesting } from './cloudflare-ips.js';

let dir: string;
let cachePath: string;
const stale = { ipv4_cidrs: ['173.245.48.0/20'], ipv6_cidrs: [], fetched_at: '2026-01-01T00:00:00.000Z' };
const fresh = () => new Response(JSON.stringify({ success: true, result: { ipv4_cidrs: ['103.21.244.0/22'], ipv6_cidrs: [] } }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudflare-retry147-'));
  cachePath = join(dir, 'ips.json');
  _resetCloudflareIpsForTesting();
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  _resetCloudflareIpsForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('#147 boot-only Cloudflare retries', () => {
  it('clears the deadline after first-attempt success before the deadline elapses (#2367)', async () => {
    const started = Date.now();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init!.signal!;
      return fresh();
    });

    const result = await initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true });

    expect(result.ipv4_cidrs).toEqual(['103.21.244.0/22']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(started);
    expect(signal?.aborted).toBe(false);
    // Do not advance timers first: firing the deadline would hide its leak.
    // skipRefresh excludes the intentionally scheduled daily refresh timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers on attempt two before choosing an existing stale cache', async () => {
    writeFileSync(cachePath, JSON.stringify(stale));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockImplementationOnce(async () => fresh());
    const pending = initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true });
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ipv4_cidrs).toEqual(['103.21.244.0/22']);
    expect(result.fetched_at).not.toBe(stale.fetched_at);
  });

  it('waits 250ms then 1000ms and stops after the third successful attempt', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('temporary'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockImplementationOnce(async () => fresh());
    const pending = initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true });
    // Attach a handler immediately so a red first-attempt rejection is reported normally.
    const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('exhausts three attempts before returning the stale cache', async () => {
    writeFileSync(cachePath, JSON.stringify(stale));
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const pending = initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true });
    await vi.advanceTimersByTimeAsync(1249);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getCloudflareIps()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(stale);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('remains fail-closed after three attempts with no usable cache', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const outcome = initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true }).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(1250);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/Failed to load Cloudflare IP ranges/) });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(getCloudflareIps()).toBeNull();
  });

  it('gives every attempt a fresh five-second abort budget (16.25s without jitter)', async () => {
    const started = Date.now();
    const attempts: number[] = [];
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      attempts.push(Date.now() - started);
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
    }));
    const outcome = initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true }).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(16250);
    expect(await outcome).toBeInstanceOf(Error);
    expect(attempts).toEqual([0, 5250, 11250]);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps additive jitter at 25% of each backoff', async () => {
    vi.mocked(Math.random).mockReturnValue(0.999999);
    writeFileSync(cachePath, JSON.stringify(stale));
    const started = Date.now();
    const attempts: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attempts.push(Date.now() - started);
      throw new TypeError('offline');
    });
    const pending = initCloudflareIps({ cachePath, fetchImpl, skipRefresh: true });
    await vi.advanceTimersByTimeAsync(1563);
    expect(await pending).toEqual(stale);
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toBeGreaterThan(250);
    expect(attempts[1]).toBeLessThanOrEqual(313);
    expect(attempts[2]).toBeGreaterThan(1250);
    expect(attempts[2]).toBeLessThanOrEqual(1563);
  });

  it('does not apply boot retries to a failed daily refresh', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => fresh())
      .mockRejectedValue(new TypeError('offline'));
    const initial = await initCloudflareIps({ cachePath, fetchImpl });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getCloudflareIps()).toEqual(initial);
  });
});
