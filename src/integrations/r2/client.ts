// Cloudflare R2 client wrapper. Uses the AWS S3 SDK against R2's
// S3-compatible API. In local dev, R2_ENDPOINT_OVERRIDE points at MinIO.
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

export function getR2Client(): S3Client {
  if (cached) return cached;
  const accountId = process.env.R2_ACCOUNT_ID ?? '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? '';
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('R2_NOT_CONFIGURED: missing R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY');
  }
  const endpoint =
    process.env.R2_ENDPOINT_OVERRIDE ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  if (!endpoint) {
    throw new Error('R2_NOT_CONFIGURED: missing R2_ACCOUNT_ID and no R2_ENDPOINT_OVERRIDE');
  }
  cached = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: !!process.env.R2_ENDPOINT_OVERRIDE,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cached;
}

export function getR2Bucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error('R2_NOT_CONFIGURED: missing R2_BUCKET_NAME');
  return bucket;
}

// For tests / hot config swaps.
export function resetR2Client(): void {
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
    Bucket: getR2Bucket(),
    Key: opts.key,
    ContentType: opts.contentType,
    ContentLength: opts.contentLength,
  });
  return getSignedUrl(getR2Client(), cmd, { expiresIn: opts.ttlSeconds });
}

export interface PresignedGetOptions {
  key: string;
  ttlSeconds: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}

export async function mintGetUrl(opts: PresignedGetOptions): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: getR2Bucket(),
    Key: opts.key,
    ResponseContentDisposition: opts.responseContentDisposition,
    ResponseContentType: opts.responseContentType,
  });
  return getSignedUrl(getR2Client(), cmd, { expiresIn: opts.ttlSeconds });
}

export interface HeadResult {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
  etag?: string;
}

export async function headObject(key: string): Promise<HeadResult> {
  try {
    const out: HeadObjectCommandOutput = await getR2Client().send(
      new HeadObjectCommand({ Bucket: getR2Bucket(), Key: key }),
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
  await getR2Client().send(
    new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: key }),
  );
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}
