/**
 * #5167 step 2 (Holger: SeaweedFS for local dev and QA): the S3 client, unchanged, against a REAL S3-compatible store. This
 * is the "Step 2 verification checklist" of docs/plans/object-store-5167-comparison.md as tests, so the store chosen for
 * local dev and QA is proven against the client's own calls rather than against its documentation.
 *
 * Gated: skipped unless OBJECTSTORE_TEST_ENDPOINT is set (CI leaves it unset, like BUS_TEST_NATS_URL). Run it against the
 * local dev store started by `docker compose up -d s3 s3-init`:
 *
 *   OBJECTSTORE_TEST_ENDPOINT=http://localhost:9000 pnpm vitest run src/integrations/objectstore/s3/realStore5167.test.ts
 *
 * The credentials, bucket and portal origin default to the dev compose values (docker-compose.yaml); override with
 * OBJECTSTORE_TEST_ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _BUCKET / _ORIGIN. Every object it writes lives under one random
 * prefix and is deleted afterwards.
 *
 * Specs: hrn:node:hadronmemory.com:specs:cor:dmo:060:12 (staging promotion: server-side copy, head, delete) and
 * hrn:node:hadronmemory.com:specs:cor:dmo:060:13 (the orphan reaper's age floor reads LastModified from ListObjectsV2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../../lib/id.js';
import { buildStagingKey, buildStorageKey } from '../../../lib/asset/storageKey.js';
import { reapOrphanAssetObjects } from '../../../jobs/reapOrphanAssetObjects.js';
import {
  copyObject,
  deleteObject,
  getObjectStoreBucket,
  headObject,
  listObjectsPage,
  mintGetUrl,
  mintPutUrl,
  readObjectPrefix,
  resetObjectStoreClient,
} from './client.js';

const endpoint = process.env.OBJECTSTORE_TEST_ENDPOINT ?? '';
const origin = process.env.OBJECTSTORE_TEST_ORIGIN ?? 'http://localhost:5173';
const STORE_ENV = {
  ASSET_STORAGE_ENDPOINT: endpoint,
  ASSET_STORAGE_REGION: 'us-east-1',
  ASSET_STORAGE_BUCKET: process.env.OBJECTSTORE_TEST_BUCKET ?? 'hadron-assets-dev',
  ASSET_STORAGE_ACCESS_KEY_ID: process.env.OBJECTSTORE_TEST_ACCESS_KEY_ID ?? 'hadron-dev',
  ASSET_STORAGE_SECRET_ACCESS_KEY: process.env.OBJECTSTORE_TEST_SECRET_ACCESS_KEY ?? 'hadron-dev-secret',
  ASSET_STORAGE_FORCE_PATH_STYLE: undefined as string | undefined, // the client default (path-style), as in dev and QA
};
const DAY = 86_400_000;

describe.skipIf(!endpoint)('#5167 the S3 client against a real store (OBJECTSTORE_TEST_ENDPOINT)', () => {
  const saved: Record<string, string | undefined> = {};
  // One random memory URN per run: every key below lives under its path, and the reaper is scoped to it.
  const memoryUrn = `realstore5167:${generateId().slice(-12)}`;
  const prefix = `${memoryUrn.replace(/:/g, '/')}/`;
  const written = new Set<string>();

  beforeAll(() => {
    for (const [k, v] of Object.entries(STORE_ENV)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetObjectStoreClient();
  });
  afterAll(async () => {
    for (const key of written) await deleteObject(key).catch(() => undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetObjectStoreClient();
  });

  it('1: a browser-origin presigned PUT then GET, CORS preflight included', async () => {
    const key = buildStorageKey({ memoryUrn, assetId: generateId(), filename: 'hello.txt' });
    written.add(key);
    const body = 'hello from #5167';

    const putUrl = await mintPutUrl({ key, contentType: 'text/plain', contentLength: Buffer.byteLength(body), ttlSeconds: 300 });
    const preflight = await fetch(putUrl, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(preflight.status, 'preflight status').toBe(200);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-methods') ?? '').toMatch(/PUT/);

    const put = await fetch(putUrl, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body });
    expect(put.status, `presigned PUT: ${await put.clone().text()}`).toBe(200);
    expect(put.headers.get('access-control-allow-origin')).toBe(origin);

    const getUrl = await mintGetUrl({ key, ttlSeconds: 300 });
    const get = await fetch(getUrl, { headers: { Origin: origin } });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(body);
    expect(get.headers.get('access-control-allow-origin')).toBe(origin);
    expect(get.headers.get('access-control-expose-headers') ?? '').toMatch(/ETag/i);

    // Another origin is not allowed by the bucket's CORS rule.
    const foreign = await fetch(putUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).not.toBe('http://evil.example');
  });

  it('2: path-style addressing: the bucket is the first path segment of a presigned URL, on the endpoint host', async () => {
    const key = buildStorageKey({ memoryUrn, assetId: generateId(), filename: 'p.txt' });
    const url = new URL(await mintPutUrl({ key, contentType: 'text/plain', contentLength: 1, ttlSeconds: 60 }));
    expect(url.host).toBe(new URL(endpoint).host);
    expect(url.pathname.startsWith(`/${getObjectStoreBucket()}/`)).toBe(true);
    // The anonymous bucket listing is refused: the bucket is private.
    expect((await fetch(`${endpoint}/${getObjectStoreBucket()}`)).status).toBe(403);
  });

  it('3: stage, server-side copy to the permanent key, head, read, delete (cor:dmo:060:12)', async () => {
    const assetId = generateId();
    const staging = buildStagingKey({ memoryUrn, uploadId: generateId(), filename: 'doc.pdf' });
    const final = buildStorageKey({ memoryUrn, assetId, filename: 'doc.pdf' });
    written.add(staging).add(final);
    const bytes = Buffer.from('%PDF-1.7 #5167 staging');

    const put = await fetch(await mintPutUrl({ key: staging, contentType: 'application/pdf', contentLength: bytes.length, ttlSeconds: 300 }), {
      method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes,
    });
    expect(put.status).toBe(200);
    expect(await headObject(staging)).toMatchObject({ exists: true, contentLength: bytes.length, contentType: 'application/pdf' });

    await copyObject(staging, final);
    const head = await headObject(final);
    expect(head).toMatchObject({ exists: true, contentLength: bytes.length, contentType: 'application/pdf' });
    expect(head.etag).toBeTruthy();
    expect((await readObjectPrefix(final, 4))?.toString()).toBe('%PDF');

    await deleteObject(staging);
    expect(await headObject(staging)).toEqual({ exists: false });
    expect((await headObject(final)).exists).toBe(true);
    await deleteObject(final);
    expect(await headObject(final)).toEqual({ exists: false });
  });

  it('4: ListObjectsV2 returns LastModified, and the reaper dry run reads it as its age floor (cor:dmo:060:13)', async () => {
    const key = buildStorageKey({ memoryUrn, assetId: generateId(), filename: 'orphan.txt' });
    written.add(key);
    const put = await fetch(await mintPutUrl({ key, contentType: 'text/plain', contentLength: 1, ttlSeconds: 300 }), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    });
    expect(put.status).toBe(200);

    const page = await listObjectsPage({ prefix, continuationToken: null, maxKeys: 100 });
    const listed = page.objects.find((o) => o.key === key);
    expect(listed, 'the object is listed').toBeTruthy();
    expect(listed!.lastModified).toBeInstanceOf(Date);
    expect(Math.abs(listed!.lastModified!.getTime() - Date.now())).toBeLessThan(10 * 60_000);

    // Now: too young (the floor holds). Two days on: an orphan, as it has no Asset row. Dry run either way.
    const young = await reapOrphanAssetObjects({ prefix, apply: false });
    expect(young).toMatchObject({ dryRun: true, reaped: 0, orphans: 0 });
    expect(young.tooYoung).toBeGreaterThanOrEqual(1);
    const later = await reapOrphanAssetObjects({ prefix, apply: false, now: new Date(Date.now() + 2 * DAY) });
    expect(later).toMatchObject({ dryRun: true, reaped: 0, tooYoung: 0 });
    expect(later.orphans).toBeGreaterThanOrEqual(1);
    expect(later.sample).toContain(key);
    expect((await headObject(key)).exists, 'a dry run deletes nothing').toBe(true);
  });
});
