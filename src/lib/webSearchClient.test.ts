/**
 * webSearchClient (#647) — pure unit. Mocks global fetch; no network, no tool.
 * Asserts the op path, the versioned/provider-agnostic request envelope, the
 * env-sourced inline credential (`cor:web:020:02`), typed-error mapping, and
 * that the credential never rides an error path or a URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLError } from 'graphql';
import {
  webSearch,
  providerCredentialFromEnv,
  isWebSearchConfigured,
  WEB_SEARCH_CONTRACT_VERSION,
} from './webSearchClient.js';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errJson = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

const fetchStub = (impl: () => Promise<Response>) =>
  vi.fn((_url: string | URL | Request, _init?: RequestInit) => impl());

const PROVIDER_ENV = [
  'WEBSEARCH_TOOL_URL',
  'WEBSEARCH_TOOL_TOKEN',
  'WEBSEARCH_PROVIDER',
  'WEBSEARCH_PROVIDER_API_KEY',
  'WEBSEARCH_PROVIDER_AUTH',
  'WEBSEARCH_PROVIDER_HEADER',
] as const;

describe('webSearchClient', () => {
  beforeEach(() => {
    process.env.WEBSEARCH_TOOL_URL = 'http://websearch.test:8080';
    process.env.WEBSEARCH_TOOL_TOKEN = 'shhh';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const k of PROVIDER_ENV) delete process.env[k];
  });

  it('posts search to the ops plane with the bearer token, the contract version, and trims a trailing slash', async () => {
    process.env.WEBSEARCH_TOOL_URL = 'http://websearch.test:8080/';
    const fetchMock = fetchStub(async () =>
      okJson({ results: [{ title: 'A', url: 'https://a/', snippet: 's', rank: 1 }], source: 'external' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await webSearch({ query: 'hadron', count: 3, freshness: 'week', locale: 'en-US' });

    expect(res.results).toHaveLength(1);
    expect(res.source).toBe('external');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://websearch.test:8080/ops/search');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ authorization: 'Bearer shhh' });
    expect(JSON.parse(init!.body as string)).toEqual({
      version: WEB_SEARCH_CONTRACT_VERSION,
      query: 'hadron',
      count: 3,
      freshness: 'week',
      locale: 'en-US',
    });
  });

  it('omits the internal-plane authorization header when no tool token is set', async () => {
    delete process.env.WEBSEARCH_TOOL_TOKEN;
    const fetchMock = fetchStub(async () => okJson({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await webSearch({ query: 'x' });
    expect(fetchMock.mock.calls[0]![1]!.headers).not.toHaveProperty('authorization');
  });

  it('throws WEBSEARCH_TOOL_NOT_CONFIGURED when the URL is unset', async () => {
    delete process.env.WEBSEARCH_TOOL_URL;
    expect(isWebSearchConfigured()).toBe(false);
    await expect(webSearch({ query: 'x' })).rejects.toMatchObject({
      extensions: { code: 'WEBSEARCH_TOOL_NOT_CONFIGURED' },
    });
  });

  it('attaches the env-sourced provider + bearer credential inline in the body (never a URL param)', async () => {
    process.env.WEBSEARCH_PROVIDER = 'brave';
    process.env.WEBSEARCH_PROVIDER_API_KEY = 'PROVIDER_SECRET';
    const fetchMock = fetchStub(async () => okJson({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await webSearch({ query: 'x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    // The provider key never rides in the request URL (containment rule).
    expect(url).not.toContain('PROVIDER_SECRET');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      provider: 'brave',
      auth: { type: 'bearer', token: 'PROVIDER_SECRET' },
    });
  });

  it('carries a named-header credential when WEBSEARCH_PROVIDER_AUTH=header', () => {
    process.env.WEBSEARCH_PROVIDER = 'brave';
    process.env.WEBSEARCH_PROVIDER_API_KEY = 'K';
    process.env.WEBSEARCH_PROVIDER_AUTH = 'header';
    process.env.WEBSEARCH_PROVIDER_HEADER = 'X-Subscription-Token';
    expect(providerCredentialFromEnv()).toEqual({
      provider: 'brave',
      auth: { type: 'header', name: 'X-Subscription-Token', value: 'K' },
    });
  });

  it('throws when header auth is selected without a header name (no silent no-auth fall-through)', () => {
    process.env.WEBSEARCH_PROVIDER_API_KEY = 'K';
    process.env.WEBSEARCH_PROVIDER_AUTH = 'header';
    expect(() => providerCredentialFromEnv()).toThrow(/WEBSEARCH_PROVIDER_HEADER/);
  });

  it('sends no credential when no provider key is configured (tool owns its own relationship)', () => {
    process.env.WEBSEARCH_PROVIDER = 'brave';
    expect(providerCredentialFromEnv()).toEqual({ provider: 'brave' });
  });

  it('maps a typed tool error body to WEBSEARCH_TOOL_ERROR + webSearchErrorCode', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(async () => errJson(401, { error: 'provider_unauthorized', message: 'bad key' })),
    );
    const err = await webSearch({ query: 'x' }).catch((e) => e as GraphQLError);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions).toMatchObject({
      code: 'WEBSEARCH_TOOL_ERROR',
      webSearchErrorCode: 'provider_unauthorized',
      status: 401,
    });
    expect((err as GraphQLError).message).toBe('bad key');
  });

  it('maps an unreachable tool to WEBSEARCH_TOOL_UNREACHABLE without leaking the provider credential', async () => {
    process.env.WEBSEARCH_PROVIDER_API_KEY = 'PROVIDER_SECRET';
    vi.stubGlobal(
      'fetch',
      fetchStub(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const err = await webSearch({ query: 'x' }).catch((e) => e as GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe('WEBSEARCH_TOOL_UNREACHABLE');
    expect(JSON.stringify((err as GraphQLError).extensions)).not.toContain('PROVIDER_SECRET');
  });

  it('rejects a response missing a results array as WEBSEARCH_TOOL_ERROR', async () => {
    vi.stubGlobal('fetch', fetchStub(async () => okJson({ notResults: true })));
    await expect(webSearch({ query: 'x' })).rejects.toMatchObject({
      extensions: { code: 'WEBSEARCH_TOOL_ERROR' },
    });
  });
});
