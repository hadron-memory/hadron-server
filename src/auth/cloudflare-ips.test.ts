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
});
