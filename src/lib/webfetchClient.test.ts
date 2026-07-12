/**
 * webfetchClient (#628) — pure unit. Mocks global fetch; no network, no tool.
 * Asserts the op path, typed-error mapping, and that credential-bearing input
 * never rides an error path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { fetchUrl, httpRequest, checkUrl } from './webfetchClient.js';

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errJson = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

/** Typed fetch stub so `.mock.calls[n]` carries the [url, init] tuple. */
const fetchStub = (impl: () => Promise<Response>) =>
  vi.fn((_url: string | URL | Request, _init?: RequestInit) => impl());

describe('webfetchClient', () => {
  beforeEach(() => {
    process.env.WEBFETCH_TOOL_URL = 'http://webfetch.test:8080';
    process.env.WEBFETCH_TOOL_TOKEN = 'shhh';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.WEBFETCH_TOOL_URL;
    delete process.env.WEBFETCH_TOOL_TOKEN;
  });

  it('posts fetch-url to the ops plane with the bearer token and trims a trailing slash', async () => {
    process.env.WEBFETCH_TOOL_URL = 'http://webfetch.test:8080/';
    const fetchMock = fetchStub(async () =>
      okJson({ finalUrl: 'https://x.example/', status: 200, contentType: 'text/html', title: 'X', content: '# X', truncated: false, source: 'external' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchUrl({ url: 'https://x.example', format: 'markdown' });

    expect(res.content).toBe('# X');
    expect(res.source).toBe('external');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://webfetch.test:8080/ops/fetch-url');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ authorization: 'Bearer shhh' });
    expect(JSON.parse(init!.body as string)).toEqual({ url: 'https://x.example', format: 'markdown' });
  });

  it('omits the authorization header when no token is set', async () => {
    delete process.env.WEBFETCH_TOOL_TOKEN;
    const fetchMock = fetchStub(async () => okJson({ finalUrl: 'https://x', status: 204, contentType: null }));
    vi.stubGlobal('fetch', fetchMock);
    await checkUrl({ url: 'https://x' });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('throws WEBFETCH_TOOL_NOT_CONFIGURED when the URL is unset', async () => {
    delete process.env.WEBFETCH_TOOL_URL;
    await expect(fetchUrl({ url: 'https://x' })).rejects.toMatchObject({
      extensions: { code: 'WEBFETCH_TOOL_NOT_CONFIGURED' },
    });
  });

  it('maps a typed tool error body to WEBFETCH_TOOL_ERROR + webfetchErrorCode', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(async () => errJson(400, { error: 'url_forbidden', message: 'private address blocked' })),
    );
    const err = await fetchUrl({ url: 'http://169.254.169.254/' }).catch((e) => e as GraphQLError);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions).toMatchObject({
      code: 'WEBFETCH_TOOL_ERROR',
      webfetchErrorCode: 'url_forbidden',
      status: 400,
    });
    expect((err as GraphQLError).message).toBe('private address blocked');
  });

  it('maps an unreachable tool to WEBFETCH_TOOL_UNREACHABLE without echoing the request input', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const err = await httpRequest({
      method: 'POST',
      url: 'https://api.example',
      auth: { type: 'bearer', token: 'SUPER_SECRET' },
      json: { k: 'v' },
    }).catch((e) => e as GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe('WEBFETCH_TOOL_UNREACHABLE');
    // The credential must not leak into any error surface.
    expect(JSON.stringify((err as GraphQLError).extensions)).not.toContain('SUPER_SECRET');
    expect((err as GraphQLError).message).not.toContain('SUPER_SECRET');
  });

  it('maps a serialization failure to WEBFETCH_TOOL_ERROR, not _UNREACHABLE, and never hits the network', async () => {
    const fetchMock = fetchStub(async () => okJson({}));
    vi.stubGlobal('fetch', fetchMock);
    // A BigInt in the JSON body is not serializable by JSON.stringify.
    const err = await httpRequest({ method: 'POST', url: 'https://api', json: { n: 1n } }).catch(
      (e) => e as GraphQLError,
    );
    expect((err as GraphQLError).extensions.code).toBe('WEBFETCH_TOOL_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('http-request forwards method, body, and headers verbatim', async () => {
    const fetchMock = fetchStub(async () =>
      okJson({ method: 'POST', finalUrl: 'https://api.example', status: 201, headers: {}, contentType: 'application/json', body: { id: 1 }, truncated: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await httpRequest({ method: 'POST', url: 'https://api.example', json: { a: 1 }, headers: { 'x-y': 'z' } });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(fetchMock.mock.calls[0]![0]).toBe('http://webfetch.test:8080/ops/http-request');
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'POST',
      url: 'https://api.example',
      json: { a: 1 },
      headers: { 'x-y': 'z' },
    });
  });
});
