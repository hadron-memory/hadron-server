/**
 * Web run tools (#628) — pure units. Mocks webfetchClient; no network, no DB.
 * Asserts op dispatch, the cost/retry posture, arg validation, and registry
 * membership.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../webfetchClient.js', () => ({
  fetchUrl: vi.fn(),
  httpRequest: vi.fn(),
  createPoll: vi.fn(),
  getPoll: vi.fn(),
  listPolls: vi.fn(),
  cancelPoll: vi.fn(),
}));

import { fetchUrl, httpRequest } from '../../webfetchClient.js';
import { webFetch, webRequest, resolveRunTools } from './index.js';

const stubCtx = (log = vi.fn()) => ({ log, db: {} as never, run: {} as never, principal: {} as never });

beforeEach(() => vi.clearAllMocks());

describe('web_fetch', () => {
  it('is a cost-0 (retry-safe read) tool that calls fetch-url and passes the result through', async () => {
    expect(webFetch.cost).toBe(0);
    const result = { finalUrl: 'https://x/', status: 200, contentType: 'text/html', title: 'X', content: '# X', truncated: false, source: 'external' };
    vi.mocked(fetchUrl).mockResolvedValueOnce(result as never);
    const log = vi.fn();
    const out = await webFetch.execute(stubCtx(log), { url: 'https://x', format: 'markdown', maxBytes: 1000 });
    expect(fetchUrl).toHaveBeenCalledWith({ url: 'https://x', format: 'markdown', maxBytes: 1000 });
    expect(out).toBe(result);
    // The hop trail logs status + final URL only (no body/headers).
    expect(log).toHaveBeenCalledWith('web_fetch 200 https://x/');
  });

  it('drops an unknown format rather than forwarding it (the tool defaults to markdown)', async () => {
    vi.mocked(fetchUrl).mockResolvedValueOnce({ finalUrl: 'https://x', status: 200 } as never);
    await webFetch.execute(stubCtx(), { url: 'https://x', format: 'exe' });
    expect(fetchUrl).toHaveBeenCalledWith({ url: 'https://x' });
  });

  it('requires a url', async () => {
    await expect(webFetch.execute(stubCtx(), {})).rejects.toThrow(/"url" is required/);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('redacts the query/fragment from the final URL before logging (no token leak into the hop trail)', async () => {
    vi.mocked(fetchUrl).mockResolvedValueOnce({ finalUrl: 'https://x/p?token=SECRET#frag', status: 200 } as never);
    const log = vi.fn();
    await webFetch.execute(stubCtx(log), { url: 'https://x' });
    expect(log).toHaveBeenCalledWith('web_fetch 200 https://x/p');
    expect((log.mock.calls[0]![0] as string)).not.toContain('SECRET');
  });

  it('drops a non-positive or fractional maxBytes', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ finalUrl: 'https://x', status: 200 } as never);
    await webFetch.execute(stubCtx(), { url: 'https://x', maxBytes: -5 });
    expect(fetchUrl).toHaveBeenLastCalledWith({ url: 'https://x' });
    await webFetch.execute(stubCtx(), { url: 'https://x', maxBytes: 1.5 });
    expect(fetchUrl).toHaveBeenLastCalledWith({ url: 'https://x' });
  });
});

describe('web_request', () => {
  it('is a cost-1 (side-effecting, never auto-retried) tool that calls http-request', async () => {
    expect(webRequest.cost).toBe(1);
    const result = { method: 'POST', finalUrl: 'https://api/', status: 201, headers: {}, contentType: 'application/json', body: { id: 1 }, truncated: false };
    vi.mocked(httpRequest).mockResolvedValueOnce(result as never);
    const out = await webRequest.execute(stubCtx(), {
      method: 'post',
      url: 'https://api',
      json: { a: 1 },
      headers: { 'x-y': 'z' },
    });
    expect(httpRequest).toHaveBeenCalledWith({
      method: 'POST', // upper-cased
      url: 'https://api',
      json: { a: 1 },
      headers: { 'x-y': 'z' },
    });
    expect(out).toBe(result);
  });

  it('rejects an unsupported method before any outbound call', async () => {
    await expect(webRequest.execute(stubCtx(), { method: 'TRACE', url: 'https://api' })).rejects.toThrow(
      /unsupported method/,
    );
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('rejects passing both body and json (contract is exclusive)', async () => {
    await expect(
      webRequest.execute(stubCtx(), { method: 'POST', url: 'https://api', body: 'x', json: { a: 1 } }),
    ).rejects.toThrow(/"body" OR "json"/);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('rejects a non-object headers value (never forwards an array as headers)', async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({ method: 'GET', finalUrl: 'https://api', status: 200 } as never);
    await webRequest.execute(stubCtx(), { method: 'GET', url: 'https://api', headers: ['a', 'b'] });
    expect(httpRequest).toHaveBeenCalledWith({ method: 'GET', url: 'https://api' });
  });

  it('coerces non-string header values to strings and drops null/undefined', async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({ method: 'GET', finalUrl: 'https://api', status: 200 } as never);
    await webRequest.execute(stubCtx(), {
      method: 'GET',
      url: 'https://api',
      headers: { 'x-count': 3, 'x-flag': true, 'x-skip': null },
    });
    expect(httpRequest).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api',
      headers: { 'x-count': '3', 'x-flag': 'true' },
    });
  });

  it('redacts the query/fragment from the logged URL', async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({ method: 'POST', finalUrl: 'https://api/x?sig=SECRET', status: 200 } as never);
    const log = vi.fn();
    await webRequest.execute(stubCtx(log), { method: 'POST', url: 'https://api/x?sig=SECRET' });
    expect(log).toHaveBeenCalledWith('web_request POST 200 https://api/x');
  });
});

describe('registry', () => {
  it('web_fetch and web_request are opt-in (resolvable), not always-on', () => {
    const { tools, unknown } = resolveRunTools(['web_fetch', 'web_request']);
    expect(unknown).toEqual([]);
    const names = tools.map((t) => t.name);
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_request');
    // Always-on pair only — not the web tools — when nothing is declared.
    const bare = resolveRunTools([]).tools.map((t) => t.name);
    expect(bare).not.toContain('web_fetch');
    expect(bare).not.toContain('web_request');
  });
});
