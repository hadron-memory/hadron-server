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
// Configuration is `ASSET_STORAGE_*` — named for what the bucket HOLDS
// rather than who provides it, so moving providers needs no rename:
//
//   ASSET_STORAGE_ENDPOINT           e.g. https://nbg1.your-objectstorage.com
//   ASSET_STORAGE_REGION             e.g. nbg1   (default: auto)
//   ASSET_STORAGE_BUCKET
//   ASSET_STORAGE_ACCESS_KEY_ID
//   ASSET_STORAGE_SECRET_ACCESS_KEY
//   ASSET_STORAGE_FORCE_PATH_STYLE   default true; set false for R2
//
// These names are the ONLY ones read. The earlier `OBJECT_STORAGE_*` and
// `R2_*` spellings were deliberately dropped rather than kept as
// fallbacks (Holger, 2026-08-06) — asset storage had never actually been
// configured in any environment, so there was no deployment to keep
// working, and a silent fallback chain is exactly what turns a
// misconfigured env into a confusing runtime error later.
//
// Region matters on Hetzner in a way it does not on R2: R2 accepts the
// pseudo-region `auto`, while Hetzner signs SigV4 against its real
// region name, so a wrong value fails AUTHENTICATION rather than routing
// somewhere unexpected — it reads like a bad key. Default stays `auto`;
// set it explicitly on Hetzner.
//
// Path-style addressing is the default because Hetzner and MinIO both
// require it. R2 wants virtual-hosted style, so it needs
// ASSET_STORAGE_FORCE_PATH_STYLE=false plus its full endpoint. (This
// replaces an earlier rule that inferred path-style from whether the
// endpoint was explicit — the endpoint is now always explicit, so the
// inference had no signal left to read.)
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

/** Value of an env var, or '' when unset or empty. */
function env(name: string): string {
  return process.env[name] ?? '';
}

export function getObjectStoreClient(): S3Client {
  if (cached) return cached;
  const accessKeyId = env('ASSET_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = env('ASSET_STORAGE_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'ASSET_STORAGE_NOT_CONFIGURED: missing ASSET_STORAGE_ACCESS_KEY_ID or ASSET_STORAGE_SECRET_ACCESS_KEY',
    );
  }
  const endpoint = env('ASSET_STORAGE_ENDPOINT');
  if (!endpoint) {
    throw new Error('ASSET_STORAGE_NOT_CONFIGURED: missing ASSET_STORAGE_ENDPOINT');
  }
  cached = new S3Client({
    region: env('ASSET_STORAGE_REGION') || 'auto',
    endpoint,
    // Hetzner and MinIO both require path-style; R2 is the exception and
    // opts out explicitly.
    forcePathStyle: env('ASSET_STORAGE_FORCE_PATH_STYLE') !== 'false',
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
  const bucket = env('ASSET_STORAGE_BUCKET');
  if (!bucket) {
    throw new Error('ASSET_STORAGE_NOT_CONFIGURED: missing ASSET_STORAGE_BUCKET');
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

/**
 * Read the first `length` bytes of an object.
 *
 * Ranged on purpose: the caller wants a file's magic bytes, and pulling
 * a whole 25MB upload into memory to look at 12 of them would be an easy
 * way to turn an upload into an OOM.
 *
 * Returns null when the object is missing, when the store returned no
 * body, or when the range isn't satisfiable (a file shorter than the
 * requested window still returns what exists, but a zero-byte object
 * yields nothing).
 */
export async function readObjectPrefix(
  key: string,
  length: number,
): Promise<Buffer | null> {
  try {
    const out = await getObjectStoreClient().send(
      new GetObjectCommand({
        Bucket: getObjectStoreBucket(),
        Key: key,
        Range: `bytes=0-${Math.max(0, length - 1)}`,
      }),
    );
    if (!out.Body) return null;
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    // 416 Range Not Satisfiable — an empty object. Not an error here.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 416) return null;
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
