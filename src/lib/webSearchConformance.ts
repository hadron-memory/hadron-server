import { WEB_SEARCH_CONTRACT_VERSION, contractVersionMismatch } from './webSearchClient.js';

/**
 * The core-owned conformance fixture set for `web-search@1` (#647 S1,
 * `cor:web:020:01`: "interchangeable means passes the same conformance set",
 * and the issue: "core owns it and gates a tool on it").
 *
 * A fixture is a canonical request plus the envelope rules the answer must
 * satisfy. The set is data (`WEB_SEARCH_CONFORMANCE_FIXTURES`) and the runner
 * (`runWebSearchConformance`) is endpoint-agnostic: it speaks the same request
 * envelope as `webSearchClient.webSearch` to any base URL, so the first-party
 * tool and a third-party one are judged by identical rules. It never branches
 * on which provider or tool answered.
 *
 * This set is a PROMOTION check an operator runs before pointing a deployment
 * at a tool; nothing at request time re-runs it. Enforcing it per tool instance
 * needs the trust-tier registry (S2, held on its ruling), not this slice.
 * The unknown-`providerOptions` fixture proves the tool ACCEPTS the key and
 * still answers a valid envelope; it cannot prove the key changed nothing.
 *
 * What a fixture checks is only what the spec makes durable: the result shape
 * (title, url, snippet, a numeric rank; neither the scale nor an ordering direction is ruled, so none is imposed), the `source: 'external'` tag,
 * `count` honored as an upper bound, and unknown `providerOptions` safely
 * ignored. It deliberately does NOT pin result content, provider identity,
 * ordering quality or latency (all tunable, not contract).
 *
 * Versioning: a tool declares the version it satisfies. A declaration other
 * than `WEB_SEARCH_CONTRACT_VERSION` is refused BEFORE any request, so a
 * v2-only tool is never sent a v1 query it cannot read (`contractVersionMismatch`,
 * defined in `webSearchClient` and shared with `webSearch`). The fixtures define v1 only: when
 * the contract bumps, the new version brings its own set.
 *
 * An answer with an empty `results` list conforms (no result is no violation);
 * the fixtures prove the envelope, not that a tool finds anything.
 *
 * Not in this slice: the org-scoped trust-tier registry (S2, held on its
 * ruling) and any credential. The runner sends none.
 */

/** One canonical case: the request to send, and the rules the answer must meet. */
export interface WebSearchConformanceFixture {
  /** Unique, stable name; appears in failure lines. */
  name: string;
  /** What the spec rule behind it is, for a reader of a failure. */
  rule: string;
  /** The request body fields beyond `version` (the runner adds the version). */
  request: { query: string; count?: number; freshness?: string; locale?: string; providerOptions?: Record<string, unknown> };
  /** When set, the answer must hold at most this many results. */
  maxResults?: number;
}

export const WEB_SEARCH_CONFORMANCE_FIXTURES: readonly WebSearchConformanceFixture[] = [
  {
    name: 'plain-query',
    rule: 'cor:web:020:01 canonical response: ordered references {title,url,snippet,rank}, tagged external',
    request: { query: 'hadron conformance' },
  },
  {
    name: 'count-is-an-upper-bound',
    rule: 'cor:web:020:01 generic refinement: result count',
    request: { query: 'hadron conformance', count: 2 },
    maxResults: 2,
  },
  {
    name: 'freshness-and-locale-accepted',
    rule: 'cor:web:020:01 generic refinements: freshness window and locale',
    request: { query: 'hadron conformance', freshness: 'week', locale: 'en-US' },
  },
  {
    name: 'unknown-providerOptions-are-accepted',
    rule: 'cor:web:020:01 opaque options bag: an unknown key is accepted (not refused) and the answer stays a valid envelope',
    request: { query: 'hadron conformance', providerOptions: { 'conformance.unknown-option': true } },
  },
];

/**
 * Check a decoded answer against the `web-search@1` envelope. Returns one line
 * per violation (empty = conforming), each naming the offending field so a
 * failure points at the rule, not just at a fixture.
 */
