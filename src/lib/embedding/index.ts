/**
 * 033-rag-vector-retrieval — embedding client wiring.
 *
 * Reads the `EMBEDDING_*` env vars (see CLAUDE.md env table) and constructs
 * the process-wide singleton {@link EmbeddingClient}. Two backends:
 *
 *   - `EMBEDDING_BACKEND=http` (default) — {@link HttpEmbeddingClient};
 *     requires `EMBEDDING_API_URL`. Dev path (Ollama) and any HF TEI / vLLM
 *     endpoint accessible over HTTP.
 *   - `EMBEDDING_BACKEND=sagemaker` — {@link SageMakerEmbeddingClient};
 *     requires `EMBEDDING_SAGEMAKER_ENDPOINT_NAME` and
 *     `EMBEDDING_SAGEMAKER_REGION`. Production path; AWS-tenant compute
 *     hosting nomic via the HuggingFace TEI container.
 *
 * Callers that may run without an embedding endpoint configured should use
 * {@link getEmbeddingClient} and handle the thrown error, or check
 * {@link isEmbeddingConfigured} first.
 */

import {
  HttpEmbeddingClient,
  withMaxBatch,
  type EmbeddingClient,
} from './client.js';
import { SageMakerEmbeddingClient } from './client-sagemaker.js';

export * from './client.js';
export { SageMakerEmbeddingClient } from './client-sagemaker.js';

// The Ollama tag is `nomic-embed-text` (which serves nomic-embed-text-v1.5,
// 768-dim). The model string is sent verbatim to the endpoint, so this must
// match the served tag — using `nomic-embed-text-v1.5` would 404 against Ollama.
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
export const DEFAULT_EMBEDDING_DIM = 768;
export const DEFAULT_EMBEDDING_PROVIDER = 'local';
// #882 — the served endpoint's batch ceiling. The production TEI container
// runs max_client_batch_size=32; a request carrying more inputs 413s
// deterministically, so the factory wraps every client in withMaxBatch.
// Override via EMBEDDING_MAX_BATCH when the served endpoint differs.
export const DEFAULT_EMBEDDING_MAX_BATCH = 32;

export type EmbeddingBackend = 'http' | 'sagemaker';

let cached: EmbeddingClient | null = null;

function resolveBackend(): EmbeddingBackend {
  const raw = process.env.EMBEDDING_BACKEND?.trim().toLowerCase();
  if (!raw || raw === 'http') return 'http';
  if (raw === 'sagemaker') return 'sagemaker';
  throw new Error(
    `Invalid EMBEDDING_BACKEND: ${JSON.stringify(process.env.EMBEDDING_BACKEND)} ` +
      `(expected "http" or "sagemaker").`,
  );
}

/**
 * True when the current `EMBEDDING_BACKEND` has the env vars it needs to
 * actually serve embeddings. The embedding worker and search paths only call
 * the client for memories that have opted into vector indexing; the server
 * logs a startup warning when indexed memories exist without a configured
 * endpoint.
 */
export function isEmbeddingConfigured(): boolean {
  try {
    const backend = resolveBackend();
    if (backend === 'sagemaker') {
      if (!process.env.EMBEDDING_SAGEMAKER_ENDPOINT_NAME) return false;
      if (!process.env.EMBEDDING_SAGEMAKER_REGION) return false;
      // Mirror the both-or-neither rule getEmbeddingClient() enforces
      // for the dedicated credentials pair. A half-configured pair
      // would make getEmbeddingClient() throw on every drain — without
      // this check, `isEmbeddingConfigured()` would return true and
      // the worker would enter a tight retry loop until the operator
      // notices. Same logic for the session token (only valid with
      // dedicated credentials present).
      const ak = process.env.EMBEDDING_SAGEMAKER_ACCESS_KEY_ID;
      const sk = process.env.EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY;
      if ((ak && !sk) || (!ak && sk)) return false;
      if (process.env.EMBEDDING_SAGEMAKER_SESSION_TOKEN && !(ak && sk)) {
        return false;
      }
      return true;
    }
    return !!process.env.EMBEDDING_API_URL;
  } catch {
    // Misconfigured EMBEDDING_BACKEND — treat as not configured; the
    // startup warning + the throw from getEmbeddingClient surface the
    // specific cause.
    return false;
  }
}

/**
 * The process-wide embedding client. Throws on missing or invalid
 * configuration so a misconfigured deploy fails loudly rather than
 * silently dropping vector writes.
 */
