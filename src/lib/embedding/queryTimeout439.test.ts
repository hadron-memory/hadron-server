import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';
import { HttpEmbeddingClient, EmbeddingRequestError } from './client.js';
import { SageMakerEmbeddingClient } from './client-sagemaker.js';
import { getEmbeddingClient, resetEmbeddingClientForTests } from './index.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetEmbeddingClientForTests(); });

// Real clients and installed SDK over loopback only; never invoke a provider.
for (const backend of ['http', 'sagemaker'] as const) {
  describe(`${backend} query deadline #439`, () => {
    for (const phase of ['headers', 'body'] as const) {
      it(`aborts a query stalled at ${phase}, with retryable classification`, async () => {
        const server = createServer((_req, res) => {
          if (phase === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('[[0.'); }
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const sdk = new SageMakerRuntimeClient({ region: 'us-east-1', endpoint: url, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
        const client = backend === 'http'
          ? new HttpEmbeddingClient({ url, model: 'synthetic', dim: 1, queryTimeoutMs: 50 } as any)
          : new SageMakerEmbeddingClient({ endpointName: 'synthetic', region: 'us-east-1', model: 'synthetic', dim: 1, sdkClient: sdk, queryTimeoutMs: 50 } as any);
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            client.embed(['unchanged query'], 'query').then(() => 'resolved', e => e),
            new Promise(r => { watchdog = setTimeout(() => r('UNSETTLED'), 600); }),
          ]);
          expect(result).toBeInstanceOf(EmbeddingRequestError);
          expect(result.retryable).toBe(true);
          expect(result.message).toContain('query embed timed out after 50ms');
        } finally {
          clearTimeout(watchdog); sdk.destroy(); server.closeAllConnections();
          await new Promise<void>(r => server.close(() => r()));
        }
      });
    }
    it('does not impose the query deadline on document embeddings', async () => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const server = createServer((_req, res) => { timers.push(setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[[0.1]]'); }, 100)); });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const sdk = new SageMakerRuntimeClient({ region: 'us-east-1', endpoint: url, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
      const client = backend === 'http'
        ? new HttpEmbeddingClient({ url, model: 'synthetic', dim: 1, queryTimeoutMs: 20 } as any)
        : new SageMakerEmbeddingClient({ endpointName: 'synthetic', region: 'us-east-1', model: 'synthetic', dim: 1, sdkClient: sdk, queryTimeoutMs: 20 } as any);
      try { expect(await client.embed(['document'], 'document')).toEqual([[0.1]]); }
      finally { timers.forEach(clearTimeout); sdk.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    });
  });
}

describe('query timeout factory configuration #439', () => {
  it.each([undefined, '37'])('passes the selected timeout %s through the HTTP factory', async raw => {
    vi.stubEnv('EMBEDDING_BACKEND', 'http'); vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid'); vi.stubEnv('EMBEDDING_DIM', '1');
    vi.stubEnv('EMBEDDING_QUERY_TIMEOUT_MS', raw);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => new Response('[[0.1]]', { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    resetEmbeddingClientForTests();
    expect(await getEmbeddingClient().embed(['original'], 'query')).toEqual([[0.1]]);
    expect(timeout).toHaveBeenCalledWith(raw === undefined ? 5000 : 37);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual(['search_query: original']);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', ''])('refuses invalid configuration %j', raw => {
    vi.stubEnv('EMBEDDING_BACKEND', 'http'); vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid'); vi.stubEnv('EMBEDDING_QUERY_TIMEOUT_MS', raw);
    resetEmbeddingClientForTests(); expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_QUERY_TIMEOUT_MS/);
  });
});
