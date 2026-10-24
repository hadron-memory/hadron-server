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
 *      with up to three attempts, each with a 5s timeout (AbortController).
 *      Retry delays are 250ms then 1000ms, plus 0–25% additive jitter.
 *   2. Persist to a disk cache at $CLOUDFLARE_IPS_CACHE_PATH (default:
 *      `<os.tmpdir()>/hadron-cloudflare-ips.json`).
 *   3. After all attempts fail, fall back to the cached file if present.
 *   4. If both fail, throw — the caller's `createServer` will refuse
 *      to boot (fail-closed per Q-025-011 / FR-006).
 *   5. Schedule a daily background refresh (24h interval). Refresh
 *      failures retain the in-memory list and emit a warning; the
 *      server keeps running on the last-known-good ranges.
 *
 * Stale-but-known-good is **not** permissive: every cached value is
 * a real Cloudflare-published CIDR range from at most 24 hours ago.
 */

import { writeFile, readFile, mkdir, rename } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_API_URL = 'https://api.cloudflare.com/client/v4/ips';
const DEFAULT_TIMEOUT_MS = 5_000;
const BOOT_RETRY_DELAYS_MS = [250, 1_000] as const;
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
  /** Per-attempt fetch timeout in milliseconds. Defaults to 5000. */
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
 * `success: false`, all-garbage CIDR entries); the caller decides
 * whether to fall back to cache.
 *
 * **Filter-then-check ordering matters.** An earlier draft length-
 * checked the raw arrays, then filtered for strings. A response of
 * `[null, 0, "garbage"]` passed `length === 3` and was filtered to
 * `[]`, producing an empty-but-valid CloudflareIps. The caller
 * would then `app.set('trust proxy', [])` — equivalent to "trust
 * nothing", which silently breaks X-Forwarded-* handling rather
 * than refusing to boot (defeats the fail-closed invariant).
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
    const ipv4_cidrs = v4.filter((c): c is string => typeof c === 'string');
    const ipv6_cidrs = v6.filter((c): c is string => typeof c === 'string');
    // Filter-then-check: if every entry was non-string garbage, the
    // post-filter arrays are empty and we must fail-closed.
    if (ipv4_cidrs.length === 0 && ipv6_cidrs.length === 0) return null;
    return {
      ipv4_cidrs,
      ipv6_cidrs,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the disk cache. Returns null if absent, unreadable, malformed,
 * or all-garbage-after-filtering (same filter-then-check pattern as
 * fetchFromApi above — a corrupted cache file mustn't bypass the
 * fail-closed predicate).
 */
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
    const ipv4_cidrs = parsed.ipv4_cidrs.filter((c): c is string => typeof c === 'string');
    const ipv6_cidrs = parsed.ipv6_cidrs.filter((c): c is string => typeof c === 'string');
    if (ipv4_cidrs.length === 0 && ipv6_cidrs.length === 0) return null;
    return {
      ipv4_cidrs,
      ipv6_cidrs,
      fetched_at: parsed.fetched_at,
    };
  } catch {
    return null;
  }
}

/**
 * Atomic cache write — writes to a tempfile alongside the target,
 * then renames. Prevents a partially-written JSON if the writer is
 * interrupted (process kill, OOM) or if multiple workers race on the
 * same file (pm2 cluster, k8s replicas). Rename is atomic on the
 * same filesystem per POSIX; partial reads can never see a half-
 * written cache.
 */
async function writeCache(path: string, value: CloudflareIps): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmpPath, path);
}

/**
 * Boot-time initialization. Returns the loaded IP ranges and arms the
 * daily refresh interval. Boot tries at most three times with a fresh
 * per-attempt timeout, waiting 250ms then 1000ms plus 0–25% jitter between
 * failures. With the default timeout the sequence takes at most about
 * 16.563s (excluding scheduling and cache I/O); it completes before cache
 * fallback. Daily refresh still makes one attempt.
 * Throws if all boot attempts AND the cache read
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

  // Operational footgun guard: the default cache path lives in
  // os.tmpdir(), which is wiped on every container restart. In
  // production, that turns the fail-safe-stale fallback into a
  // single-point-of-failure (Cloudflare API down + container
  // restart = refuse-to-boot). Operators MUST set
  // CLOUDFLARE_IPS_CACHE_PATH to a persistent-volume path; warn
  // if they haven't, so this surfaces in the boot log rather than
  // discovered during a Cloudflare incident.
  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.CLOUDFLARE_IPS_CACHE_PATH &&
    !opts.cachePath
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[cloudflare-ips] WARNING: NODE_ENV=production but CLOUDFLARE_IPS_CACHE_PATH is unset; using ephemeral os.tmpdir(). On container restart with the Cloudflare API unreachable, this server will fail-closed. Set CLOUDFLARE_IPS_CACHE_PATH to a persistent-volume path.',
    );
  }

  let fresh: CloudflareIps | null = null;
  for (let attempt = 0; attempt <= BOOT_RETRY_DELAYS_MS.length; attempt++) {
    fresh = await fetchFromApi(apiUrl, timeoutMs, fetchImpl);
    if (fresh) break;
    const delay = BOOT_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      const jitter = Math.floor(Math.random() * delay * 0.25);
      await new Promise<void>((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
  if (fresh) {
    cached = fresh;
    try {
      await writeCache(cachePath, fresh);
    } catch {
      // Cache write failures are non-fatal: we have the live list in memory.
    }
    // eslint-disable-next-line no-console
    console.log(
      `[cloudflare-ips] Loaded ${fresh.ipv4_cidrs.length} IPv4 + ${fresh.ipv6_cidrs.length} IPv6 ranges from API.`,
    );
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
      `[cloudflare-ips] Boot fetch failed; using cached list from ${stale.fetched_at} (${stale.ipv4_cidrs.length} IPv4 + ${stale.ipv6_cidrs.length} IPv6 ranges). Will retry at next daily refresh.`,
    );
  }

  if (!opts.skipRefresh && refreshTimer === null) {
    refreshTimer = setInterval(() => {
      void refreshInBackground({ apiUrl, cachePath, timeoutMs, fetchImpl });
    }, REFRESH_INTERVAL_MS);
    // Don't keep the event loop alive on this timer alone.
    refreshTimer.unref();
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
