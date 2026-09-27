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
 * DNS-rebinding pin (issue #645): the resolve-then-fetch sequence was a
 * TOCTOU — a hostile nameserver could answer the validation lookup with a
 * public address and the fetch's own lookup with a private one, steering the
 * outbound socket at an internal address. Closed by pinning: assertHostAllowed
 * returns the validated addresses, and the fetch runs through a per-request
 * undici dispatcher whose connect `lookup` returns ONLY those addresses, so no
 * second resolution happens and the socket can only land on a cleared address.
 * The Host header + TLS SNI still derive from the URL hostname, so cert
 * validation is intact — only the connect IP is pinned.
 *
 * Auth boundary (issue #457): this fetch carries NO user credentials —
 * authenticated pages must come through importNode's inline `content` path.
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
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
      // The rest of the IANA special-purpose registry: none of it is a
      // public destination, and a network may route any of it internally
      // (#1380 review).
      (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) || // 192.0.0/24 protocol assignments, 192.0.2/24 TEST-NET-1
      (a === 192 && b === 88 && octets[2] === 99) || // 192.88.99/24 6to4 relay anycast (deprecated)
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
      (a === 198 && b === 51 && octets[2] === 100) || // 198.51.100/24 TEST-NET-2
      (a === 203 && b === 0 && octets[2] === 113) || // 203.0.113/24 TEST-NET-3
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
    const g = ipv6Groups(lower);
    if (!g) return true; // unparseable: never fetch it
    // NAT64's well-known prefix carries an IPv4 destination in its low 32
    // bits; on an IPv6-only host it is how PUBLIC IPv4 is reached, so the
    // embedded address is judged, not the prefix.
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) {
      return isForbiddenAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    // SIIT's IPv4-translated form (::ffff:0:a.b.c.d, RFC 2765 ::ffff:0:0:0/96)
    // likewise reaches the IPv4 address in its low 32 bits, so that address is
    // judged (#1380 review): on a network routing the prefix, ::ffff:0:a00:1
    // is 10.0.0.1.
    if (g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0) {
      return isForbiddenAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    return (
      g.every((n) => n === 0) || // :: unspecified
      (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) || // ::1 loopback
      (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) || // 64:ff9b:1::/48 local-use NAT64
      (g[0] === 0x100 && g.slice(1, 4).every((n) => n === 0)) || // 100::/64 discard
      (g[0] === 0x2001 && g[1] < 0x200) || // 2001::/23 IETF protocol assignments (Teredo, ORCHID, ...)
      (g[0] === 0x2001 && g[1] === 0xdb8) || // 2001:db8::/32 documentation
      g[0] === 0x2002 || // 2002::/16 6to4 (embeds IPv4; deprecated)
      (g[0] & 0xfff0) === 0x3ff0 || // 3fff::/20 documentation
      g[0] === 0x5f00 || // 5f00::/16 SRv6 SIDs
      (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 ULA
      (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated, still routable on some hosts)
      (g[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
      // Everything outside global unicast (2000::/3) is unallocated or
      // special, and a network may route it internally, so it is refused by
      // default (#1380 review). The translated forms that legitimately reach
      // public IPv4 were judged above by their embedded address.
      (g[0] & 0xe000) !== 0x2000
    );
  }
  // Not an IP at all — callers pass resolver output, so treat as forbidden.
  return true;
}

/**
 * The eight 16-bit groups of an IPv6 literal, `::` expanded and a trailing
 * dotted quad folded in, so range checks compare numbers rather than text
 * (leading zeros and compression can't dodge them). Null if unparseable.
 */
export function ipv6Groups(ip6: string): number[] | null {
  let s = ip6.toLowerCase();
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[2].split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255)) return null;
    s = dotted[1] + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array<string>(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  if (groups.some((x) => !/^[0-9a-f]{0,4}$/.test(x))) return null;
  const g = groups.map((x) => parseInt(x || '0', 16));
  if (g.some((n) => Number.isNaN(n))) return null;
  return g;
}

/**
 * Extract the IPv4 address embedded in an IPv4-mapped (::ffff:0:0/96) or
 * IPv4-compatible (::/96, deprecated but OS-honored) IPv6 literal, in EITHER
 * textual shape (dotted or hex groups). Returns null when the address is
 * plain IPv6. Works on the full 8-group expansion so `::` compression and
 * leading-zero variants can't dodge the check.
 */
export function embeddedIpv4(ip6: string): string | null {
  const g = ipv6Groups(ip6);
  if (!g) return null;
  const zeroTo = (i: number) => g.slice(0, i).every((n) => n === 0);
  const isMapped = zeroTo(5) && g[5] === 0xffff;
  const isCompat = zeroTo(6) && (g[6] !== 0 || g[7] > 1); // excludes :: and ::1 (plain v6)
  if (!isMapped && !isCompat) return null;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

/**
 * Validate a URL's host: IP literals directly, hostnames via full resolution.
 * Returns the validated addresses so the caller can PIN the TCP connection to
 * them — fetch would otherwise re-resolve at connect time, reopening the
 * DNS-rebinding TOCTOU this guard exists to close (issue #645).
 */
async function assertHostAllowed(url: URL): Promise<LookupAddress[]> {
  // URL.hostname wraps IPv6 in brackets — strip for isIP/lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isForbiddenAddress(host)) {
      throw importError(`Fetching from "${host}" is not allowed.`, 'IMPORT_URL_FORBIDDEN', { host });
    }
    return [{ address: host, family: literalFamily }];
  }
  let addrs: LookupAddress[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw importError(`Could not resolve host "${host}".`, 'IMPORT_URL_UNRESOLVABLE', { host });
  }
  // An empty answer must fail here, not fall through to a fetch (or an empty
  // pin set) — treat it as unresolvable.
  if (addrs.length === 0) {
    throw importError(`Could not resolve host "${host}".`, 'IMPORT_URL_UNRESOLVABLE', { host });
  }
  // EVERY address must be public — a mixed answer is exactly the rebinding
  // trick this guard exists for.
  for (const { address } of addrs) {
    if (isForbiddenAddress(address)) {
      throw importError(`Fetching from "${host}" is not allowed.`, 'IMPORT_URL_FORBIDDEN', { host });
    }
  }
  return addrs;
}

/**
 * The connect-time `lookup` the pin installs: it never re-resolves, it just
 * hands back the addresses assertHostAllowed already cleared. Re-checks them as
 * a last line of defense so a forbidden address can never reach the socket even
 * if that invariant ever regressed.
 *
 * undici's connector calls this with `{ all: true }` (and no family), expecting
 * the array form — so that is the live path; the single-address branch is a
 * fallback for other lookup callers.
 *
 * `forbidden` defaults to the import egress policy; a caller with a narrower
 * documented exception (the AI endpoint guard's dev-only loopback, #1373)
 * passes its own predicate so the re-check matches what it validated.
 */
export function pinnedLookup(addresses: LookupAddress[], forbidden: (ip: string) => boolean = isForbiddenAddress) {
  return (
    _hostname: string,
    options: { all?: boolean; family?: number } | number | null | undefined,
    callback: (err: Error | null, address?: LookupAddress[] | string, family?: number) => void,
  ): void => {
    if (addresses.length === 0) {
      callback(new Error('no pinned addresses available'));
      return;
    }
    if (addresses.some((a) => forbidden(a.address))) {
      callback(new Error('pinned address failed re-validation'));
      return;
    }
    // Node's dns.lookup contract allows `options` to be a bare family integer
    // (lookup(host, 4, cb)); normalize so family filtering isn't silently
    // skipped in that form (Gemini review on #646).
    const opt = typeof options === 'number' ? { family: options } : options;
    const family = opt?.family;
    // Honor an explicitly requested family (4/6); 0 or unset means any.
    const wanted = family ? addresses.filter((a) => a.family === family) : addresses;
    if (wanted.length === 0) {
      callback(new Error(`no pinned address for family ${family}`));
      return;
    }
    if (opt?.all) callback(null, wanted);
    else callback(null, wanted[0].address, wanted[0].family);
  };
}

/** Per-request undici dispatcher that pins connections to the validated set. */
function pinnedDispatcher(addresses: LookupAddress[]): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(addresses) as unknown as LookupFunction } });
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
      const pin = await assertHostAllowed(url);
      // Pin the outbound socket to exactly the addresses just validated, so a
      // rebinding second resolution can't swap in a private IP (issue #645).
      const dispatcher = pinnedDispatcher(pin);
      try {
        let res: Response;
        try {
          res = await fetch(url, {
            redirect: 'manual',
            signal: controller.signal,
            dispatcher,
            headers: {
              accept: 'text/html,application/xhtml+xml',
              'user-agent': 'hadron-server-import/1.0 (+https://hadronmemory.com)',
            },
          } as RequestInit & { dispatcher: Agent });
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
      } finally {
        // Per-request agent — close it once this hop is done (body already
        // read/cancelled). Fire-and-forget: TCP teardown must not add to the
        // request's latency.
        dispatcher.close().catch(() => {});
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
