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

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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

/** Post raw bytes with a caller-chosen signature, optionally to a URL variant. */
async function deliverRaw(rawBody: string, signature: string, path = '/github/webhook'): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
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

describe('#557 — every URL the router accepts gets its raw body', () => {
  // @codex on PR #1237. The raw-body capture originally tested
  // `req.path === '/github/webhook'`, which is NARROWER than the set of URLs
  // Express actually dispatches to the handler — so a correctly signed
  // delivery to one of the others captured no rawBody and was refused 400.
  // The capture is now mounted with `app.use(PATH, …)`, letting the router
  // answer the question rather than a string compare re-deriving its rules.
  //
  // Both variants below are things an operator can paste into the GitHub App's
  // webhook URL field without noticing, which is what makes this a real outage
  // rather than a curiosity.
  it.each([
    ['trailing slash — non-strict routing', '/github/webhook/'],
    ['mixed case — case-insensitive routing', '/GitHub/Webhook'],
  ])('accepts a correctly signed delivery to %s', async (_label, path) => {
    const raw = '{"zen":"routing"}';
    expect(await deliverRaw(raw, sign(raw), path)).toBe(200);
  });

  it('still REFUSES a bad signature on those variants', async () => {
    // The pair: the variants must reach the same verification, not bypass it.
    // Without this, "accepts" above would also be satisfied by a route that
    // skipped the signature check entirely.
    const raw = '{"zen":"routing"}';
    expect(await deliverRaw(raw, `sha256=${'a'.repeat(64)}`, '/github/webhook/')).toBe(401);
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

/**
 * #557 — every refusal is visible in the logs.
 *
 * Added after the operator-facing consequence became concrete: with the
 * fail-closed 503 shipping, a production deploy whose secret had not reached
 * the running process would refuse EVERY delivery and say nothing at all. The
 * only record would be GitHub's own delivery log.
 *
 * That silence already misled us once. I handed over
 * `docker logs | grep GITHUB_WEBHOOK_SECRET` as a way to confirm the running
 * process had the secret — against a build where that log line did not exist,
 * so it returned nothing whether or not the secret was set. A check that
 * cannot fail, given to an operator as evidence.
 *
 * Each case below drives a real refusal and asserts a warning was emitted, so
 * "no output" becomes meaningful rather than ambiguous.
 */
describe('#557 — refused deliveries are logged', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  // Cleared BEFORE each case, not after. The spy is installed when this
  // describe body is evaluated — during collection, before any test runs — so
  // it accumulates refusals from every earlier case in the file. Clearing
  // afterwards leaves the first case in this block counting all of them.
  beforeEach(() => {
    warn.mockClear();
    // Default OFF for the per-reason cases: the throttle is stateful across a
    // whole booted server, so a case that asserts "this reason logged" would
    // otherwise be silenced by whichever earlier case logged that reason
    // first. The two throttle cases below set their own window.
    process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS = '0';
  });
  afterAll(() => {
    delete process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS;
    warn.mockRestore();
  });

  /** The refusal lines only — other warnings on the path are not ours to assert. */
  const refusals = () =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[webhook] REFUSED'));

  it('logs a missing signature', async () => {
    const res = await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: '{"zen":"log-case"}',
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(401);
    expect(refusals(), 'one line naming the reason').toHaveLength(1);
    expect(refusals()[0]).toContain('Missing signature');
  });

  it('logs an invalid signature, and names the event', async () => {
    expect(await deliverRaw('{"zen":"log-case"}', `sha256=${'a'.repeat(64)}`)).toBe(401);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('Invalid signature');
    // The event type is what distinguishes a misconfigured push sync from
    // someone probing the endpoint.
    expect(refusals()[0]).toContain('event=push');
  });

  it('logs the fail-closed 503 when production has no secret', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ zen: 'forged' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('not configured');
  });

  it('does NOT log for an accepted delivery', async () => {
    // The control. Without it, a helper that logged unconditionally — or a
    // handler that refused everything — would satisfy all three cases above.
    expect(await deliverRaw(NON_ROUNDTRIPPING_RAW, sign(NON_ROUNDTRIPPING_RAW))).toBe(200);
    expect(refusals(), 'a successful delivery is not a refusal').toHaveLength(0);
  });

  const badSig = (c: string) => `sha256=${c.repeat(64)}`;
  const floodInvalid = async (n: number, c = 'c') => {
    for (let i = 0; i < n; i++) {
      expect(await deliverRaw('{"zen":"flood"}', badSig(c))).toBe(401);
    }
  };

  it('swallows a flood and reports how many it swallowed', async () => {
    // @copilot on PR #1236: this route is unauthenticated, so logging every
    // refusal hands an attacker an amplifier — fill the log, burn ingestion
    // budget, bury the real failure under a million copies of itself.
    //
    // The window is opened deliberately first. The throttle is stateful for
    // the life of the server, so a case that just floods asserts nothing about
    // throttling: whichever earlier case logged this reason may already have
    // opened the window, and the flood would show zero lines either way.
    await floodInvalid(1);            // opens the window, logs
    warn.mockClear();

    process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS = '60000';
    await floodInvalid(25);
    expect(refusals(), '25 refusals, no new lines').toHaveLength(0);

    // The count is what keeps the throttle honest — without it a quiet log is
    // indistinguishable from an idle server, which is the exact ambiguity this
    // logging exists to remove.
    process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS = '0';
    await floodInvalid(1);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('25 further');
    expect(refusals()[0]).toContain('suppressed');
  });

  it('keeps each reason\'s counter separate', async () => {
    // Keyed per reason on purpose. A single global counter would let an
    // attacker hammering "Invalid signature" silence the fail-closed 503 an
    // operator needs to see — reintroducing the original silence by other
    // means. It would also mis-attribute the flood's count onto whichever
    // reason happened to log next, which is what this measures.
    await floodInvalid(1);
    const missingSig = async () => {
      const res = await fetch(`${baseUrl}/github/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
        body: '{"zen":"other"}',
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(401);
    };
    await missingSig();               // opens the OTHER reason's window
    warn.mockClear();

    process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS = '60000';
    await floodInvalid(20);           // 20 suppressed, all "Invalid signature"

    process.env.WEBHOOK_REFUSAL_LOG_WINDOW_MS = '0';
    await missingSig();

    expect(refusals(), 'the other reason still gets its line').toHaveLength(1);
    expect(refusals()[0]).toContain('Missing signature');
    // The discriminator: a global counter would report the 20 here.
    expect(refusals()[0], 'another reason\'s flood is not charged to this one')
      .not.toContain('suppressed');
  });

  it('bounds and strips attacker-controlled header values', async () => {
    // Both headers are caller-supplied on an unauthenticated route. A 64KB
    // event name echoed into an aggregator is an amplifier of its own.
    const res = await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'A'.repeat(5000),
        'x-github-delivery': 'id with spaces & punctuation!',
      },
      body: '{"zen":"headers"}',
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(401);

    const line = refusals()[0];
    expect(line.length, 'the whole line stays small').toBeLessThan(400);
    expect(line).not.toContain('A'.repeat(200));
    expect(line).toContain('id?with?spaces???punctuation?');
  });

  it('never puts the payload or the signature in the log', async () => {
    // A log line is a durable artifact in someone else's aggregator. The
    // expected digest especially must not appear: printed next to a refusal,
    // it is a comparison oracle for the next attempt.
    const secretish = 'zen-marker-do-not-log';
    await deliverRaw(`{"zen":"${secretish}"}`, `sha256=${'b'.repeat(64)}`);
    const line = refusals()[0];
    expect(line).not.toContain(secretish);
    expect(line).not.toContain('b'.repeat(64));
    expect(line).not.toContain('sha256=');
  });
});
