// Object-store client wrapper (AWS S3 SDK against any S3-compatible
// API). Asset bytes live here.
//
// **Provider: Hetzner Object Storage** (Holger's call, 2026-08-06) —
// the same provider the hourly Postgres backups already use, so assets
// do not introduce a second storage vendor. The module and directory
// are still named `r2` for the Cloudflare R2 deployment this was first
// written for; the CODE is provider-neutral and the name is the only
// R2-specific thing left. MinIO covers local dev.
//
// Configuration is `OBJECT_STORAGE_*`, with the legacy `R2_*` names
// still honored as fallbacks so an existing deployment keeps working
// without a coordinated env change:
//
//   OBJECT_STORAGE_ENDPOINT       e.g. https://nbg1.your-objectstorage.com
//   OBJECT_STORAGE_REGION         e.g. nbg1   (default: auto)
//   OBJECT_STORAGE_BUCKET
//   OBJECT_STORAGE_ACCESS_KEY_ID
//   OBJECT_STORAGE_SECRET_ACCESS_KEY
//
// Region matters on Hetzner in a way it does not on R2: R2 accepts the
// pseudo-region `auto`, while Hetzner signs SigV4 against its real
// region name, so a wrong value fails authentication rather than
// routing somewhere unexpected. It stays defaulted to `auto` for R2
// compatibility — set it explicitly on Hetzner.
//
// Spec: hadron-portal/specs/001-asset-upload/contracts/http-endpoints.md.

import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let cached: S3Client | null = null;

/** First non-empty value among the given env vars. */
function env(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return '';
}

export function getObjectStoreClient(): S3Client {
  if (cached) return cached;
  const accountId = env('R2_ACCOUNT_ID');
  const accessKeyId = env('OBJECT_STORAGE_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID');
  const secretAccessKey = env(
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    'R2_SECRET_ACCESS_KEY',
  );
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'OBJECT_STORAGE_NOT_CONFIGURED: missing OBJECT_STORAGE_ACCESS_KEY_ID or OBJECT_STORAGE_SECRET_ACCESS_KEY',
    );
  }
  // An explicit endpoint wins; otherwise derive R2's from the account id.
  const explicitEndpoint = env('OBJECT_STORAGE_ENDPOINT', 'R2_ENDPOINT_OVERRIDE');
  const endpoint =
    explicitEndpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  if (!endpoint) {
    throw new Error(
      'OBJECT_STORAGE_NOT_CONFIGURED: set OBJECT_STORAGE_ENDPOINT (or R2_ACCOUNT_ID)',
    );
  }
  cached = new S3Client({
    region: env('OBJECT_STORAGE_REGION') || 'auto',
    endpoint,
    // Path-style addressing whenever the endpoint is given explicitly:
    // both Hetzner and MinIO want it, and R2's derived endpoint is the
    // only case that needs virtual-hosted style.
    forcePathStyle: !!explicitEndpoint,
    credentials: { accessKeyId, secretAccessKey },
    // AWS SDK v3 adds flexible-checksum headers by default
    // (x-amz-checksum-crc32 etc.) that MinIO and some R2 path-style
    // configurations reject with ERR_CONNECTION_RESET on presigned PUT.
    // Compute checksums only when the operation actually requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return cached;
}

export function getObjectStoreBucket(): string {
  const bucket = env('OBJECT_STORAGE_BUCKET', 'R2_BUCKET_NAME');
  if (!bucket) {
    throw new Error('OBJECT_STORAGE_NOT_CONFIGURED: missing OBJECT_STORAGE_BUCKET');
  }
  return bucket;
}

// For tests / hot config swaps.
export function resetObjectStoreClient(): void {
  cached = null;
}

export interface PresignedPutOptions {
  key: string;
  contentType: string;
  contentLength: number;
  ttlSeconds: number;
}

export async function mintPutUrl(opts: PresignedPutOptions): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: getObjectStoreBucket(),
    Key: opts.key,
    ContentType: opts.contentType,
    ContentLength: opts.contentLength,
  });
  return getSignedUrl(getObjectStoreClient(), cmd, { expiresIn: opts.ttlSeconds });
}

export interface PresignedGetOptions {
  key: string;
  ttlSeconds: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}

export async function mintGetUrl(opts: PresignedGetOptions): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: getObjectStoreBucket(),
    Key: opts.key,
    ResponseContentDisposition: opts.responseContentDisposition,
    ResponseContentType: opts.responseContentType,
  });
  return getSignedUrl(getObjectStoreClient(), cmd, { expiresIn: opts.ttlSeconds });
}

/**
 * Server-side direct write — for platform-authored bytes (e.g. the
 * hadron_store_file run tool). Browser uploads keep using mintPutUrl;
 * this path is for content the server already holds.
 */
export async function putObject(opts: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await getObjectStoreClient().send(
    new PutObjectCommand({
      Bucket: getObjectStoreBucket(),
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
      ContentLength: opts.body.byteLength,
    }),
  );
}

export interface HeadResult {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
  etag?: string;
}

export async function headObject(key: string): Promise<HeadResult> {
  try {
    const out: HeadObjectCommandOutput = await getObjectStoreClient().send(
      new HeadObjectCommand({ Bucket: getObjectStoreBucket(), Key: key }),
    );
    return {
      exists: true,
      contentLength: out.ContentLength,
      contentType: out.ContentType,
      etag: out.ETag,
    };
  } catch (err: unknown) {
    if (isNotFound(err)) return { exists: false };
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await getObjectStoreClient().send(
    new DeleteObjectCommand({ Bucket: getObjectStoreBucket(), Key: key }),
  );
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}
