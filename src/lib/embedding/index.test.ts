/**
 * 033-rag-vector-retrieval — embedding factory env validation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getEmbeddingClient, resetEmbeddingClientForTests } from './index.js';

const ENV_KEYS = ['EMBEDDING_API_URL', 'EMBEDDING_DIM', 'EMBEDDING_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  resetEmbeddingClientForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_DIM;
  process.env.EMBEDDING_API_URL = 'http://embed.test/api/embed';
  Object.assign(process.env, env);
}

describe('getEmbeddingClient EMBEDDING_DIM validation', () => {
  it('throws on a non-numeric EMBEDDING_DIM', () => {
    setEnv({ EMBEDDING_DIM: 'not-a-number' });
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_DIM/);
  });

  it('throws on a non-positive EMBEDDING_DIM', () => {
    setEnv({ EMBEDDING_DIM: '0' });
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_DIM/);
  });

  it('defaults to 768 when EMBEDDING_DIM is unset', () => {
    setEnv({});
    expect(getEmbeddingClient().dim).toBe(768);
  });

  it('throws when EMBEDDING_API_URL is unset', () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    resetEmbeddingClientForTests();
    delete process.env.EMBEDDING_API_URL;
    expect(() => getEmbeddingClient()).toThrow(/EMBEDDING_API_URL/);
  });
});
