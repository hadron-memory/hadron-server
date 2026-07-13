/**
 * Web search run tool (#647) — pure unit. Mocks webSearchClient; no network,
 * no DB. Asserts the cost/retry posture, arg validation, provider-agnostic
 * surface (no provider/auth/options leak to the LLM), the references-only
 * pass-through, the secrets-light hop log, and registry membership.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../webSearchClient.js', () => ({
  webSearch: vi.fn(),
}));

import { webSearch } from '../../webSearchClient.js';
import { webSearchTool, resolveRunTools } from './index.js';

const stubCtx = (log = vi.fn()) => ({ log, db: {} as never, run: {} as never, principal: {} as never });

const RESULTS = {
  results: [
    { title: 'A', url: 'https://a/', snippet: 'sa', rank: 1 },
    { title: 'B', url: 'https://b/', snippet: 'sb', rank: 2 },
  ],
  contractVersion: 'web-search@1',
  source: 'external',
};

beforeEach(() => vi.clearAllMocks());

describe('web_search', () => {
  it('is a cost-0 (retry-safe read) tool that calls webSearch and passes the envelope through', async () => {
    expect(webSearchTool.cost).toBe(0);
    vi.mocked(webSearch).mockResolvedValueOnce(RESULTS as never);
    const log = vi.fn();
    const out = await webSearchTool.execute(stubCtx(log), {
      query: 'hadron memory',
      count: 5,
      freshness: 'week',
      locale: 'en-US',
    });
    expect(webSearch).toHaveBeenCalledWith({ query: 'hadron memory', count: 5, freshness: 'week', locale: 'en-US' });
    expect(out).toBe(RESULTS);
    // Hop trail carries the result count only — never the query or result URLs.
    expect(log).toHaveBeenCalledWith('web_search (2 results)');
    const logged = log.mock.calls[0]![0] as string;
    expect(logged).not.toContain('hadron memory');
    expect(logged).not.toContain('https://a');
  });

  it('requires a non-empty query', async () => {
    await expect(webSearchTool.execute(stubCtx(), {})).rejects.toThrow(/"query" is required/);
    await expect(webSearchTool.execute(stubCtx(), { query: '   ' })).rejects.toThrow(/"query" is required/);
    expect(webSearch).not.toHaveBeenCalled();
  });

  it('trims the query and omits blank/invalid refinements', async () => {
    vi.mocked(webSearch).mockResolvedValueOnce({ results: [] } as never);
    await webSearchTool.execute(stubCtx(), { query: '  cats  ', freshness: '', locale: '' });
    expect(webSearch).toHaveBeenCalledWith({ query: 'cats' });
  });

  it('drops a non-positive or fractional count', async () => {
    vi.mocked(webSearch).mockResolvedValue({ results: [] } as never);
    await webSearchTool.execute(stubCtx(), { query: 'x', count: -1 });
    expect(webSearch).toHaveBeenLastCalledWith({ query: 'x' });
    await webSearchTool.execute(stubCtx(), { query: 'x', count: 2.5 });
    expect(webSearch).toHaveBeenLastCalledWith({ query: 'x' });
  });

  it('does not expose provider, credential, or provider-options to the LLM surface', () => {
    const props = (webSearchTool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(['count', 'freshness', 'locale', 'query']);
    expect(props).not.toHaveProperty('provider');
    expect(props).not.toHaveProperty('auth');
    expect(props).not.toHaveProperty('providerOptions');
  });
});

describe('registry', () => {
  it('web_search is opt-in (resolvable), not always-on', () => {
    const { tools, unknown } = resolveRunTools(['web_search']);
    expect(unknown).toEqual([]);
    expect(tools.map((t) => t.name)).toContain('web_search');
    // Always-on pair only — not web_search — when nothing is declared.
    expect(resolveRunTools([]).tools.map((t) => t.name)).not.toContain('web_search');
  });
});
