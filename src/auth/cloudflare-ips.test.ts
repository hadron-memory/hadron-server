import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initCloudflareIps,
  getCloudflareIps,
  _resetCloudflareIpsForTesting,
} from './cloudflare-ips.js';

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cloudflare-ips-test-'));
  cachePath = join(tmpDir, 'cache.json');
  _resetCloudflareIpsForTesting();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  _resetCloudflareIpsForTesting();
});

const SAMPLE_V4 = ['173.245.48.0/20', '103.21.244.0/22'];
const SAMPLE_V6 = ['2400:cb00::/32', '2606:4700::/32'];

function makeFetchResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successBody(): unknown {
  return {
    result: { ipv4_cidrs: SAMPLE_V4, ipv6_cidrs: SAMPLE_V6 },
    success: true,
  };
}

describe('initCloudflareIps', () => {
  it('fetches from the API on success and populates the in-memory cache', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(successBody()));
    const result = await initCloudflareIps({
      apiUrl: 'https://example.com/ips',
      cachePath,
      fetchImpl,
      skipRefresh: true,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.ipv4_cidrs).toEqual(SAMPLE_V4);
    expect(result.ipv6_cidrs).toEqual(SAMPLE_V6);
    expect(result.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getCloudflareIps()).toEqual(result);
  });

  it('writes the fetched ranges to the disk cache', async () => {
    await initCloudflareIps({
      apiUrl: 'https://example.com/ips',
      cachePath,
      fetchImpl: vi.fn(async () => makeFetchResponse(successBody())),
      skipRefresh: true,
    });

    const { readFileSync } = await import('fs');
    const written = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(written.ipv4_cidrs).toEqual(SAMPLE_V4);
    expect(written.ipv6_cidrs).toEqual(SAMPLE_V6);
  });

  it('falls back to the cached file when the API fetch fails', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        ipv4_cidrs: SAMPLE_V4,
        ipv6_cidrs: SAMPLE_V6,
        fetched_at: '2026-05-19T00:00:00.000Z',
      }),
    );
    const result = await initCloudflareIps({
      apiUrl: 'https://example.com/ips',
      cachePath,
      fetchImpl: vi.fn(async () => makeFetchResponse({ success: false }, false)),
      skipRefresh: true,
    });
    expect(result.ipv4_cidrs).toEqual(SAMPLE_V4);
    expect(result.fetched_at).toBe('2026-05-19T00:00:00.000Z');
  });

  it('falls back to the cached file when the fetch times out', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        ipv4_cidrs: SAMPLE_V4,
        ipv6_cidrs: SAMPLE_V6,
        fetched_at: '2026-05-19T00:00:00.000Z',
      }),
    );
    // Simulate a hanging fetch by returning a promise that respects AbortSignal.
    const slowFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }
      });
    const result = await initCloudflareIps({
      apiUrl: 'https://example.com/ips',
      cachePath,
      timeoutMs: 50, // tight budget
      fetchImpl: slowFetch,
      skipRefresh: true,
    });
    expect(result.ipv4_cidrs).toEqual(SAMPLE_V4);
  });

  it('throws when both the fetch AND the cache read fail', async () => {
    // cachePath points at a fresh tmpDir with no file there.
    await expect(
      initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () => {
          throw new TypeError('network down');
        }),
        skipRefresh: true,
      }),
    ).rejects.toThrow(/Failed to load Cloudflare IP ranges/);
    expect(getCloudflareIps()).toBeNull();
  });

  it('rejects API responses where success !== true', async () => {
    await expect(
      initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () =>
          makeFetchResponse({
            result: { ipv4_cidrs: SAMPLE_V4, ipv6_cidrs: SAMPLE_V6 },
            success: false,
          }),
        ),
        skipRefresh: true,
      }),
    ).rejects.toThrow(/Failed to load/);
  });

  it('rejects API responses missing both ipv4_cidrs and ipv6_cidrs', async () => {
    await expect(
      initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () =>
          makeFetchResponse({
            result: { ipv4_cidrs: [], ipv6_cidrs: [] },
            success: true,
          }),
        ),
        skipRefresh: true,
      }),
    ).rejects.toThrow(/Failed to load/);
  });

  it('rejects API responses with HTTP non-2xx status', async () => {
    await expect(
      initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () => new Response('rate limited', { status: 429 })),
        skipRefresh: true,
      }),
    ).rejects.toThrow(/Failed to load/);
  });

  it('filters non-string entries out of the cached arrays', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        ipv4_cidrs: ['173.245.48.0/20', 12345, null, '103.21.244.0/22'],
        ipv6_cidrs: SAMPLE_V6,
        fetched_at: '2026-05-19T00:00:00.000Z',
      }),
    );
    const result = await initCloudflareIps({
      apiUrl: 'https://example.com/ips',
      cachePath,
      fetchImpl: vi.fn(async () => makeFetchResponse({ success: false }, false)),
      skipRefresh: true,
    });
    expect(result.ipv4_cidrs).toEqual(['173.245.48.0/20', '103.21.244.0/22']);
  });

  it('returns null from getCloudflareIps before init is called', () => {
    expect(getCloudflareIps()).toBeNull();
  });

  // ── Regression guards for the empty-arrays-after-filter bypass ────

  it('throws when API returns all-non-string CIDR entries (no fail-closed bypass)', async () => {
    // The earlier draft length-checked v4/v6 before filtering; a
    // response of `[null, 0, "garbage"]` had length===3 (passed the
    // check), got filtered to [], and silently returned valid-looking
    // empty arrays — which app.set('trust proxy', []) would interpret
    // as "trust nothing" rather than refuse to boot.
    await expect(
      initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () =>
          makeFetchResponse({
            result: { ipv4_cidrs: [null, 0, 12345], ipv6_cidrs: [false] },
            success: true,
          }),
        ),
        skipRefresh: true,
      }),
    ).rejects.toThrow(/Failed to load/);
  });

  it('rejects a cache file with all-non-string CIDR entries', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        ipv4_cidrs: [null, 0, 12345],
        ipv6_cidrs: [false, 42],
        fetched_at: '2026-05-19T00:00:00.000Z',
      }),
    );
    await expect(
      initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () => makeFetchResponse({ success: false }, false)),
        skipRefresh: true,
      }),
    ).rejects.toThrow(/Failed to load/);
  });

  // ── Atomic cache write ────────────────────────────────────────────

  it('writes the cache atomically (no .tmp file left behind on success)', async () => {
    await initCloudflareIps({
      apiUrl: 'https://example.com/ips',
      cachePath,
      fetchImpl: vi.fn(async () => makeFetchResponse(successBody())),
      skipRefresh: true,
    });
    const { readdirSync } = await import('fs');
    const files = readdirSync(tmpDir);
    // Final file present, no temp leftover.
    expect(files).toContain('cache.json');
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
  });

  // ── Positive-signal log line for boot success ─────────────────────

  it('logs a "Loaded N IPv4 + M IPv6 ranges" line on successful boot fetch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl: vi.fn(async () => makeFetchResponse(successBody())),
        skipRefresh: true,
      });
      const logs = logSpy.mock.calls.map((c) => c.join(' '));
      expect(logs.some((line) => /\[cloudflare-ips\] Loaded \d+ IPv4 \+ \d+ IPv6/.test(line))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  // ── Daily-refresh background timer ────────────────────────────────

  it('daily refresh replaces the in-memory cache on a successful re-fetch', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        // Boot fetch: original list
        .mockImplementationOnce(async () => makeFetchResponse(successBody()))
        // 24h later: refreshed list (different CIDRs)
        .mockImplementationOnce(
          async () =>
            makeFetchResponse({
              result: {
                ipv4_cidrs: ['10.0.0.0/8'],
                ipv6_cidrs: ['fd00::/8'],
              },
              success: true,
            }),
        );

      await initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl,
        skipRefresh: false, // ENABLE the daily timer for this test
      });

      // Boot loaded the original list.
      expect(getCloudflareIps()?.ipv4_cidrs).toEqual(SAMPLE_V4);

      // Advance 24 hours; let microtasks flush so the refresh
      // completes before we assert.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      // In-memory cache replaced with the refreshed list.
      expect(getCloudflareIps()?.ipv4_cidrs).toEqual(['10.0.0.0/8']);
      expect(getCloudflareIps()?.ipv6_cidrs).toEqual(['fd00::/8']);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('daily refresh failure retains the in-memory cache (stale > fail-closed at runtime)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        // Boot fetch: success
        .mockImplementationOnce(async () => makeFetchResponse(successBody()))
        // 24h later: network down
        .mockImplementationOnce(async () => {
          throw new TypeError('network down');
        });

      await initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        cachePath,
        fetchImpl,
        skipRefresh: false,
      });

      const before = getCloudflareIps();
      expect(before?.ipv4_cidrs).toEqual(SAMPLE_V4);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      // In-memory cache UNCHANGED; refresh failure is logged but
      // doesn't degrade runtime trust-proxy state.
      const after = getCloudflareIps();
      expect(after?.ipv4_cidrs).toEqual(SAMPLE_V4);
      expect(after?.fetched_at).toBe(before?.fetched_at);

      const warnings = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(
        warnings.some((line) =>
          line.includes('Daily refresh failed; retaining last-known-good ranges'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // ── Operational-footgun warning ───────────────────────────────────

  it('warns in NODE_ENV=production when CLOUDFLARE_IPS_CACHE_PATH is unset (default ephemeral tmpdir)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevEnv = process.env.NODE_ENV;
    const prevPath = process.env.CLOUDFLARE_IPS_CACHE_PATH;
    process.env.NODE_ENV = 'production';
    delete process.env.CLOUDFLARE_IPS_CACHE_PATH;
    try {
      // Must NOT pass cachePath in opts — that's the case we're warning about.
      await initCloudflareIps({
        apiUrl: 'https://example.com/ips',
        // (no cachePath override)
        fetchImpl: vi.fn(async () => makeFetchResponse(successBody())),
        skipRefresh: true,
      });
      const warnings = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(
        warnings.some((line) =>
          line.includes('NODE_ENV=production but CLOUDFLARE_IPS_CACHE_PATH is unset'),
        ),
      ).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      if (prevPath !== undefined) process.env.CLOUDFLARE_IPS_CACHE_PATH = prevPath;
      warnSpy.mockRestore();
    }
  });
});
