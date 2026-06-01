/**
 * 033-rag-vector-retrieval — embedding client wiring.
 *
 * Reads the `EMBEDDING_*` env vars (see CLAUDE.md env table) and constructs a
 * singleton {@link HttpEmbeddingClient}. `EMBEDDING_API_URL` is required only
 * when vector indexing is actually in use; callers that may run without it
 * should use {@link getEmbeddingClient} and handle the thrown error, or check
 * {@link isEmbeddingConfigured} first.
 */

import {
  HttpEmbeddingClient,
  type EmbeddingClient,
} from './client.js';

export * from './client.js';

// The Ollama tag is `nomic-embed-text` (which serves nomic-embed-text-v1.5,
// 768-dim). The model string is sent verbatim to the endpoint, so this must
// match the served tag — using `nomic-embed-text-v1.5` would 404 against Ollama.
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
export const DEFAULT_EMBEDDING_DIM = 768;
export const DEFAULT_EMBEDDING_PROVIDER = 'local';

let cached: EmbeddingClient | null = null;

/** True when `EMBEDDING_API_URL` is set (vector indexing can run). */
export function isEmbeddingConfigured(): boolean {
  return !!process.env.EMBEDDING_API_URL;
}

/**
 * The process-wide embedding client. Throws if `EMBEDDING_API_URL` is unset —
 * the embedding worker and search paths only call this for memories that have
 * opted into vector indexing, and the server logs a startup warning when
 * indexed memories exist without a configured endpoint.
 */
export function getEmbeddingClient(): EmbeddingClient {
  if (cached) return cached;
  const url = process.env.EMBEDDING_API_URL;
  if (!url) {
    throw new Error(
      'EMBEDDING_API_URL is not set — required for vector indexing (spec 033). ' +
        'Set it to a self-hosted embedding endpoint (dev: Ollama /api/embed).',
    );
  }
  const dimEnv = process.env.EMBEDDING_DIM;
  const dim = dimEnv ? Number(dimEnv) : DEFAULT_EMBEDDING_DIM;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(
      `Invalid EMBEDDING_DIM: ${JSON.stringify(dimEnv)} — must be a positive integer ` +
        `equal to the pgvector column dimension (${DEFAULT_EMBEDDING_DIM}).`,
    );
  }
  cached = new HttpEmbeddingClient({
    url,
    model: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    dim,
    provider: process.env.EMBEDDING_PROVIDER ?? DEFAULT_EMBEDDING_PROVIDER,
    apiKey: process.env.EMBEDDING_API_KEY,
  });
  return cached;
}

/** Test hook: reset the cached singleton. */
export function resetEmbeddingClientForTests(): void {
  cached = null;
}
