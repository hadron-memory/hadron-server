/**
 * #647 S1 — the core-owned `web-search@1` conformance fixture set
 * (`cor:web:020:01`: "interchangeable means passes the same conformance set").
 *
 * Pure unit: every tool is a stub `fetch`. Pins, each red on main because the
 * fixture set and the version refusal do not exist there:
 *   1. a conforming stub passes every fixture;
 *   2. a stub that drops `rank` fails, and the report names the check;
 *   3. a stub that drops the `source: 'external'` tag fails likewise;
 *   4. a tool configured as declaring another contract version is refused by
 *      `webSearch` BEFORE any request is sent;
 *   5. the same refusal holds for the fixture runner (zero requests);
 *   6. the envelope rules the fixtures rest on (contiguous 1-based rank,
 *      string title/url/snippet, a response-side version that differs).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { webSearch, WEB_SEARCH_CONTRACT_VERSION } from './webSearchClient.js';
import {
  WEB_SEARCH_CONFORMANCE_FIXTURES,
  checkSearchEnvelope,
  runWebSearchConformance,
} from './webSearchConformance.js';

type Req = { version?: string; query?: string; count?: number; providerOptions?: Record<string, unknown> };

const result = (rank: number) => ({ title: `t${rank}`, url: `https://example.test/${rank}`, snippet: `s${rank}`, rank });

/** A conforming tool: honors `count`, ignores unknown providerOptions, tags the envelope. */
function conformingFetch(mutate?: (body: Record<string, unknown>) => Record<string, unknown>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(init!.body as string) as Req;
    const n = Math.min(req.count ?? 5, 5);
    const body: Record<string, unknown> = {
      results: Array.from({ length: n }, (_, i) => result(i + 1)),
      contractVersion: WEB_SEARCH_CONTRACT_VERSION,
      source: 'external',
    };
    const out = mutate ? mutate(body) : body;
    return { ok: true, status: 200, json: async () => out } as unknown as Response;
  });
}

const run = (fetchImpl: ReturnType<typeof conformingFetch>, declaredVersion?: string) =>
  runWebSearchConformance({ baseUrl: 'http://tool.test:8080', fetch: fetchImpl as unknown as typeof fetch, declaredVersion });

