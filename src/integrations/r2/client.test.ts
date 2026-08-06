// Unit tests for object-store client config wiring. The actual presign /
// S3 calls are covered by integration tests against MinIO; here we verify
// env-handling and the not-configured failure modes only.
//
// ASSET_STORAGE_* is the only spelling read. The earlier OBJECT_STORAGE_*
// and R2_* names were dropped outright rather than kept as fallbacks, so
// these tests also pin that they are genuinely ignored — a lingering
// fallback would let a stale env silently configure the client.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetObjectStoreClient, getObjectStoreClient, getObjectStoreBucket } from './client.js';

const ENV_KEYS = [
  'ASSET_STORAGE_ENDPOINT',
  'ASSET_STORAGE_REGION',
  'ASSET_STORAGE_BUCKET',
  'ASSET_STORAGE_ACCESS_KEY_ID',
  'ASSET_STORAGE_SECRET_ACCESS_KEY',
  'ASSET_STORAGE_FORCE_PATH_STYLE',
  // Retired spellings — set in some tests purely to prove they do nothing.
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT_OVERRIDE',
];

/** Minimum config for a usable client. */
function configureCredentials() {
  process.env.ASSET_STORAGE_ACCESS_KEY_ID = 'k';
  process.env.ASSET_STORAGE_SECRET_ACCESS_KEY = 's';
}

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

  // ── Not-configured failure modes ──

  it('throws ASSET_STORAGE_NOT_CONFIGURED without credentials', () => {
    expect(() => getObjectStoreClient()).toThrow(/ASSET_STORAGE_NOT_CONFIGURED/);
  });

  it('throws ASSET_STORAGE_NOT_CONFIGURED without an endpoint', () => {
    configureCredentials();
    expect(() => getObjectStoreClient()).toThrow(/ASSET_STORAGE_NOT_CONFIGURED/);
  });

  it('throws ASSET_STORAGE_NOT_CONFIGURED without a bucket', () => {
    expect(() => getObjectStoreBucket()).toThrow(/ASSET_STORAGE_NOT_CONFIGURED/);
  });

  it('names the missing knob in the error', () => {
    // The failure is a config mistake a human has to fix, so the message
    // has to say which variable is absent.
    configureCredentials();
    expect(() => getObjectStoreClient()).toThrow(/ASSET_STORAGE_ENDPOINT/);
  });

  // ── Hetzner (the configured provider) ──

  it('builds a client against a Hetzner endpoint', () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    process.env.ASSET_STORAGE_REGION = 'nbg1';
    expect(getObjectStoreClient()).toBeDefined();
  });

  it('uses path-style addressing by default', () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    expect(getObjectStoreClient().config.forcePathStyle).toBe(true);
  });

  it('honors ASSET_STORAGE_REGION (Hetzner signs against a real region)', async () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    process.env.ASSET_STORAGE_REGION = 'nbg1';
    expect(await getObjectStoreClient().config.region()).toBe('nbg1');
  });

  it("defaults region to R2's pseudo-region when unset", async () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'http://localhost:9000';
    expect(await getObjectStoreClient().config.region()).toBe('auto');
  });

  it('reads the bucket from ASSET_STORAGE_BUCKET', () => {
    process.env.ASSET_STORAGE_BUCKET = 'hadron-assets';
    expect(getObjectStoreBucket()).toBe('hadron-assets');
  });

  // ── R2 opt-out ──

  it('allows virtual-hosted style via ASSET_STORAGE_FORCE_PATH_STYLE=false', () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
    process.env.ASSET_STORAGE_FORCE_PATH_STYLE = 'false';
    expect(getObjectStoreClient().config.forcePathStyle).toBe(false);
  });

  it('treats any value other than "false" as path-style', () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'http://localhost:9000';
    process.env.ASSET_STORAGE_FORCE_PATH_STYLE = 'true';
    expect(getObjectStoreClient().config.forcePathStyle).toBe(true);
  });

  // ── Retired spellings are genuinely dead ──

  it('ignores OBJECT_STORAGE_* entirely', () => {
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = 'k';
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = 's';
    process.env.OBJECT_STORAGE_ENDPOINT = 'https://nbg1.your-objectstorage.com';
    expect(() => getObjectStoreClient()).toThrow(/ASSET_STORAGE_NOT_CONFIGURED/);
  });

  it('ignores R2_* entirely', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ACCOUNT_ID = 'acct';
    process.env.R2_ENDPOINT_OVERRIDE = 'http://localhost:9000';
    expect(() => getObjectStoreClient()).toThrow(/ASSET_STORAGE_NOT_CONFIGURED/);
  });

  it('ignores OBJECT_STORAGE_BUCKET and R2_BUCKET_NAME', () => {
    process.env.OBJECT_STORAGE_BUCKET = 'stale-bucket';
    process.env.R2_BUCKET_NAME = 'older-bucket';
    expect(() => getObjectStoreBucket()).toThrow(/ASSET_STORAGE_NOT_CONFIGURED/);
  });

  it('caches the client across calls', () => {
    configureCredentials();
    process.env.ASSET_STORAGE_ENDPOINT = 'http://localhost:9000';
    expect(getObjectStoreClient()).toBe(getObjectStoreClient());
  });
});