export function checkSearchEnvelope(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['envelope: the answer is not a JSON object'];
  }
  const p = payload as Record<string, unknown>;
  const out: string[] = [];
  if (!Array.isArray(p.results)) {
    out.push('results: missing or not an array');
  } else {
    p.results.forEach((r, i) => {
      if (r === null || typeof r !== 'object') {
        out.push(`results[${i}]: not an object`);
        return;
      }
      const row = r as Record<string, unknown>;
      for (const field of ['title', 'url', 'snippet'] as const) {
        if (typeof row[field] !== 'string') out.push(`results[${i}].${field}: missing or not a string`);
      }
      // cor:web:020:01 rules that each result carries a rank. It rules neither
      // the representation beyond the client's `number` nor a scale or direction,
      // so only a finite number is required; ordering is the list's own.
      if (typeof row.rank !== 'number' || !Number.isFinite(row.rank)) out.push(`results[${i}].rank: missing or not a number`);
    });
  }
  if (p.source !== 'external') out.push(`source: ${JSON.stringify(p.source)}, expected "external"`);
  if (p.contractVersion !== undefined && p.contractVersion !== WEB_SEARCH_CONTRACT_VERSION) {
    out.push(`contractVersion: ${JSON.stringify(p.contractVersion)}, expected ${WEB_SEARCH_CONTRACT_VERSION}`);
  }
  return out;
}

export interface WebSearchConformanceReport {
  passed: boolean;
  /** Set when the tool was refused before any request (declared another version). */
  refused?: string;
  /** One line per violation, prefixed with the fixture name. */
  failures: string[];
  /** Per-fixture outcome, in fixture order. Empty when refused. */
  results: Array<{ name: string; passed: boolean; failures: string[] }>;
}

export interface RunWebSearchConformanceOptions {
  /** Tool base URL, e.g. http://hadrontool-websearch:8080. */
  baseUrl: string;
  /** Internal-plane bearer token, sent when set. */
  token?: string;
  /** The contract version the tool declares; absent = not declared. */
  declaredVersion?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 30s, the client's own). */
  timeoutMs?: number;
}

/**
 * Run the whole fixture set against one endpoint. One request per fixture, no
 * retry, no credential. Network and decoding faults are failures of that
 * fixture (a tool that cannot answer does not conform), never thrown.
 */
export async function runWebSearchConformance(opts: RunWebSearchConformanceOptions): Promise<WebSearchConformanceReport> {
  const refused = contractVersionMismatch(opts.declaredVersion);
  if (refused) return { passed: false, refused, failures: [refused], results: [] };

  const doFetch = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const results: WebSearchConformanceReport['results'] = [];

  for (const fixture of WEB_SEARCH_CONFORMANCE_FIXTURES) {
    const failures: string[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await doFetch(`${baseUrl}/ops/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify({ version: WEB_SEARCH_CONTRACT_VERSION, ...fixture.request }),
        signal: controller.signal,
      });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        failures.push('envelope: the answer is not valid JSON');
      }
      if (!res.ok) {
        const code =
          payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
            ? ` (${(payload as { error: string }).error})`
            : '';
        // The status and the tool's own error text are always reported. The
        // unknown key is blamed only when a 400/422 body itself names it; a
        // bare 400/422 may be unrelated request validation.
        const named =
          fixture.request.providerOptions !== undefined &&
          (res.status === 400 || res.status === 422) &&
          JSON.stringify(payload ?? '').match(/providerOptions|conformance\.unknown-option/) !== null;
        failures.push(
          named
            ? `providerOptions: the tool refused the unknown option with HTTP ${res.status}${code}, naming it; it must safely accept and ignore it`
            : `status: HTTP ${res.status}${code}, expected 200`,
        );
      } else if (failures.length === 0) {
        failures.push(...checkSearchEnvelope(payload));
        const n = (payload as { results?: unknown } | null)?.results;
        if (fixture.maxResults !== undefined && Array.isArray(n) && n.length > fixture.maxResults) {
          failures.push(`count: ${n.length} results for count=${fixture.request.count}, expected at most ${fixture.maxResults}`);
        }
      }
    } catch (err) {
      failures.push(`request: ${controller.signal.aborted ? 'timed out' : 'failed'} (${String(err).slice(0, 200)})`);
    } finally {
      clearTimeout(timer);
    }
    results.push({ name: fixture.name, passed: failures.length === 0, failures });
  }

  const failures = results.flatMap((r) => r.failures.map((f) => `${r.name}: ${f}`));
  return { passed: failures.length === 0, failures, results };
}
