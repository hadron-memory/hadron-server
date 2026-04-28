// Unit tests for R2 client config wiring. The actual presign / S3 calls are
// covered by integration tests against MinIO; here we verify env-handling
// and the not-configured failure modes only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetR2Client, getR2Client, getR2Bucket } from './client.js';

const ENV_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT_OVERRIDE',
];

describe('R2 client', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetR2Client();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetR2Client();
  });

  it('throws R2_NOT_CONFIGURED without credentials', () => {
    expect(() => getR2Client()).toThrow(/R2_NOT_CONFIGURED/);
  });

  it('throws R2_NOT_CONFIGURED without bucket', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ACCOUNT_ID = 'acct';
    expect(() => getR2Bucket()).toThrow(/R2_NOT_CONFIGURED/);
  });

  it('builds a client when account id provides the endpoint', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ACCOUNT_ID = 'acct';
    expect(getR2Client()).toBeDefined();
  });

  it('builds a client when R2_ENDPOINT_OVERRIDE is set (MinIO)', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ENDPOINT_OVERRIDE = 'http://localhost:9000';
    expect(getR2Client()).toBeDefined();
  });

  it('caches the client across calls', () => {
    process.env.R2_ACCESS_KEY_ID = 'k';
    process.env.R2_SECRET_ACCESS_KEY = 's';
    process.env.R2_ENDPOINT_OVERRIDE = 'http://localhost:9000';
    expect(getR2Client()).toBe(getR2Client());
  });
});
