/**
 * 033-rag-vector-retrieval — embedding client.
 *
 * v1 uses a single platform-fixed, self-hosted embedding model
 * (`nomic-embed-text-v1.5`, 768-dim) reached over HTTP at a configurable
 * endpoint (Ollama `/api/embed` in dev; HF TEI / vLLM in prod). No node
 * plaintext leaves Hadron infra (privacy posture, FR-026).
 *
 * nomic requires task-instruction prefixes — `search_document:` for indexed
 * documents, `search_query:` for queries (D-R1). Getting this wrong silently
 * degrades recall, so the client applies it (never the call site).
 */

export type EmbedPurpose = 'document' | 'query';

export interface EmbeddingClient {
  /** One vector per input, each of length `dim`. Applies the nomic prefix. */
  embed(texts: string[], purpose: EmbedPurpose): Promise<number[][]>;
  readonly provider: string; // e.g. "local" (stored per vector)
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
    const input = texts.map((t) => PREFIX[purpose] + t);

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
      throw new EmbeddingRequestError((err as Error).message);
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
    if (vectors.length !== texts.length) {
      throw new EmbeddingRequestError(
        `expected ${texts.length} vectors, got ${vectors.length}`,
      );
    }
    for (const v of vectors) {
      if (v.length !== this.dim) {
        throw new EmbeddingDimensionMismatchError(this.dim, v.length);
      }
    }
    return vectors;
  }
}

/** Parse Ollama (`embeddings`) or OpenAI (`data[].embedding`) response bodies. */
function extractVectors(body: unknown): number[][] | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  // Ollama /api/embed
  if (Array.isArray(b.embeddings)) {
    return b.embeddings as number[][];
  }
  // OpenAI /v1/embeddings
  if (Array.isArray(b.data)) {
    const out = (b.data as Array<{ embedding?: unknown }>).map((d) => d.embedding);
    if (out.every((e) => Array.isArray(e))) return out as number[][];
  }
  return null;
}
