/**
 * 033-rag-vector-retrieval — AWS SageMaker Real-Time Inference embedding client.
 *
 * Production path. Hosts `nomic-embed-text-v1.5` on a SageMaker endpoint via
 * the HuggingFace Text-Embeddings-Inference (TEI) container; the worker
 * invokes the endpoint via the SageMaker Runtime SDK. Authentication uses the
 * AWS SDK's standard credential chain (IAM role on the host, AWS_PROFILE,
 * AWS_ACCESS_KEY_ID/SECRET, etc.) — no app-level secret handling.
 *
 * Privacy posture: SageMaker is AWS-tenant compute — the model is hosted in
 * Hadron's AWS account, the request never reaches a hosted-inference vendor
 * (no OpenAI / Voyage / Bedrock), and so FR-026 is preserved. The trust
 * boundary widens to "AWS as infrastructure provider," same shape as running
 * the model on any other Linux host you control.
 *
 * Request/response shape: the HuggingFace TEI container accepts
 * `{ inputs: string[] }` (with optional `truncate`) and returns a top-level
 * `number[][]` (the TEI native shape — no `embeddings` or `data` wrapper).
 * {@link extractVectors} in `./client.ts` handles the TEI shape directly.
 */

import {
  SageMakerRuntimeClient,
  InvokeEndpointCommand,
} from '@aws-sdk/client-sagemaker-runtime';

import {
  type EmbedPurpose,
  type EmbeddingClient,
  EmbeddingRequestError,
  applyNomicPrefix,
  extractVectors,
  validateVectorShape,
} from './client.js';

export interface SageMakerEmbeddingClientOptions {
  /** SageMaker endpoint name (NOT a URL). e.g. "hadron-embed-nomic-v1". */
  endpointName: string;
  /** AWS region the endpoint lives in. */
  region: string;
  model: string;
  dim: number;
  provider?: string;
  /** Optional inference-component name (multi-model endpoints). */
  inferenceComponentName?: string;
  /**
   * Optional dedicated AWS credentials. When supplied, the underlying
   * SageMakerRuntimeClient uses these instead of the SDK's default
   * credential chain — recommended hardening so a leaked SageMaker key
   * only buys `sagemaker:InvokeEndpoint` on the configured endpoint and
   * NOT whatever the host's default AWS identity can reach (S3 buckets,
   * other AWS services, account-level enumeration). When unsupplied the
   * SDK falls through to its standard chain (IAM role on host,
   * AWS_PROFILE, AWS_ACCESS_KEY_ID/SECRET) — usable for dev / single-
   * tenant deploys where a separate IAM principal isn't worth the
   * Doppler overhead.
   */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Optional STS session token; only needed for temporary credentials. */
  sessionToken?: string;
  /**
   * Test hook: inject a pre-constructed SDK client. Production code does
   * NOT pass this; the constructor builds its own from `region` and the
   * optional dedicated credentials.
   */
  sdkClient?: SageMakerRuntimeClient;
  /** Query-only deadline; document calls retain the existing SDK behavior. */
  queryTimeoutMs?: number;
}

export class SageMakerEmbeddingClient implements EmbeddingClient {
  readonly provider: string;
  readonly model: string;
  readonly dim: number;
  private readonly endpointName: string;
  private readonly inferenceComponentName?: string;
  private readonly sdk: SageMakerRuntimeClient;
  private readonly queryTimeoutMs?: number;

  constructor(opts: SageMakerEmbeddingClientOptions) {
    this.endpointName = opts.endpointName;
    this.queryTimeoutMs = opts.queryTimeoutMs;
    this.model = opts.model;
    this.dim = opts.dim;
    // Default provider label captures the lineage clearly when stored
    // per-vector — "aws-sagemaker" disambiguates from the http-backend
    // "local" default.
    this.provider = opts.provider ?? 'aws-sagemaker';
    this.inferenceComponentName = opts.inferenceComponentName;

    if (opts.sdkClient) {
      this.sdk = opts.sdkClient;
    } else {
      // Build credentials object only when BOTH access key id and secret
      // are present. The dedicated-credentials path is opt-in; absence
      // means "use the SDK default chain." A half-configured pair would
      // be ambiguous, so the factory in `./index.ts` rejects that case
      // before this constructor is ever called.
      const credentials =
        opts.accessKeyId && opts.secretAccessKey
          ? {
              accessKeyId: opts.accessKeyId,
              secretAccessKey: opts.secretAccessKey,
              ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
            }
          : undefined;
      this.sdk = new SageMakerRuntimeClient({
        region: opts.region,
        ...(credentials ? { credentials } : {}),
      });
    }
  }

