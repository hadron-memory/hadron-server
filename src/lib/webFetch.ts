/**
 * SSRF-guarded synchronous web fetch for importNode (#457, sync v1).
 *
 * Egress policy — Spec: cor:api:130:02.
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
 * extension) — accepted-and-expiring per cor:api:130:02.
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
    // IPv4 embedded in IPv6 — mapped (::ffff:0:0/96) or the deprecated
    // IPv4-compatible form (::/96) — must be validated by the IPv4 rules.
    // BOTH textual shapes count: dotted (::ffff:127.0.0.1) AND hex
    // (::ffff:7f00:1) — the hex form bypassed a dotted-only unwrap
    // (PR-486 review, Codex P1 / Gemini critical).
    const embedded = embeddedIpv4(lower);
    if (embedded != null) return isForbiddenAddress(embedded);
    if (lower === '::' || lower === '::1') return true; // unspecified + loopback
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    return false;
  }
  // Not an IP at all — callers pass resolver output, so treat as forbidden.
  return true;
}

/**
 * Extract the IPv4 address embedded in an IPv4-mapped (::ffff:0:0/96) or
 * IPv4-compatible (::/96, deprecated but OS-honored) IPv6 literal, in EITHER
 * textual shape (dotted or hex groups). Returns null when the address is
 * plain IPv6. Works on the full 8-group expansion so `::` compression and
 * leading-zero variants can't dodge the check.
 */
export function embeddedIpv4(ip6: string): string | null {
  let s = ip6.toLowerCase();
  // Fold a trailing dotted-quad into two hex groups so the expansion below
  // is uniform.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[2].split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255)) return null;
    s =
      dotted[1] +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ':' +
      ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  const g = groups.map((x) => parseInt(x || '0', 16));
  if (g.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  const zeroTo = (i: number) => g.slice(0, i).every((n) => n === 0);
  const isMapped = zeroTo(5) && g[5] === 0xffff;
  const isCompat = zeroTo(6) && (g[6] !== 0 || g[7] > 1); // excludes :: and ::1 (plain v6)
  if (!isMapped && !isCompat) return null;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
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

/**
 * Validate an arbitrary outbound URL against the egress policy WITHOUT
 * fetching it (scheme + resolved-address classes). Used by outbound
 * callbacks (webhook `callbackUrl`, spec 040 §8) — the cor:api:130:02
 * posture applies to every server-originated request, not only imports.
 */
export async function assertUrlAllowed(raw: string): Promise<URL> {
  const url = parseImportUrl(raw);
  await assertHostAllowed(url);
  return url;
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
      // Body-read failures happen OUTSIDE the fetch() try above — a page
      // that returns headers then stalls aborts during reader.read(), and
      // a raw AbortError must not leak past the typed-error contract
      // (PR-486 review, Codex P2).
      let html: string;
      try {
        html = await readCapped(res);
      } catch (err) {
        if (err instanceof GraphQLError) throw err; // our own size-cap error
        throw importError(
          controller.signal.aborted
            ? `Import fetch timed out after ${TOTAL_TIMEOUT_MS / 1000}s.`
            : 'Import fetch failed while reading the response body.',
          controller.signal.aborted ? 'IMPORT_FETCH_TIMEOUT' : 'IMPORT_FETCH_FAILED',
          { cause: String(err) },
        );
      }
      return { html, finalUrl: url.toString() };
    }
  } finally {
    clearTimeout(timer);
  }
}
