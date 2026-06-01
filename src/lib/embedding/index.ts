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

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';
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
  const dim = process.env.EMBEDDING_DIM
    ? Number(process.env.EMBEDDING_DIM)
    : DEFAULT_EMBEDDING_DIM;
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
