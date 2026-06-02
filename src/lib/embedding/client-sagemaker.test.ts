/**
 * 033-rag-vector-retrieval — SageMakerEmbeddingClient unit tests.
 *
 * No AWS network calls: a fake SageMakerRuntimeClient is injected via the
 * constructor's `sdkClient` test hook. Tests pin:
 *
 *   - The nomic task-instruction prefix is applied per purpose (same
 *     correctness-critical concern as the HTTP client).
 *   - The TEI 2D-array response shape parses correctly.
 *   - The Ollama and OpenAI envelope shapes also parse — the SageMaker
 *     hosting container's output shape is operator-configurable, so the
 *     client should not over-narrow.
 *   - Dimension and count guards fire on bad responses.
 *   - AWS SDK errors are wrapped into EmbeddingRequestError carrying the
 *     SDK error name (the worker classifies transient vs. permanent off
 *     that name).
 *   - InferenceComponentName is forwarded when set.
 *   - Empty input short-circuits without invoking the endpoint.
 *
 * Test hook only: the production constructor builds its own
 * SageMakerRuntimeClient from `region`; the test path passes a mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { SageMakerEmbeddingClient } from './client-sagemaker.js';
import {
  EmbeddingDimensionMismatchError,
  EmbeddingRequestError,
} from './client.js';

interface FakeInvocation {
  endpointName: string;
  inferenceComponentName?: string;
  contentType?: string;
  body: unknown;
}

function fakeSdk(responseBody: unknown, opts: { throwError?: Error } = {}) {
  const invocations: FakeInvocation[] = [];
  const send = vi.fn(async (command: unknown) => {
    const input = (command as { input: Record<string, unknown> }).input;
    invocations.push({
      endpointName: input.EndpointName as string,
      inferenceComponentName: input.InferenceComponentName as string | undefined,
      contentType: input.ContentType as string | undefined,
      body: JSON.parse(new TextDecoder().decode(input.Body as Uint8Array)),
    });
    if (opts.throwError) throw opts.throwError;
    const encoded = new TextEncoder().encode(JSON.stringify(responseBody));
    return {
      Body: {
        // The AWS SDK v3 stream interface exposes transformToString in Node.
        transformToString: async () => new TextDecoder().decode(encoded),
      },
    };
  });
  return { sdk: { send } as never, invocations, send };
}

function vec(n: number, fill = 0.1): number[] {
  return Array.from({ length: n }, () => fill);
}

function client(sdk: ReturnType<typeof fakeSdk>['sdk'], dim = 768) {
  return new SageMakerEmbeddingClient({
    endpointName: 'hadron-embed-nomic-v1',
    region: 'us-east-1',
    model: 'nomic-embed-text-v1.5',
    dim,
    sdkClient: sdk,
  });
}

describe('SageMakerEmbeddingClient — nomic prefixes', () => {
  it('prepends "search_document: " for documents', async () => {
    const { sdk, invocations } = fakeSdk([vec(768)]);
    await client(sdk).embed(['hello'], 'document');
    expect(invocations[0].body).toEqual({
      inputs: ['search_document: hello'],
    });
  });

  it('prepends "search_query: " for queries', async () => {
    const { sdk, invocations } = fakeSdk([vec(768)]);
    await client(sdk).embed(['find me'], 'query');
    expect(invocations[0].body).toEqual({ inputs: ['search_query: find me'] });
  });
});

describe('SageMakerEmbeddingClient — invocation shape', () => {
  it('uses the configured endpoint name', async () => {
    const { sdk, invocations } = fakeSdk([vec(768)]);
    await client(sdk).embed(['x'], 'document');
    expect(invocations[0].endpointName).toBe('hadron-embed-nomic-v1');
  });

  it('forwards InferenceComponentName when set', async () => {
    const { sdk, invocations } = fakeSdk([vec(768)]);
    const c = new SageMakerEmbeddingClient({
      endpointName: 'multi-model-ep',
      region: 'us-east-1',
      model: 'nomic-embed-text-v1.5',
      dim: 768,
      inferenceComponentName: 'nomic-component',
      sdkClient: sdk,
    });
    await c.embed(['x'], 'document');
    expect(invocations[0].inferenceComponentName).toBe('nomic-component');
  });

  it('omits InferenceComponentName by default', async () => {
    const { sdk, invocations } = fakeSdk([vec(768)]);
    await client(sdk).embed(['x'], 'document');
    expect(invocations[0].inferenceComponentName).toBeUndefined();
  });

  it('sends application/json content-type', async () => {
    const { sdk, invocations } = fakeSdk([vec(768)]);
    await client(sdk).embed(['x'], 'document');
    expect(invocations[0].contentType).toBe('application/json');
  });
});

describe('SageMakerEmbeddingClient — response shapes', () => {
  it('parses TEI native (top-level 2D array) — the HF container default', async () => {
    const { sdk } = fakeSdk([vec(768, 0.2), vec(768, 0.3)]);
    const out = await client(sdk).embed(['a', 'b'], 'document');
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0.2);
  });

  it('parses Ollama {embeddings} (for operators using an Ollama-on-SageMaker container)', async () => {
    const { sdk } = fakeSdk({ embeddings: [vec(768, 0.4)] });
    const out = await client(sdk).embed(['a'], 'document');
    expect(out[0][0]).toBe(0.4);
  });

  it('parses OpenAI {data: [{embedding}]} (for an OpenAI-compat container)', async () => {
    const { sdk } = fakeSdk({ data: [{ embedding: vec(768, 0.5) }] });
    const out = await client(sdk).embed(['a'], 'document');
    expect(out[0][0]).toBe(0.5);
  });
});

describe('SageMakerEmbeddingClient — guards', () => {
  it('throws EmbeddingDimensionMismatchError on wrong dimension', async () => {
    const { sdk } = fakeSdk([vec(384)]); // expects 768
    await expect(client(sdk).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingDimensionMismatchError,
    );
  });

  it('throws EmbeddingRequestError when vector count does not match input count', async () => {
    const { sdk } = fakeSdk([vec(768)]); // only 1 for 2 inputs
    await expect(client(sdk).embed(['a', 'b'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('rejects a malformed vector (non-finite number)', async () => {
    const { sdk } = fakeSdk([[1, Number.NaN, ...vec(766)]]);
    await expect(client(sdk).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('rejects an unrecognized response shape', async () => {
    const { sdk } = fakeSdk({ unknown: 'thing' });
    await expect(client(sdk).embed(['x'], 'document')).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('returns [] for empty input without calling the SDK', async () => {
    const { sdk, send } = fakeSdk([vec(768)]);
    const out = await client(sdk).embed([], 'document');
    expect(out).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('SageMakerEmbeddingClient — dedicated credentials', () => {
  // These tests verify what the constructor DOES with the credential
  // options — the test hook (sdkClient) bypasses the SDK constructor
  // entirely, so we exercise the production code path here by NOT
  // passing sdkClient. Constructor success without throwing is the
  // pinning behavior; what the SDK does with the credentials is
  // covered by aws-sdk's own tests.

  it('constructs with explicit credentials when accessKeyId + secretAccessKey are set', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-new
      new SageMakerEmbeddingClient({
        endpointName: 'hadron-embed-nomic-v1',
        region: 'us-east-1',
        model: 'nomic-embed-text-v1.5',
        dim: 768,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      });
    }).not.toThrow();
  });

  it('constructs with explicit credentials + session token (STS path)', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-new
      new SageMakerEmbeddingClient({
        endpointName: 'hadron-embed-nomic-v1',
        region: 'us-east-1',
        model: 'nomic-embed-text-v1.5',
        dim: 768,
        accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'FwoGZXIvYXdzEJr//////////wEaDExample',
      });
    }).not.toThrow();
  });

  it('constructs without credentials (falls through to SDK default chain) when neither is set', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-new
      new SageMakerEmbeddingClient({
        endpointName: 'hadron-embed-nomic-v1',
        region: 'us-east-1',
        model: 'nomic-embed-text-v1.5',
        dim: 768,
      });
    }).not.toThrow();
  });
});

describe('SageMakerEmbeddingClient — error wrapping', () => {
  it('wraps AWS SDK errors as EmbeddingRequestError carrying the SDK error name', async () => {
    // The SDK uses class-shaped errors with a `name` property like
    // "ValidationException" or "ModelError" — the worker's classifier
    // reads this off `embeddingError` to decide transient-vs-permanent.
    const sdkErr = new Error('Endpoint not found');
    sdkErr.name = 'ValidationException';
    const { sdk } = fakeSdk(undefined, { throwError: sdkErr });
    await expect(client(sdk).embed(['x'], 'document')).rejects.toMatchObject({
      name: 'EmbeddingRequestError',
      message: expect.stringContaining('ValidationException'),
    });
  });
});
