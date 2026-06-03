/**
 * 033-rag-vector-retrieval — embedding client.
 *
 * v1 uses a single platform-fixed, self-hosted embedding model
 * (`nomic-embed-text-v1.5`, 768-dim) reached at a configurable endpoint.
 * Two backends are supported:
 *
 *   - **HTTP** ({@link HttpEmbeddingClient}) — used in development against
 *     Ollama `/api/embed`. Also serves any HF TEI / vLLM endpoint that
 *     exposes either the Ollama or OpenAI response shape.
 *   - **AWS SageMaker Real-Time Inference** ({@link SageMakerEmbeddingClient}
 *     in `./client-sagemaker.ts`) — the production path; hosts nomic on a
 *     SageMaker endpoint via the HuggingFace TEI container. AWS-tenant
 *     compute, so no plaintext leaves Hadron infrastructure (privacy
 *     posture, FR-026).
 *
 * nomic requires task-instruction prefixes — `search_document:` for indexed
 * documents, `search_query:` for queries (D-R1). Getting this wrong silently
 * degrades recall, so every client implementation applies it via
 * {@link applyNomicPrefix} (never the call site).
 */

export type EmbedPurpose = 'document' | 'query';

export interface EmbeddingClient {
  /** One vector per input, each of length `dim`. Applies the nomic prefix. */
  embed(texts: string[], purpose: EmbedPurpose): Promise<number[][]>;
  readonly provider: string; // e.g. "local" / "aws-sagemaker" (stored per vector)
  readonly model: string; // e.g. "nomic-embed-text-v1.5" (stored per vector, FR-014)
  readonly dim: number; // 768; MUST equal the pgvector column dimension
}

export interface HttpEmbeddingClientOptions {
  url: string;
  model: string;
  dim: number;
  provider?: string;
  apiKey?: string;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const PREFIX: Record<EmbedPurpose, string> = {
  document: 'search_document: ',
  query: 'search_query: ',
};

/**
 * Apply the nomic task-instruction prefix to every input. Exported so
 * non-HTTP backends ({@link SageMakerEmbeddingClient}) prepend the same
 * prefix without duplicating the table — getting this wrong silently
 * degrades recall.
 */
export function applyNomicPrefix(texts: string[], purpose: EmbedPurpose): string[] {
  return texts.map((t) => PREFIX[purpose] + t);
}

/**
 * Thrown when the embedding endpoint returns vectors of an unexpected
 * dimension — almost always a model/`EMBEDDING_DIM` mismatch that would
 * silently corrupt the index. The worker treats it as a (transient) failure.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`EMBEDDING_DIMENSION_MISMATCH: expected ${expected}, got ${actual}`);
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/** Thrown when the endpoint errors or returns an unparseable body. */
export class EmbeddingRequestError extends Error {
  constructor(message: string) {
    super(`EMBEDDING_REQUEST_FAILED: ${message}`);
    this.name = 'EmbeddingRequestError';
  }
}

/**
 * HTTP embedding client. Sends `{ model, input: string[] }` and accepts both
 * the Ollama (`{ embeddings: number[][] }`) and OpenAI-compatible
 * (`{ data: [{ embedding }] }`) response shapes, so the actual inference
 * server is swappable behind `EMBEDDING_API_URL`.
 */
export class HttpEmbeddingClient implements EmbeddingClient {
  readonly provider: string;
  readonly model: string;
  readonly dim: number;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpEmbeddingClientOptions) {
    this.url = opts.url;
    this.model = opts.model;
    this.dim = opts.dim;
    this.provider = opts.provider ?? 'local';
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], purpose: EmbedPurpose): Promise<number[][]> {
    if (texts.length === 0) return [];
    const input = applyNomicPrefix(texts, purpose);

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input }),
      });
    } catch (err) {
      throw new EmbeddingRequestError(err instanceof Error ? err.message : String(err));
    }

    if (!res.ok) {
      throw new EmbeddingRequestError(`HTTP ${res.status} from ${this.url}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new EmbeddingRequestError('response was not valid JSON');
    }

    const vectors = extractVectors(body);
    if (vectors === null) {
      throw new EmbeddingRequestError('response had no recognizable embeddings');
    }
    validateVectorShape(vectors, texts.length, this.dim);
    return vectors;
  }
}

/**
 * Common post-parse validation: count matches input, every vector matches the
 * configured dimension. Throws the same typed errors regardless of backend so
 * the worker's failure-classification path stays uniform.
 */
export function validateVectorShape(
  vectors: number[][],
  expectedCount: number,
  expectedDim: number,
): void {
  if (vectors.length !== expectedCount) {
    throw new EmbeddingRequestError(
      `expected ${expectedCount} vectors, got ${vectors.length}`,
    );
  }
  for (const v of vectors) {
    if (v.length !== expectedDim) {
      throw new EmbeddingDimensionMismatchError(expectedDim, v.length);
    }
  }
}

/**
 * Parse one of three known response shapes:
 *   - Ollama:                   `{ embeddings: number[][] }`
 *   - OpenAI / OpenAI-compat:   `{ data: [{ embedding: number[] }] }`
 *   - HuggingFace TEI native:   `number[][]` (top-level 2D array)
 *
 * The TEI native shape is what the HuggingFace TEI container on SageMaker
 * returns when invoked through the SageMaker Runtime SDK — the container
 * passes its raw response through, and TEI's `/embed` returns a bare 2D
 * array (no envelope).
 *
 * Returns null on any shape we don't recognize OR can't fully validate —
 * every element must be an array of finite numbers, so a malformed body
 * (null entries, non-numeric values) is rejected as a request error rather
 * than silently producing junk vectors that pass the later dimension check.
 */
export function extractVectors(body: unknown): number[][] | null {
  // TEI native: top-level 2D array.
  if (Array.isArray(body)) {
    return validateRaw(body);
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  let raw: unknown[];
  if (Array.isArray(b.embeddings)) {
    // Ollama /api/embed
    raw = b.embeddings;
  } else if (Array.isArray(b.data)) {
    // OpenAI /v1/embeddings — each element is { embedding: number[] }
    raw = (b.data as unknown[]).map((d) =>
      typeof d === 'object' && d !== null
        ? (d as Record<string, unknown>).embedding
        : undefined,
    );
  } else {
    return null;
  }

  return validateRaw(raw);
}

function validateRaw(raw: unknown[]): number[][] | null {
  const out: number[][] = [];
  for (const v of raw) {
    if (!Array.isArray(v) || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return null;
    }
    out.push(v as number[]);
  }
  return out;
}
