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
  classifyEmbedError,
  withMaxBatch,
  type EmbeddingClient,
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

  it('parses the HuggingFace TEI raw 2D-array shape', async () => {
    // TEI's native /embed returns a bare 2D array — no envelope.
    // Useful when the HTTP path is fronting a TEI endpoint directly,
    // and also exercised end-to-end by the SageMaker client (which
    // routes through the same extractVectors helper).
    const { impl } = fakeFetch([vec(768, 0.7), vec(768, 0.8)]);
    const out = await client(impl).embed(['a', 'b'], 'document');
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0.7);
    expect(out[1][0]).toBe(0.8);
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

  it('rejects a malformed embeddings element (not an array)', async () => {
    const { impl } = fakeFetch({ embeddings: [null] });
    await expect(client(impl).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('rejects a vector containing a non-finite number', async () => {
    const { impl } = fakeFetch({ embeddings: [[1, Number.NaN, ...vec(766)]] });
    await expect(client(impl).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('rejects a null element in the OpenAI data array', async () => {
    const { impl } = fakeFetch({ data: [null] });
    await expect(client(impl).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });
});

describe('#882 — error classification (classifyEmbedError)', () => {
  async function thrownBy(status: number): Promise<unknown> {
    const { impl } = fakeFetch({}, { ok: false, status });
    return client(impl)
      .embed(['x'], 'document')
      .then(() => null)
      .catch((e) => e);
  }

  it('HTTP 5xx is retryable', async () => {
    expect(classifyEmbedError(await thrownBy(500))).toBe('retryable');
    expect(classifyEmbedError(await thrownBy(503))).toBe('retryable');
  });

  it('HTTP 408 / 424 / 429 are retryable (timeout / model-error pass-through / throttle)', async () => {
    expect(classifyEmbedError(await thrownBy(408))).toBe('retryable');
    expect(classifyEmbedError(await thrownBy(424))).toBe('retryable');
    expect(classifyEmbedError(await thrownBy(429))).toBe('retryable');
  });

  it('other HTTP 4xx are permanent (deterministic rejection, e.g. the 413 batch overflow)', async () => {
    expect(classifyEmbedError(await thrownBy(413))).toBe('permanent');
    expect(classifyEmbedError(await thrownBy(400))).toBe('permanent');
  });

  it('a dimension mismatch is permanent', () => {
    expect(classifyEmbedError(new EmbeddingDimensionMismatchError(768, 384))).toBe('permanent');
  });

  it('a network error (fetch throws) is retryable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const err = await client(impl)
      .embed(['x'], 'document')
      .catch((e) => e);
    expect(classifyEmbedError(err)).toBe('retryable');
  });

  it('an unknown error defaults to retryable (never silently drop a node)', () => {
    expect(classifyEmbedError(new Error('who knows'))).toBe('retryable');
    expect(classifyEmbedError('a string')).toBe('retryable');
  });
});

describe('#882 — withMaxBatch', () => {
  /** Stub that records each upstream call's batch size and returns i-indexed vectors. */
  function countingClient(dim = 4): { client: EmbeddingClient; batches: number[] } {
    const batches: number[] = [];
    let counter = 0;
    return {
      batches,
      client: {
        provider: 'test',
        model: 'stub',
        dim,
        async embed(texts: string[]) {
          batches.push(texts.length);
          return texts.map(() => {
            const v = new Array(dim).fill(0);
            v[0] = counter++;
            return v;
          });
        },
      },
    };
  }

  it('passes a within-limit batch through in one call', async () => {
    const { client: inner, batches } = countingClient();
    const out = await withMaxBatch(inner, 32).embed(['a', 'b', 'c'], 'document');
    expect(batches).toEqual([3]);
    expect(out).toHaveLength(3);
  });

  it('splits an over-limit batch and concatenates results in order', async () => {
    const { client: inner, batches } = countingClient();
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const out = await withMaxBatch(inner, 32).embed(texts, 'document');
    expect(batches).toEqual([32, 32, 6]);
    expect(out).toHaveLength(70);
    // Order preserved: the counter stamped 0..69 into position 0.
    expect(out.map((v) => v[0])).toEqual(Array.from({ length: 70 }, (_, i) => i));
  });

  it('preserves provider/model/dim metadata', () => {
    const { client: inner } = countingClient();
    const wrapped = withMaxBatch(inner, 8);
    expect(wrapped.provider).toBe('test');
    expect(wrapped.model).toBe('stub');
    expect(wrapped.dim).toBe(4);
  });

  it('rejects a non-positive or non-integer maxBatch', () => {
    const { client: inner } = countingClient();
    expect(() => withMaxBatch(inner, 0)).toThrow(/positive integer/);
    expect(() => withMaxBatch(inner, 1.5)).toThrow(/positive integer/);
  });
});
