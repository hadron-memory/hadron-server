// Unit tests for object-store client config wiring. The actual presign /
// S3 calls are covered by integration tests against MinIO; here we verify
// env-handling and the not-configured failure modes only.
//
// Both the current OBJECT_STORAGE_* names and the legacy R2_* fallbacks
// are exercised — the fallbacks exist so an already-deployed environment
// keeps working without a coordinated env change, which only holds if
// something proves they still resolve.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetObjectStoreClient, getObjectStoreClient, getObjectStoreBucket } from './client.js';

const ENV_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT_OVERRIDE',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
];

describe('object store client', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetObjectStoreClient();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetObjectStoreClient();
  });

  it('throws OBJECT_STORAGE_NOT_CONFIGURED without credentials', () => {
    expect(() => getObjectStoreClient()).toThrow(/OBJECT_STORAGE_NOT_CONFIGURED/);
  });

  it('throws OBJECT_STORAGE_NOT_CONFIGURED without an endpoint', () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    expect(() => getObjectStoreClient()).toThrow(/OBJECT_STORAGE_NOT_CONFIGURED/);
  });

  it('throws OBJECT_STORAGE_NOT_CONFIGURED without bucket', () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    expect(() => getObjectStoreBucket()).toThrow(/OBJECT_STORAGE_NOT_CONFIGURED/);
  });

  // ── Hetzner (the configured provider) ──

  it('builds a client from OBJECT_STORAGE_* against a Hetzner endpoint', () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    process.env.OBJECT_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    process.env.OBJECT_STORAGE_REGION = 'nbg1';
    expect(getObjectStoreClient()).toBeDefined();
  });

  it('uses path-style addressing when an endpoint is given explicitly', () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    process.env.OBJECT_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    // Hetzner and MinIO both need path-style; only R2's derived endpoint
    // wants virtual-hosted style.
    const client = getObjectStoreClient();
    expect(client.config.forcePathStyle).toBe(true);
  });

  it('honors OBJECT_STORAGE_REGION (Hetzner signs against a real region)', async () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    process.env.OBJECT_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    process.env.OBJECT_STORAGE_REGION = 'nbg1';
    const client = getObjectStoreClient();
    expect(await client.config.region()).toBe('nbg1');
  });

  it("defaults region to R2's pseudo-region when unset", async () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    process.env.OBJECT_STORAGE_ENDPOINT = 'http://localhost:9000';
    const client = getObjectStoreClient();
    expect(await client.config.region()).toBe('auto');
  });

  it('reads the bucket from OBJECT_STORAGE_BUCKET', () => {
    process.env.OBJECT_STORAGE_BUCKET = 'hadron-assets';
    expect(getObjectStoreBucket()).toBe('hadron-assets');
  });

  // ── Legacy R2_* fallbacks ──

  it('builds a client when account id provides the endpoint (R2)', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ACCOUNT_ID = 'acct';
    const client = getObjectStoreClient();
    expect(client).toBeDefined();
    // Derived R2 endpoint — virtual-hosted style, not path style.
    expect(client.config.forcePathStyle).toBe(false);
  });

  it('builds a client when R2_ENDPOINT_OVERRIDE is set (MinIO)', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ENDPOINT_OVERRIDE = 'http://localhost:9000';
    expect(getObjectStoreClient()).toBeDefined();
  });

  it('falls back to R2_BUCKET_NAME for the bucket', () => {
    process.env.R2_BUCKET_NAME = 'legacy-bucket';
    expect(getObjectStoreBucket()).toBe('legacy-bucket');
  });

  it('prefers OBJECT_STORAGE_* over the legacy R2_* names', () => {
    process.env.R2_BUCKET_NAME = 'legacy-bucket';
    process.env.OBJECT_STORAGE_BUCKET = 'new-bucket';
    expect(getObjectStoreBucket()).toBe('new-bucket');
  });

  it('caches the client across calls', () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    process.env.OBJECT_STORAGE_ENDPOINT = 'http://localhost:9000';
    expect(getObjectStoreClient()).toBe(getObjectStoreClient());
  });
});
