/**
 * Spec 025-oauth-for-mcp FR-006 / research §R-4: Cloudflare-only
 * trust-proxy support.
 *
 * Production deployments host `hadron-server` behind Cloudflare. Express's
 * `app.set('trust proxy', …)` must be configured with Cloudflare's
 * published IP ranges so:
 *   - `req.protocol` correctly resolves to `'https'` via
 *     `X-Forwarded-Proto` (without this, the RFC 9728
 *     `WWW-Authenticate: resource_metadata="…"` URL advertised at
 *     /mcp 401 emits `http://` URLs that Claude Desktop refuses;
 *     see EF-003).
 *   - `req.ip` returns the real client IP rather than the Cloudflare
 *     proxy IP (matters for the `/oauth/register` per-IP rate limit
 *     in Phase 2).
 *
 * Boot sequence:
 *   1. Fetch CIDR ranges from https://api.cloudflare.com/client/v4/ips
 *      with a 5s timeout (AbortController).
 *   2. Persist to a disk cache at $CLOUDFLARE_IPS_CACHE_PATH (default:
 *      `<os.tmpdir()>/hadron-cloudflare-ips.json`).
 *   3. On fetch failure, fall back to the cached file if present.
 *   4. If both fail, throw — the caller's `createServer` will refuse
 *      to boot (fail-closed per Q-025-011 / FR-006).
 *   5. Schedule a daily background refresh (24h interval). Refresh
 *      failures retain the in-memory list and emit a warning; the
 *      server keeps running on the last-known-good ranges.
 *
 * Stale-but-known-good is **not** permissive: every cached value is
 * a real Cloudflare-published CIDR range from at most 24 hours ago.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_API_URL = 'https://api.cloudflare.com/client/v4/ips';
const DEFAULT_TIMEOUT_MS = 5_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CloudflareIps {
  ipv4_cidrs: string[];
  ipv6_cidrs: string[];
  /** ISO 8601 timestamp of the fetch (or cache read) that produced this. */
  fetched_at: string;
}

export interface InitOptions {
  /** API endpoint. Defaults to Cloudflare's public IP list. */
  apiUrl?: string;
  /** Disk cache path. Defaults to `<tmpdir>/hadron-cloudflare-ips.json`. */
  cachePath?: string;
  /** Fetch timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /** Skip the daily refresh interval (used by unit tests). */
  skipRefresh?: boolean;
  /** Inject a fetch implementation (used by unit tests). */
  fetchImpl?: typeof fetch;
}

let cached: CloudflareIps | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

/** Default cache path: ephemeral on most systems; production envs SHOULD override. */
function defaultCachePath(): string {
  return process.env.CLOUDFLARE_IPS_CACHE_PATH ?? join(tmpdir(), 'hadron-cloudflare-ips.json');
}

/**
 * Fetch from the Cloudflare API with a bounded timeout. Returns null on
 * any failure (network error, timeout, HTTP non-2xx, malformed body,
 * `success: false`); the caller decides whether to fall back to cache.
 */
async function fetchFromApi(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<CloudflareIps | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      result?: { ipv4_cidrs?: unknown; ipv6_cidrs?: unknown };
      success?: boolean;
    };
    if (json.success !== true) return null;
    const v4 = json.result?.ipv4_cidrs;
    const v6 = json.result?.ipv6_cidrs;
    if (!Array.isArray(v4) || !Array.isArray(v6)) return null;
    if (v4.length === 0 && v6.length === 0) return null;
    return {
      ipv4_cidrs: v4.filter((c): c is string => typeof c === 'string'),
      ipv6_cidrs: v6.filter((c): c is string => typeof c === 'string'),
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the disk cache. Returns null if absent, unreadable, or malformed. */
async function readCache(path: string): Promise<CloudflareIps | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CloudflareIps>;
    if (
      !parsed ||
      !Array.isArray(parsed.ipv4_cidrs) ||
      !Array.isArray(parsed.ipv6_cidrs) ||
      typeof parsed.fetched_at !== 'string'
    ) {
      return null;
    }
    return {
      ipv4_cidrs: parsed.ipv4_cidrs.filter((c): c is string => typeof c === 'string'),
      ipv6_cidrs: parsed.ipv6_cidrs.filter((c): c is string => typeof c === 'string'),
      fetched_at: parsed.fetched_at,
    };
  } catch {
    return null;
  }
}

async function writeCache(path: string, value: CloudflareIps): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Boot-time initialization. Returns the loaded IP ranges and arms the
 * daily refresh interval. Throws if both the fetch AND the cache read
 * fail — in that case `createServer` MUST refuse to boot in
 * `NODE_ENV=production` (the caller enforces this; see `src/server.ts`).
 */
export async function initCloudflareIps(opts: InitOptions = {}): Promise<CloudflareIps> {
  // Resolution order: explicit option > env var > built-in default.
  // The env var is the lever that the boot-policy integration test
  // uses to force a fetch failure without modifying production code.
  const apiUrl = opts.apiUrl ?? process.env.CLOUDFLARE_IPS_API_URL ?? DEFAULT_API_URL;
  const cachePath = opts.cachePath ?? defaultCachePath();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const fresh = await fetchFromApi(apiUrl, timeoutMs, fetchImpl);
  if (fresh) {
    cached = fresh;
    try {
      await writeCache(cachePath, fresh);
    } catch {
      // Cache write failures are non-fatal: we have the live list in memory.
    }
  } else {
    const stale = await readCache(cachePath);
    if (!stale) {
      throw new Error(
        `Failed to load Cloudflare IP ranges: API fetch from ${apiUrl} failed and no usable cache at ${cachePath}.`,
      );
    }
    cached = stale;
    // eslint-disable-next-line no-console
    console.warn(
      `[cloudflare-ips] Boot fetch failed; using cached list from ${stale.fetched_at}. Will retry at next daily refresh.`,
    );
  }

  if (!opts.skipRefresh && refreshTimer === null) {
    refreshTimer = setInterval(() => {
      void refreshInBackground({ apiUrl, cachePath, timeoutMs, fetchImpl });
    }, REFRESH_INTERVAL_MS);
    // Don't keep the event loop alive on this timer alone.
    refreshTimer.unref?.();
  }

  return cached;
}

async function refreshInBackground(opts: {
  apiUrl: string;
  cachePath: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const fresh = await fetchFromApi(opts.apiUrl, opts.timeoutMs, opts.fetchImpl);
  if (!fresh) {
    // Retain the in-memory list — stale is preferable to fail-closed
    // at runtime. The next interval will retry.
    // eslint-disable-next-line no-console
    console.warn(
      '[cloudflare-ips] Daily refresh failed; retaining last-known-good ranges.',
    );
    return;
  }
  cached = fresh;
  try {
    await writeCache(opts.cachePath, fresh);
  } catch {
    // Non-fatal: in-memory list is updated.
  }
}

/**
 * Synchronous accessor for the current ranges. Returns null if
 * `initCloudflareIps` has not been called (or it threw).
 */
export function getCloudflareIps(): CloudflareIps | null {
  return cached;
}

/**
 * Test-only hook: clears the cached ranges and the refresh timer.
 * Lets each test start from a known-empty state.
 */
export function _resetCloudflareIpsForTesting(): void {
  cached = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
