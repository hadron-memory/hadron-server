/**
 * 033-rag-vector-retrieval — EmbeddingClient unit tests (T017).
 *
 * No network: a fake `fetchImpl` captures the request and returns canned
 * bodies. Pins the two correctness-critical behaviors — the nomic task
 * prefixes and the dimension guard — plus response-shape tolerance.
 */

import { describe, it, expect } from 'vitest';
import {
  HttpEmbeddingClient,
  EmbeddingDimensionMismatchError,
  EmbeddingRequestError,
} from './client.js';

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, opts: any) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function vec(n: number, fill = 0.1): number[] {
  return Array.from({ length: n }, () => fill);
}

function client(fetchImpl: typeof fetch, dim = 768) {
  return new HttpEmbeddingClient({
    url: 'http://embed.test/api/embed',
    model: 'nomic-embed-text-v1.5',
    dim,
    fetchImpl,
  });
}

describe('HttpEmbeddingClient nomic prefixes', () => {
  it('prepends "search_document: " for documents', async () => {
    const { impl, calls } = fakeFetch({ embeddings: [vec(768)] });
    await client(impl).embed(['hello'], 'document');
    expect(calls[0].body.input).toEqual(['search_document: hello']);
  });

  it('prepends "search_query: " for queries', async () => {
    const { impl, calls } = fakeFetch({ embeddings: [vec(768)] });
    await client(impl).embed(['find me'], 'query');
    expect(calls[0].body.input).toEqual(['search_query: find me']);
  });
});

describe('HttpEmbeddingClient response shapes', () => {
  it('parses the Ollama { embeddings } shape', async () => {
    const { impl } = fakeFetch({ embeddings: [vec(768, 0.2), vec(768, 0.3)] });
    const out = await client(impl).embed(['a', 'b'], 'document');
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0.2);
  });

  it('parses the OpenAI { data: [{ embedding }] } shape', async () => {
    const { impl } = fakeFetch({ data: [{ embedding: vec(768, 0.5) }] });
    const out = await client(impl).embed(['a'], 'document');
    expect(out[0][0]).toBe(0.5);
  });
});

describe('HttpEmbeddingClient guards', () => {
  it('throws EmbeddingDimensionMismatchError on wrong dimension', async () => {
    const { impl } = fakeFetch({ embeddings: [vec(384)] }); // client expects 768
    await expect(client(impl).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingDimensionMismatchError,
    );
  });

  it('throws EmbeddingRequestError on a non-ok response', async () => {
    const { impl } = fakeFetch({}, { ok: false, status: 500 });
    await expect(client(impl).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('throws when the vector count does not match the input count', async () => {
    const { impl } = fakeFetch({ embeddings: [vec(768)] }); // only 1 for 2 inputs
    await expect(
      client(impl).embed(['a', 'b'], 'document'),
    ).rejects.toBeInstanceOf(EmbeddingRequestError);
  });

  it('returns [] for empty input without calling fetch', async () => {
    const { impl, calls } = fakeFetch({ embeddings: [] });
    const out = await client(impl).embed([], 'document');
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