  async embed(texts: string[], purpose: EmbedPurpose): Promise<number[][]> {
    if (texts.length === 0) return [];
    const inputs = applyNomicPrefix(texts, purpose);

    const command = new InvokeEndpointCommand({
      EndpointName: this.endpointName,
      ContentType: 'application/json',
      Accept: 'application/json',
      Body: new TextEncoder().encode(JSON.stringify({ inputs })),
      ...(this.inferenceComponentName
        ? { InferenceComponentName: this.inferenceComponentName }
        : {}),
    });

    const signal = purpose === 'query' && this.queryTimeoutMs !== undefined
      ? AbortSignal.timeout(this.queryTimeoutMs) : undefined;
    let response;
    try {
      response = signal
        ? await this.sdk.send(command, { abortSignal: signal })
        : await this.sdk.send(command);
    } catch (err) {
      if (signal?.aborted) throw new EmbeddingRequestError(`query embed timed out after ${this.queryTimeoutMs}ms`);
      // AWS SDK errors carry a `name` (e.g. "ValidationException",
      // "ModelError", "ServiceUnavailable"). Including it in the
      // wrapped message keeps diagnostic info available on
      // `embeddingError`. Handle three shapes: real Error, plain
      // object with a message (common when errors cross VM contexts
      // or are deserialized), and unknown. `retryable` feeds the
      // worker's give-up-vs-backoff decision (#882).
      throw new EmbeddingRequestError(formatAwsError(err), {
        retryable: isAwsErrorRetryable(err),
      });
    }

    if (!response.Body) {
      throw new EmbeddingRequestError('SageMaker response had no Body');
    }

    let body: unknown;
    try {
      const text = await streamToString(response.Body);
      body = JSON.parse(text);
    } catch (err) {
      if (signal?.aborted) throw new EmbeddingRequestError(`query embed timed out after ${this.queryTimeoutMs}ms`);
      throw new EmbeddingRequestError(
        `response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const vectors = extractVectors(body);
    if (vectors === null) {
      throw new EmbeddingRequestError(
        'SageMaker response had no recognizable embeddings (expected TEI 2D array, Ollama {embeddings}, or OpenAI {data})',
      );
    }
    validateVectorShape(vectors, texts.length, this.dim);
    return vectors;
  }
}

/**
 * Drain a SageMaker InvokeEndpoint response Body to a string. The SDK types
 * the Body union as Uint8Array | Blob | ReadableStream depending on runtime;
 * in Node both the buffered (`transformToString`) and stream interfaces are
 * available. We prefer the former when present.
 */
async function streamToString(body: unknown): Promise<string> {
  if (body && typeof (body as { transformToString?: unknown }).transformToString === 'function') {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  // Node.js `Readable` streams implement Symbol.asyncIterator natively;
  // the WHATWG `ReadableStream` (used by undici / fetch) implements both
  // asyncIterator (in recent Node) and getReader. Prefer the
  // asyncIterator path so a plain Node Readable (common in tests and
  // mocks) drains cleanly without a TypeError.
  if (body && typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.length;
    }
    return concatToString(chunks, total);
  }
  // Fallback — WHATWG ReadableStream without asyncIterator support.
  const reader = (body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> })
    .getReader?.();
  if (!reader) {
    throw new EmbeddingRequestError('unrecognized SageMaker Body shape');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  return concatToString(chunks, total);
}

function concatToString(chunks: Uint8Array[], total: number): string {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Classify an AWS SDK error for the worker's retry decision (#882).
 *
 * A 4xx `httpStatusCode` on `$metadata` means SageMaker deterministically
 * rejected the request (ValidationException, AccessDenied, …) — retrying
 * identically cannot succeed, so it is NOT retryable. Three 4xx statuses
 * stay retryable: 408 (timeout), 429 (throttling), and 424 (ModelError —
 * SageMaker's pass-through for container-side failures, which is where
 * invocation timeouts like the 65 observed in #882 land; a container
 * failure is content- or load-dependent, not a deterministic contract
 * violation). Anything without a parseable status (network errors,
 * 5xx, unknown shapes) defaults to retryable.
 */
function isAwsErrorRetryable(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return status === 408 || status === 424 || status === 429;
  }
  return true;
}

/**
 * Format an AWS SDK error so the SDK error `name` (e.g. "ValidationException",
 * "ModelError") stays visible in `embeddingError`. Handles three shapes:
 *   - real `Error` instance (the common path),
 *   - plain object with a `message` (errors that have crossed VM contexts
 *     or been deserialized — common in tests),
 *   - anything else (falls back to `String(err)`).
 */
function formatAwsError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const obj = err as { name?: unknown; message?: unknown };
    const name = typeof obj.name === 'string' ? obj.name : 'Error';
    const message = typeof obj.message === 'string' ? obj.message : String(obj.message);
    return `${name}: ${message}`;
  }
  return String(err);
}
