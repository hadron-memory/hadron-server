/**
 * SSRF-guarded synchronous web fetch for importNode (#457, sync v1).
 *
 * Egress policy (spec rule pending — suggested cor:api:130):
 *   - http:/https: only, URL ≤ 2k chars.
 *   - Every hostname is resolved and EVERY resolved address must fall outside
 *     private/reserved/link-local/metadata ranges; IP-literal hosts are
 *     validated directly. Redirects are followed manually (max 3 hops) and
 *     every hop re-runs the full check.
 *   - 30s total budget, response body capped at MAX_HTML_CHARS bytes,
 *     content-type must be HTML/XHTML.
 *
 * KNOWN LIMITATION (documented, accepted for v1): the resolve-then-fetch
 * sequence is a DNS-rebinding TOCTOU — a hostile nameserver can answer the
 * validation lookup with a public address and the fetch's own lookup with a
 * private one. Closing it requires pinning the connection through a custom
 * dispatcher lookup (undici Agent) while preserving SNI; deferred until the
 * import surface is exposed beyond user-initiated callers (the chrome
 * extension) — tracked in the egress-policy spec rule.
 *
 * Auth boundary (issue #457): this fetch carries NO user credentials —
 * authenticated pages must come through importNode's inline `content` path.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { GraphQLError } from 'graphql';
import { MAX_HTML_CHARS } from './pdfClient.js';

const MAX_URL_CHARS = 2_000;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 30_000;
const ACCEPTED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

export interface WebFetchResult {
  html: string;
  /** URL of the final hop (after redirects) — for base-URL resolution. */
  finalUrl: string;
}

function importError(message: string, code: string, extra?: Record<string, unknown>): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...extra } });
}

/**
 * True when the address must not be fetched server-side. Covers the classic
 * bypass shapes: decimal IPv4 literals arrive here already normalized by the
 * resolver, `[::1]` via the IPv6 branch, IPv4-mapped IPv6 via unwrapping,
 * and the cloud metadata endpoint via 169.254/16.
 */
export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;
    return (
      a === 0 || // 0.0.0.0/8 ("this network" — hits localhost on Linux)
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isForbiddenAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true; // unspecified + loopback
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    return false;
  }
  // Not an IP at all — callers pass resolver output, so treat as forbidden.
  return true;
}

/** Validate a URL's host: IP literals directly, hostnames via full resolution. */
async function assertHostAllowed(url: URL): Promise<void> {
  // URL.hostname wraps IPv6 in brackets — strip for isIP/lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isForbiddenAddress(host)) {
      throw importError(`Fetching from "${host}" is not allowed.`, 'IMPORT_URL_FORBIDDEN', { host });
    }
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw importError(`Could not resolve host "${host}".`, 'IMPORT_URL_UNRESOLVABLE', { host });
  }
  // EVERY address must be public — a mixed answer is exactly the rebinding
  // trick this guard exists for.
  for (const { address } of addrs) {
    if (isForbiddenAddress(address)) {
      throw importError(`Fetching from "${host}" is not allowed.`, 'IMPORT_URL_FORBIDDEN', { host });
    }
  }
}

export function parseImportUrl(raw: string): URL {
  if (raw.length > MAX_URL_CHARS) {
    throw importError(`URL exceeds ${MAX_URL_CHARS} characters.`, 'IMPORT_URL_INVALID');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw importError(`Malformed URL.`, 'IMPORT_URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw importError(
      `Unsupported URL scheme "${url.protocol}" — only http and https can be imported.`,
      'IMPORT_URL_INVALID',
    );
  }
  return url;
}

/** Read the body with a hard byte cap (counts decoded UTF-8 characters). */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > MAX_HTML_CHARS) {
      await reader.cancel().catch(() => {});
      throw importError(
        `Fetched page exceeds the ${MAX_HTML_CHARS.toLocaleString('en-US')}-character import cap.`,
        'IMPORT_CONTENT_TOO_LARGE',
        { max: MAX_HTML_CHARS },
      );
    }
  }
  out += decoder.decode();
  return out;
}

/**
 * Fetch an HTML page under the egress policy above. Follows up to
 * MAX_REDIRECTS manually, re-validating every hop.
 */
export async function fetchWebPage(rawUrl: string): Promise<WebFetchResult> {
  let url = parseImportUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      await assertHostAllowed(url);
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'user-agent': 'hadron-server-import/1.0 (+https://hadronmemory.com)',
          },
        });
      } catch (err) {
        throw importError(
          controller.signal.aborted
            ? `Import fetch timed out after ${TOTAL_TIMEOUT_MS / 1000}s.`
            : 'Import fetch failed.',
          controller.signal.aborted ? 'IMPORT_FETCH_TIMEOUT' : 'IMPORT_FETCH_FAILED',
          { cause: String(err) },
        );
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        // Drain/cancel the redirect body so the socket is released.
        await res.body?.cancel().catch(() => {});
        if (!location) {
          throw importError(`Redirect without a Location header.`, 'IMPORT_FETCH_FAILED', {
            status: res.status,
          });
        }
        if (hop >= MAX_REDIRECTS) {
          throw importError(`Too many redirects (max ${MAX_REDIRECTS}).`, 'IMPORT_FETCH_FAILED');
        }
        url = parseImportUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw importError(`Fetch failed with HTTP ${res.status}.`, 'IMPORT_FETCH_FAILED', {
          status: res.status,
        });
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw importError(
          `Unsupported content-type "${contentType}" — only HTML pages can be imported by URL in v1.`,
          'IMPORT_UNSUPPORTED_CONTENT_TYPE',
          { contentType },
        );
      }
      const html = await readCapped(res);
      return { html, finalUrl: url.toString() };
    }
  } finally {
    clearTimeout(timer);
  }
}