describe('#647 S1 web-search@1 conformance fixtures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('ships a non-empty, uniquely named fixture set', () => {
    expect(WEB_SEARCH_CONFORMANCE_FIXTURES.length).toBeGreaterThanOrEqual(4);
    const names = WEB_SEARCH_CONFORMANCE_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a conforming stub passes every fixture', async () => {
    const report = await run(conformingFetch());
    expect(report.refused).toBeUndefined();
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(WEB_SEARCH_CONFORMANCE_FIXTURES.length);
  });

  it('every fixture request carries the contract version and the canonical query', async () => {
    const f = conformingFetch();
    await run(f);
    expect(f).toHaveBeenCalledTimes(WEB_SEARCH_CONFORMANCE_FIXTURES.length);
    for (const call of f.mock.calls) {
      expect(call[0]).toBe('http://tool.test:8080/ops/search');
      const req = JSON.parse(call[1]!.body as string) as Req;
      expect(req.version).toBe(WEB_SEARCH_CONTRACT_VERSION);
      expect(typeof req.query).toBe('string');
    }
  });

  it('FAILS a stub that drops rank, and names the missing field', async () => {
    const report = await run(
      conformingFetch((b) => ({
        ...b,
        results: (b.results as Array<Record<string, unknown>>).map(({ rank: _rank, ...rest }) => rest),
      })),
    );
    expect(report.passed).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.join('\n')).toMatch(/rank/);
    // The dropped field is reported as missing, not as a wrong position.
    expect(report.failures.join('\n')).toMatch(/rank: missing or not an integer/);
  });

  it("FAILS a stub that drops the source: 'external' tag, and names it", async () => {
    const report = await run(conformingFetch(({ source: _source, ...rest }) => rest));
    expect(report.passed).toBe(false);
    expect(report.failures.join('\n')).toMatch(/source/);
  });

  it('FAILS a stub that ignores count (more results than asked for)', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 9 }, (_, i) => result(i + 1)),
        contractVersion: WEB_SEARCH_CONTRACT_VERSION,
        source: 'external',
      }),
    })) as unknown as ReturnType<typeof conformingFetch>;
    const report = await run(f);
    expect(report.passed).toBe(false);
    expect(report.failures.join('\n')).toMatch(/count/);
  });

  it('FAILS a stub that rejects an unknown providerOptions key (it MUST safely ignore it)', async () => {
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(init!.body as string) as Req;
      if (req.providerOptions && Object.keys(req.providerOptions).length > 0) {
        return { ok: false, status: 400, json: async () => ({ error: 'validation_error' }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [result(1)], contractVersion: WEB_SEARCH_CONTRACT_VERSION, source: 'external' }),
      } as unknown as Response;
    }) as unknown as ReturnType<typeof conformingFetch>;
    const report = await run(f);
    expect(report.passed).toBe(false);
    expect(report.failures.join('\n')).toMatch(/providerOptions/);
  });

  it('sends POST with the bearer token and the exact refinement fields', async () => {
    const f = conformingFetch();
    await runWebSearchConformance({ baseUrl: 'http://tool.test:8080/', token: 'tok', fetch: f as unknown as typeof fetch });
    for (const [url, init] of f.mock.calls) {
      expect(url).toBe('http://tool.test:8080/ops/search');
      expect(init!.method).toBe('POST');
      expect(init!.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    }
    const bodies = f.mock.calls.map((c) => JSON.parse(c[1]!.body as string) as Record<string, unknown>);
    expect(bodies.some((b) => b.freshness === 'week' && b.locale === 'en-US')).toBe(true);
    expect(bodies.some((b) => b.count === 2)).toBe(true);
  });

  it('reports a 500 on the unknown-option fixture as its status, NOT as an option refusal', async () => {
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(init!.body as string) as Req;
      if (req.providerOptions) return { ok: false, status: 500, json: async () => ({ error: 'upstream_unreachable' }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ results: [result(1)], contractVersion: WEB_SEARCH_CONTRACT_VERSION, source: 'external' }) } as unknown as Response;
    }) as unknown as ReturnType<typeof conformingFetch>;
    const report = await run(f);
    expect(report.passed).toBe(false);
    const text = report.failures.join('\n');
    expect(text).toMatch(/status: HTTP 500 \(upstream_unreachable\)/);
    expect(text).not.toMatch(/refused an unknown option/);
  });

  it('records a rejected request and a non-JSON answer as failures of that fixture, not throws', async () => {
    const down = vi.fn(async () => { throw new TypeError('connection refused'); }) as unknown as ReturnType<typeof conformingFetch>;
    const r1 = await run(down);
    expect(r1.passed).toBe(false);
    expect(r1.failures.join('\n')).toMatch(/request: failed/);
    const junk = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })) as unknown as ReturnType<typeof conformingFetch>;
    const r2 = await run(junk);
    expect(r2.passed).toBe(false);
    expect(r2.failures.join('\n')).toMatch(/not valid JSON/);
  });

  it('REFUSES a tool declaring another contract version in the runner, before any request', async () => {
    const f = conformingFetch();
    const report = await run(f, 'web-search@2');
    expect(report.passed).toBe(false);
    expect(report.refused).toMatch(/web-search@2/);
    expect(f).not.toHaveBeenCalled();
  });

  it('REFUSES a configured tool declaring another contract version in webSearch, before any request', async () => {
    vi.stubEnv('WEBSEARCH_TOOL_URL', 'http://tool.test:8080');
    vi.stubEnv('WEBSEARCH_TOOL_CONTRACT_VERSION', 'web-search@2');
    const fetchMock = conformingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const err = await webSearch({ query: 'hadron' }).catch((e) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe('WEBSEARCH_TOOL_CONTRACT_MISMATCH');
    expect((err as GraphQLError).message).toMatch(/web-search@2/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still searches when the configured declared version matches, or is unset', async () => {
    vi.stubEnv('WEBSEARCH_TOOL_URL', 'http://tool.test:8080');
    vi.stubEnv('WEBSEARCH_TOOL_CONTRACT_VERSION', '');
    const fetchMock = conformingFetch();
    vi.stubGlobal('fetch', fetchMock);
    await webSearch({ query: 'hadron' });
    vi.stubEnv('WEBSEARCH_TOOL_CONTRACT_VERSION', WEB_SEARCH_CONTRACT_VERSION);
    await webSearch({ query: 'hadron' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('#647 S1 checkSearchEnvelope rules', () => {
  const good = { results: [result(1), result(2)], contractVersion: WEB_SEARCH_CONTRACT_VERSION, source: 'external' };

  it('accepts a well-formed envelope, and an empty result list', () => {
    expect(checkSearchEnvelope(good)).toEqual([]);
    expect(checkSearchEnvelope({ ...good, results: [] })).toEqual([]);
  });

  it('rejects a non-object payload and a missing results array', () => {
    expect(checkSearchEnvelope(null).length).toBeGreaterThan(0);
    expect(checkSearchEnvelope({ source: 'external' }).join('\n')).toMatch(/results/);
  });

  it('rejects non-contiguous, non-1-based, duplicate, or non-integer rank', () => {
    for (const ranks of [[2, 3], [1, 3], [1, 1], [1.5, 2]]) {
      const out = checkSearchEnvelope({ ...good, results: ranks.map((r) => ({ ...result(1), rank: r })) });
      expect(out.join('\n'), JSON.stringify(ranks)).toMatch(/rank/);
    }
  });

  it('rejects a result missing or mistyping title, url or snippet', () => {
    for (const field of ['title', 'url', 'snippet'] as const) {
      const bad = { ...result(1), [field]: 7 };
      expect(checkSearchEnvelope({ ...good, results: [bad] }).join('\n'), field).toMatch(new RegExp(field));
    }
  });

  it('rejects a source other than external, and a response-side version that differs', () => {
    expect(checkSearchEnvelope({ ...good, source: 'internal' }).join('\n')).toMatch(/source/);
    expect(checkSearchEnvelope({ ...good, contractVersion: 'web-search@2' }).join('\n')).toMatch(/contractVersion/);
  });
});
