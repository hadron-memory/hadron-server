/**
 * #557 — the webhook HMACs the bytes GitHub signed, and production fails closed.
 *
 * Two defects, one handler:
 *
 * 1. **Optional.** Verification ran only `if (secret)`. With
 *    `GITHUB_WEBHOOK_SECRET` unset the route processed forged deliveries
 *    unauthenticated — an `installation` event relinks a GitHub App
 *    installation (`organization.updateMany`) and a `push` event triggers
 *    `syncGraphFromGithub`.
 *
 * 2. **Wrong bytes.** The HMAC was computed over `JSON.stringify(req.body)` —
 *    the RE-SERIALIZED parsed body, not the bytes GitHub actually signed.
 *
 * The issue says verification therefore "effectively always fails". Measured,
 * it is worse than that: it depends on payload CONTENT. Plain compact ASCII
 * round-trips fine, while `\/` escapes are dropped, integer-like keys reorder
 * to the front, integers past 2^53 lose precision, and `1.0` becomes `1`. An
 * intermittent signature failure reads as a flaky webhook rather than as a bug,
 * which is exactly the pressure toward unsetting the secret and falling into
 * defect 1.
 *
 * The first two cases below are a DISCRIMINATING PAIR on one payload chosen
 * because it does not round-trip. Signing the raw bytes must be accepted;
 * signing the re-serialized form must be refused. Under the old code both
 * verdicts are exactly inverted, so the pair cannot be satisfied by either
 * implementation accidentally — and neither case alone would do that, since a
 * handler that accepted everything would pass the first and a handler that
 * refused everything would pass the second.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { createServer } from '../../server.js';

const SECRET = 'test-secret-for-557';

let server: Server;
let baseUrl: string;
let priorSecret: string | undefined;
let priorNodeEnv: string | undefined;

beforeAll(async () => {
  priorSecret = process.env.GITHUB_WEBHOOK_SECRET;
  priorNodeEnv = process.env.NODE_ENV;
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

// Both the secret and NODE_ENV are read PER REQUEST inside the handler, so one
// booted server covers every case here. That matters for the production cases
// specifically: booting with NODE_ENV=production would drag in the
// `initCloudflareIps()` network fetch, which has nothing to do with #557.
afterEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;
});

afterAll(async () => {
  if (priorSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = priorSecret;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A payload whose raw bytes and re-serialized form DIFFER. `\/` is a legal JSON
 * escape that `JSON.stringify` does not re-emit, so these two strings parse to
 * the same object and hash to different digests. GitHub really does send
 * escaped URLs in webhook payloads, which is what makes this the realistic
 * shape rather than a contrived one.
 */
const NON_ROUNDTRIPPING_RAW = String.raw`{"zen":"x","url":"https:\/\/github.com\/hadron-memory"}`;

/** Post raw bytes with a caller-chosen signature. */
async function deliverRaw(rawBody: string, signature: string): Promise<number> {
  const res = await fetch(`${baseUrl}/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-hub-signature-256': signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

const sign = (payload: string) =>
  `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;

describe('#557 — the HMAC covers the bytes GitHub signed', () => {
  it('ACCEPTS a delivery signed over the RAW bytes', async () => {
    // Pre-fix this is a 401: the server hashed the re-serialized form, which
    // differs from what the sender signed.
    expect(await deliverRaw(NON_ROUNDTRIPPING_RAW, sign(NON_ROUNDTRIPPING_RAW))).toBe(200);
  });

  it('REFUSES a delivery signed over the RE-SERIALIZED body', async () => {
    // The other half of the pair, and the one that pins the fix rather than
    // merely tolerating it: this is precisely what the old code computed, so a
    // regression back to `JSON.stringify(req.body)` turns this 401 into a 200.
    const reSerialized = JSON.stringify(JSON.parse(NON_ROUNDTRIPPING_RAW));
    expect(reSerialized).not.toBe(NON_ROUNDTRIPPING_RAW); // the premise, asserted
    expect(await deliverRaw(NON_ROUNDTRIPPING_RAW, sign(reSerialized))).toBe(401);
  });

  it('still accepts a plain-ASCII payload, which round-trips either way', async () => {
    // The benign shape. It passed before the fix too — included so the pair
    // above is not mistaken for "raw-vs-parsed changes every verdict".
    const raw = '{"zen":"hello","id":5}';
    expect(JSON.stringify(JSON.parse(raw))).toBe(raw);
    expect(await deliverRaw(raw, sign(raw))).toBe(200);
  });
});

describe('#557 — an unconfigured secret fails closed in production', () => {
  it('refuses with 503 when the secret is unset and NODE_ENV=production', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    // No signature header at all — the forged-delivery shape. Pre-fix this was
    // a 200 that reached organization.updateMany / syncGraphFromGithub.
    const res = await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ zen: 'forged' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(503);
  });

  it('still processes an unsigned delivery OUTSIDE production', async () => {
    // The deliberate escape hatch, asserted so that "fails closed" cannot
    // quietly become "fails closed everywhere" and break local development —
    // and so the 503 above is attributable to NODE_ENV rather than to the
    // missing secret alone.
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'development';
    const res = await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ zen: 'local' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(200);
  });

  it('a CONFIGURED secret still refuses an unsigned delivery in production', async () => {
    // Guards the branch structure: the 503 path must not swallow the 401 path.
    process.env.NODE_ENV = 'production';
    const res = await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ zen: 'unsigned' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(401);
  });
});
