/**
 * 033-rag-vector-retrieval — embedding factory env validation + backend dispatch.
 *
 * All env mutations go through vi.stubEnv / vi.unstubAllEnvs so they don't
 * leak to later test files sharing the worker (PR-191 review convention).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getEmbeddingClient,
  resetEmbeddingClientForTests,
  isEmbeddingConfigured,
  HttpEmbeddingClient,
  SageMakerEmbeddingClient,
} from './index.js';

afterEach(() => {
  resetEmbeddingClientForTests();
  vi.unstubAllEnvs();
});

describe('getEmbeddingClient — EMBEDDING_DIM validation', () => {
  it('throws on a non-numeric EMBEDDING_DIM', () => {
    vi.stubEnv('EMBEDDING_API_URL', 'http://embed.test/api/embed');
    vi.stubEnv('EMBEDDING_DIM', 'not-a-number');
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_DIM/);
  });

  it('throws on a non-positive EMBEDDING_DIM', () => {
    vi.stubEnv('EMBEDDING_API_URL', 'http://embed.test/api/embed');
    vi.stubEnv('EMBEDDING_DIM', '0');
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_DIM/);
  });

  it('defaults to 768 when EMBEDDING_DIM is unset', () => {
    vi.stubEnv('EMBEDDING_API_URL', 'http://embed.test/api/embed');
    vi.stubEnv('EMBEDDING_DIM', undefined);
    expect(getEmbeddingClient().dim).toBe(768);
  });
});

describe('getEmbeddingClient — http backend (default)', () => {
  it('throws when EMBEDDING_API_URL is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', undefined);
    vi.stubEnv('EMBEDDING_API_URL', undefined);
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_API_URL/);
  });

  it('returns an HttpEmbeddingClient when EMBEDDING_BACKEND is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', undefined);
    vi.stubEnv('EMBEDDING_API_URL', 'http://embed.test/api/embed');
    expect(getEmbeddingClient()).toBeInstanceOf(HttpEmbeddingClient);
  });

  it('returns an HttpEmbeddingClient when EMBEDDING_BACKEND=http', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'http');
    vi.stubEnv('EMBEDDING_API_URL', 'http://embed.test/api/embed');
    expect(getEmbeddingClient()).toBeInstanceOf(HttpEmbeddingClient);
  });
});

describe('getEmbeddingClient — sagemaker backend', () => {
  it('returns a SageMakerEmbeddingClient when EMBEDDING_BACKEND=sagemaker', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    expect(getEmbeddingClient()).toBeInstanceOf(SageMakerEmbeddingClient);
  });

  it('accepts case-insensitive backend names', () => {
    vi.stubEnv('EMBEDDING_BACKEND', '  SageMaker  ');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    expect(getEmbeddingClient()).toBeInstanceOf(SageMakerEmbeddingClient);
  });

  it('throws when EMBEDDING_SAGEMAKER_ENDPOINT_NAME is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    expect(() => getEmbeddingClient()).toThrow(
      /EMBEDDING_SAGEMAKER_ENDPOINT_NAME/,
    );
  });

  it('throws when EMBEDDING_SAGEMAKER_REGION is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', undefined);
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_SAGEMAKER_REGION/);
  });

  it('defaults provider to "aws-sagemaker" when EMBEDDING_PROVIDER is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_PROVIDER', undefined);
    expect(getEmbeddingClient().provider).toBe('aws-sagemaker');
  });

  it('honors EMBEDDING_PROVIDER override', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_PROVIDER', 'mm-prod');
    expect(getEmbeddingClient().provider).toBe('mm-prod');
  });
});

describe('getEmbeddingClient — sagemaker dedicated credentials', () => {
  // Dedicated keys shrink the blast radius of a leak — a leaked
  // SageMaker key only buys `sagemaker:InvokeEndpoint` on the
  // configured endpoint, not whatever S3 / account-level surface
  // the host's default AWS identity can reach.

  function setSageMakerBase() {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
  }

  it('builds a SageMaker client when both ACCESS_KEY_ID and SECRET_ACCESS_KEY are set', () => {
    setSageMakerBase();
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv(
      'EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(getEmbeddingClient()).toBeInstanceOf(SageMakerEmbeddingClient);
  });

  it('builds a SageMaker client when neither is set (falls through to default chain)', () => {
    setSageMakerBase();
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY', undefined);
    expect(getEmbeddingClient()).toBeInstanceOf(SageMakerEmbeddingClient);
  });

  it('throws when only ACCESS_KEY_ID is set (half-configured pair is ambiguous)', () => {
    setSageMakerBase();
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY', undefined);
    expect(() => getEmbeddingClient()).toThrow(
      /EMBEDDING_SAGEMAKER_ACCESS_KEY_ID.*SECRET_ACCESS_KEY.*together/s,
    );
  });

  it('throws when only SECRET_ACCESS_KEY is set', () => {
    setSageMakerBase();
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', undefined);
    vi.stubEnv(
      'EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(() => getEmbeddingClient()).toThrow(
      /EMBEDDING_SAGEMAKER_ACCESS_KEY_ID.*SECRET_ACCESS_KEY.*together/s,
    );
  });
});

describe('getEmbeddingClient — invalid EMBEDDING_BACKEND', () => {
  it('throws on an unknown backend name', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'bedrock');
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_BACKEND/);
  });
});

describe('isEmbeddingConfigured', () => {
  it('is true for http backend when EMBEDDING_API_URL is set', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'http');
    vi.stubEnv('EMBEDDING_API_URL', 'http://embed.test/api/embed');
    expect(isEmbeddingConfigured()).toBe(true);
  });

  it('is false for http backend when EMBEDDING_API_URL is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'http');
    vi.stubEnv('EMBEDDING_API_URL', undefined);
    expect(isEmbeddingConfigured()).toBe(false);
  });

  it('is true for sagemaker backend when endpoint + region are set', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    expect(isEmbeddingConfigured()).toBe(true);
  });

  it('is false for sagemaker backend when endpoint is unset', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    expect(isEmbeddingConfigured()).toBe(false);
  });

  it('is false on a misconfigured EMBEDDING_BACKEND (no throw to the caller)', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'bedrock');
    expect(isEmbeddingConfigured()).toBe(false);
  });

  // PR-233 review (Copilot): isEmbeddingConfigured() must reject the
  // same configurations getEmbeddingClient() throws on, otherwise the
  // embedding worker enters a tight retry loop — isEmbeddingConfigured
  // says "yes, drain me," getEmbeddingClient throws on every drain.
  // These tests pin the parity for the dedicated-credentials half-
  // configured cases.

  it('is false when only EMBEDDING_SAGEMAKER_ACCESS_KEY_ID is set (half-configured pair)', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY', undefined);
    expect(isEmbeddingConfigured()).toBe(false);
  });

  it('is false when only EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY is set (half-configured pair)', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', undefined);
    vi.stubEnv(
      'EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(isEmbeddingConfigured()).toBe(false);
  });

  it('is false when EMBEDDING_SAGEMAKER_SESSION_TOKEN is set without the access key pair', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_SESSION_TOKEN', 'FwoGZX...');
    expect(isEmbeddingConfigured()).toBe(false);
  });

  it('is true with the complete STS triple (access key + secret + session token)', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', 'ASIAIOSFODNN7EXAMPLE');
    vi.stubEnv(
      'EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    vi.stubEnv('EMBEDDING_SAGEMAKER_SESSION_TOKEN', 'FwoGZX...');
    expect(isEmbeddingConfigured()).toBe(true);
  });
});

describe('getEmbeddingClient — sagemaker session token guard', () => {
  // Mirror of the isEmbeddingConfigured cases: getEmbeddingClient must
  // throw on the same invariants. The both-or-neither rule for the
  // access key pair was already covered above; this adds the lone
  // session-token case.

  it('throws when EMBEDDING_SAGEMAKER_SESSION_TOKEN is set without the access key pair', () => {
    vi.stubEnv('EMBEDDING_BACKEND', 'sagemaker');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ENDPOINT_NAME', 'hadron-embed-nomic-v1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_REGION', 'us-east-1');
    vi.stubEnv('EMBEDDING_SAGEMAKER_ACCESS_KEY_ID', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY', undefined);
    vi.stubEnv('EMBEDDING_SAGEMAKER_SESSION_TOKEN', 'FwoGZX...');
    expect(() => getEmbeddingClient()).toThrow(
      /EMBEDDING_SAGEMAKER_SESSION_TOKEN.*ACCESS_KEY_ID.*SECRET_ACCESS_KEY/s,
    );
  });
});
