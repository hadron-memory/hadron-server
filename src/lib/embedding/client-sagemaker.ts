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
}

export class SageMakerEmbeddingClient implements EmbeddingClient {
  readonly provider: string;
  readonly model: string;
  readonly dim: number;
  private readonly endpointName: string;
  private readonly inferenceComponentName?: string;
  private readonly sdk: SageMakerRuntimeClient;

  constructor(opts: SageMakerEmbeddingClientOptions) {
    this.endpointName = opts.endpointName;
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

    let response;
    try {
      response = await this.sdk.send(command);
    } catch (err) {
      // AWS SDK errors carry a `name` (e.g. "ValidationException",
      // "ModelError", "ServiceUnavailable") that the worker's
      // attempt-classifier can read off `embeddingError` to decide
      // transient-vs-permanent. Surface it untouched.
      throw new EmbeddingRequestError(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
    }

    if (!response.Body) {
      throw new EmbeddingRequestError('SageMaker response had no Body');
    }

    let body: unknown;
    try {
      const text = await streamToString(response.Body);
      body = JSON.parse(text);
    } catch (err) {
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
  // Fallback — consume an async iterable / ReadableStream of bytes.
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
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}
