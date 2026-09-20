/**
 * #555 — a malformed `x-hub-signature-256` must be refused, not fatal.
 *
 * The defect: `/github/webhook` compared the attacker-supplied header against
 * the expected digest with a bare `crypto.timingSafeEqual`, which throws
 * `RangeError: Input buffers must have the same byte length` whenever the two
 * differ in length. `expected` is always 71 bytes (`sha256=` + 64 hex), so ANY
 * other length threw. The handler is `async`, Express 4 does not forward async
 * rejections to error middleware, and this repo registers no
 * `unhandledRejection` / `uncaughtException` handler — so the throw reached
 * Node's default policy and TERMINATED THE PROCESS.
 *
 * Measured at `94a82da` before the fix, booting the real app: a control request
 * carrying a well-formed-but-wrong 71-byte signature answered `401` and left
 * the process alive, and a 1-byte signature exited the process with code 1 and
 * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`. One unauthenticated `curl`, repeatable.
 *
 * This is a WIRE test rather than a unit test of the comparison, and the
 * distinction is load-bearing here rather than stylistic: `safeEqual` in
 * isolation has always returned `false` for a length mismatch, so a unit test
 * of it passes just as happily against the broken server. What was broken was
 * the CALL SITE, and only a request can see that.
 *
 * The first case below is the regression. The rest exist because a length guard
 * is the kind of fix that can be written one spelling too narrow — a
 * `sig.length !== 71` check would pass the regression case and still throw on a
 * multi-byte header, since `Buffer.from` counts BYTES and `String.length`
 * counts UTF-16 units.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { createServer } from '../../server.js';

const SECRET = 'test-secret-for-555';

let server: Server;
let baseUrl: string;
let priorSecret: string | undefined;

beforeAll(async () => {
  priorSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (priorSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = priorSecret;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const BODY = { zen: 'Non-blocking is better than blocking.' };

/**
 * Fire one webhook delivery. Returns the status, or throws if no response
 * arrives — which is itself the pre-fix symptom: the handler died mid-request
 * and the socket was left hanging with nothing ever written to it.
 */
async function deliver(signature: string | undefined): Promise<number> {
  const res = await fetch(`${baseUrl}/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    body: JSON.stringify(BODY),
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

/** The signature GitHub would send for BODY under SECRET, as the handler computes it. */
function validSignature(): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(JSON.stringify(BODY)).digest('hex')}`;
}

describe('#555 — malformed webhook signature is refused, not fatal', () => {
  it('refuses a 1-byte signature with 401 instead of crashing the process', async () => {
    // The issue's literal reproduction: `curl -H 'x-hub-signature-256: x'`.
    expect(await deliver('x')).toBe(401);
  });

  it.each([
    ['empty string', ''],
    ['shorter than expected', 'sha256=abc'],
    ['longer than expected', `sha256=${'a'.repeat(200)}`],
    ['right length, no sha256= prefix', 'b'.repeat(71)],
    // Byte length 71 would be WRONG for this one while String.length is 71:
    // each 'é' is two bytes in UTF-8. A guard written against `sig.length`
    // rather than the byte length lets this through to `timingSafeEqual`.
    ['71 UTF-16 units but 72 bytes', `sha256=é${'a'.repeat(63)}`],
  ])('refuses a %s signature with 401', async (_label, sig) => {
    expect(await deliver(sig)).toBe(401);
  });

  it('still refuses a well-formed but WRONG signature (the control)', async () => {
    // This one never threw, before or after. It is here so that a future
    // "fix" which accepts everything cannot pass this file: the length guard
    // must not become the only thing standing between a forged delivery and
    // `db.organization.updateMany`.
    expect(await deliver(`sha256=${'a'.repeat(64)}`)).toBe(401);
  });

  it('still refuses a missing signature with 401', async () => {
    expect(await deliver(undefined)).toBe(401);
  });

  it('ACCEPTS a correctly signed delivery — the guard refuses length, not everything', async () => {
    // The assertion that makes every 401 above a measurement rather than a
    // constant. Without it, a handler that answered 401 unconditionally would
    // satisfy this entire file.
    expect(await deliver(validSignature())).toBe(200);
  });
});