export function getEmbeddingClient(): EmbeddingClient {
  if (cached) return cached;
  const backend = resolveBackend();
  const dim = readDim();
  const model = process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const provider = process.env.EMBEDDING_PROVIDER;
  const queryTimeoutMs = readQueryTimeoutMs();

  if (backend === 'sagemaker') {
    const endpointName = process.env.EMBEDDING_SAGEMAKER_ENDPOINT_NAME;
    const region = process.env.EMBEDDING_SAGEMAKER_REGION;
    if (!endpointName) {
      throw new Error(
        'EMBEDDING_SAGEMAKER_ENDPOINT_NAME is not set — required when ' +
          'EMBEDDING_BACKEND=sagemaker. Set it to the SageMaker endpoint ' +
          'name (e.g. "hadron-embed-nomic-v1") that hosts nomic via the ' +
          'HuggingFace TEI container.',
      );
    }
    if (!region) {
      throw new Error(
        'EMBEDDING_SAGEMAKER_REGION is not set — required when ' +
          'EMBEDDING_BACKEND=sagemaker. Set it to the AWS region the ' +
          'endpoint lives in (e.g. "us-east-1").',
      );
    }
    // Optional dedicated SageMaker credentials. Recommended hardening:
    // a leaked SageMaker key then only buys `sagemaker:InvokeEndpoint`
    // on this endpoint, not whatever the host's default AWS identity
    // can reach. Both ID and SECRET must be set together — a
    // half-configured pair is rejected here rather than at first call.
    const accessKeyId = process.env.EMBEDDING_SAGEMAKER_ACCESS_KEY_ID;
    const secretAccessKey =
      process.env.EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY;
    if (
      (accessKeyId && !secretAccessKey) ||
      (!accessKeyId && secretAccessKey)
    ) {
      throw new Error(
        'EMBEDDING_SAGEMAKER_ACCESS_KEY_ID and EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY ' +
          'must be set together. Set both for the dedicated-credentials path ' +
          '(recommended), or neither to fall through to the AWS SDK default ' +
          'credential chain.',
      );
    }
    const sessionToken = process.env.EMBEDDING_SAGEMAKER_SESSION_TOKEN;
    if (sessionToken && !(accessKeyId && secretAccessKey)) {
      throw new Error(
        'EMBEDDING_SAGEMAKER_SESSION_TOKEN is set, but ' +
          'EMBEDDING_SAGEMAKER_ACCESS_KEY_ID / ' +
          'EMBEDDING_SAGEMAKER_SECRET_ACCESS_KEY are not. Session token is ' +
          'meaningful only as part of an STS-derived credential triple — ' +
          'set the access key pair too, or unset the session token.',
      );
    }

    cached = withMaxBatch(
      new SageMakerEmbeddingClient({
        endpointName,
        queryTimeoutMs,
        region,
        model,
        dim,
        provider,
        inferenceComponentName:
          process.env.EMBEDDING_SAGEMAKER_INFERENCE_COMPONENT,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      }),
      readMaxBatch(),
    );
    return cached;
  }

  // http backend
  const url = process.env.EMBEDDING_API_URL;
  if (!url) {
    throw new Error(
      'EMBEDDING_API_URL is not set — required for vector indexing (spec 033). ' +
        'Set it to a self-hosted embedding endpoint (dev: Ollama /api/embed), ' +
        'or set EMBEDDING_BACKEND=sagemaker for the SageMaker path.',
    );
  }
  cached = withMaxBatch(
    new HttpEmbeddingClient({
      url,
      queryTimeoutMs,
      model,
      dim,
      provider: provider ?? DEFAULT_EMBEDDING_PROVIDER,
      apiKey: process.env.EMBEDDING_API_KEY,
    }),
    readMaxBatch(),
  );
  return cached;
}

/**
 * Read EMBEDDING_MAX_BATCH (#882) — the largest number of inputs any single
 * upstream embed request may carry, a property of the SERVED endpoint (TEI's
 * max_client_batch_size; 32 on the production SageMaker endpoint). The
 * factory wraps every client in {@link withMaxBatch} with this value, so an
 * over-long node sub-batches instead of 413ing forever.
 */
function readMaxBatch(): number {
  const raw = process.env.EMBEDDING_MAX_BATCH;
  const max = raw ? Number(raw) : DEFAULT_EMBEDDING_MAX_BATCH;
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(
      `Invalid EMBEDDING_MAX_BATCH: ${JSON.stringify(raw)} — must be a positive integer ` +
        `matching the served endpoint's batch ceiling (default ${DEFAULT_EMBEDDING_MAX_BATCH}).`,
    );
  }
  return max;
}

/** #439: read once when the lazy client factory first runs, not at boot.
 * AbortSignal.timeout accepts at most 2^32-1 milliseconds in Node.
 */
function readQueryTimeoutMs(): number {
  const raw = process.env.EMBEDDING_QUERY_TIMEOUT_MS;
  const ms = raw === undefined ? 5000 : Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 4_294_967_295) {
    throw new Error('Invalid EMBEDDING_QUERY_TIMEOUT_MS: must be a positive safe integer no greater than 4294967295 (default 5000).');
  }
  return ms;
}

function readDim(): number {
  const dimEnv = process.env.EMBEDDING_DIM;
  const dim = dimEnv ? Number(dimEnv) : DEFAULT_EMBEDDING_DIM;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(
      `Invalid EMBEDDING_DIM: ${JSON.stringify(dimEnv)} — must be a positive integer ` +
        `equal to the pgvector column dimension (${DEFAULT_EMBEDDING_DIM}).`,
    );
  }
  return dim;
}

/** Test hook: reset the cached singleton. */
export function resetEmbeddingClientForTests(): void {
  cached = null;
}

/** Test hook: inject a stub client (CI has no embedding endpoint). */
export function setEmbeddingClientForTests(client: EmbeddingClient): void {
  cached = client;
}
