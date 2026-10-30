/**
 * #2257 slice 1 — Cloudflare Turnstile bot check on the email sign-in send
 * paths (R210, cor:aut:030:01). `POST /auth/email` and
 * `POST /oauth/authorize/email` both reach `sendMagicLink`, so both carry the
 * gate. Behind `SIGNUP_TURNSTILE_ENABLED` (default off): with it off, nothing
 * changes; with it on, a request without a token Cloudflare accepts is refused
 * with a typed reason and NO mail is sent.
 *
 * `sendMagicLink` is mocked (it calls Resend). Cloudflare's siteverify endpoint
 * is replaced by a wrapper over global fetch that answers only that URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';

const sendMagicLinkMock = vi.hoisted(() => vi.fn());
vi.mock('../../auth/email.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../auth/email.js')>();
  return { ...mod, sendMagicLink: sendMagicLinkMock };
});

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const FIELD = 'cf-turnstile-response';

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch;
let siteverify: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  sendMagicLinkMock.mockReset();
  sendMagicLinkMock.mockResolvedValue(undefined);
  siteverify = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === SITEVERIFY ? siteverify(input, init) : realFetch(input, init),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

let ipN = 0;
const uniqueIp = () => `198.51.100.${(ipN++ % 250) + 1}`;
let n = 0;
const uniqueEmail = () => `bot-${Date.now()}-${n++}@example.test`;

function enable(secret: string | null = 'test-secret') {
  vi.stubEnv('SIGNUP_TURNSTILE_ENABLED', 'true');
  if (secret) vi.stubEnv('TURNSTILE_SECRET_KEY', secret);
  else vi.stubEnv('TURNSTILE_SECRET_KEY', '');
}

async function postAuthEmail(body: Record<string, unknown>, ip = uniqueIp()) {
  const res = await realFetch(`${baseUrl}/auth/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const withToken = (email: string, token?: string) => ({
  email,
  client_state: 'nonce-x',
  ...(token === undefined ? {} : { [FIELD]: token }),
});

describe('#2257 flag OFF (default) is byte-identical to main', () => {
  it('sends with no token and never calls Cloudflare', async () => {
    const r = await postAuthEmail(withToken(uniqueEmail()));
    expect(r.status).toBe(200);
    expect(sendMagicLinkMock).toHaveBeenCalledOnce();
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('any value other than exactly "true" leaves the gate off', async () => {
    vi.stubEnv('SIGNUP_TURNSTILE_ENABLED', '1');
    const r = await postAuthEmail(withToken(uniqueEmail()));
    expect(r.status).toBe(200);
    expect(siteverify).not.toHaveBeenCalled();
  });
});

describe('#2257 flag ON — POST /auth/email', () => {
  it('no token: refused 403 bot_check_failed/missing_token, no Cloudflare call, no send', async () => {
    enable();
    const r = await postAuthEmail(withToken(uniqueEmail()));
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'bot_check_failed', reason: 'missing_token' });
    expect(siteverify).not.toHaveBeenCalled();
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('valid token: sends, and Cloudflare receives only secret, response and remoteip (no address)', async () => {
    enable('s3cret');
    const email = uniqueEmail();
    const ip = uniqueIp();
    const r = await postAuthEmail(withToken(email, 'good-token'), ip);
    expect(r.status).toBe(200);
    expect(sendMagicLinkMock).toHaveBeenCalledOnce();
    expect(siteverify).toHaveBeenCalledOnce();
    const sent = new URLSearchParams(String((siteverify.mock.calls[0][1] as RequestInit).body));
    expect([...sent.keys()].sort()).toEqual(['remoteip', 'response', 'secret']);
    expect(sent.get('secret')).toBe('s3cret');
    expect(sent.get('response')).toBe('good-token');
    expect(sent.get('remoteip')).toBe(ip);
  });

  it('Cloudflare says success:false: refused 403 invalid_token, no send', async () => {
    enable();
    siteverify.mockResolvedValue(new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }));
    const r = await postAuthEmail(withToken(uniqueEmail(), 'bad'));
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'bot_check_failed', reason: 'invalid_token' });
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it.each([
    ['network error', () => Promise.reject(new Error('boom'))],
    ['HTTP 500', () => Promise.resolve(new Response('x', { status: 500 }))],
    ['non-JSON body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['JSON without a boolean success', () => Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))],
  ])('provider failure (%s): refused 503 provider_error, never fail-open', async (_n, impl) => {
    enable();
    siteverify.mockImplementation(impl);
    const r = await postAuthEmail(withToken(uniqueEmail(), 'any'));
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'bot_check_failed', reason: 'provider_error' });
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('secret unset: refused 503 not_configured without calling Cloudflare', async () => {
    enable(null);
    const r = await postAuthEmail(withToken(uniqueEmail(), 'any'));
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'bot_check_failed', reason: 'not_configured' });
    expect(siteverify).not.toHaveBeenCalled();
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('an invalid request stays 400 and does not burn a token on Cloudflare', async () => {
    enable();
    const r = await postAuthEmail({ email: uniqueEmail(), [FIELD]: 't' }); // no client_state
    expect(r.status).toBe(400);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('refused requests do not spend the victim\'s recipient budget', async () => {
    enable();
    const victim = uniqueEmail();
    for (let i = 0; i < 7; i++) {
      expect((await postAuthEmail(withToken(victim))).status).toBe(403);
    }
    const ok = await postAuthEmail(withToken(victim, 'good-token'));
    expect(ok.status).toBe(200);
  });
});

describe('#2257 flag ON — POST /oauth/authorize/email', () => {
  const REDIRECT = 'com.hadronmemory.ios://oauth/callback';
  let clientId: string;

  beforeEach(async () => {
    await cleanDb(db);
    clientId = `dcr_${'f'.repeat(32)}`;
    await db.oAuthClient.create({ data: { clientId, clientName: 'Hadron iOS', redirectUris: [REDIRECT] } });
  });

  async function entry() {
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
      resource: 'https://hadron.example/mcp', state: 's', login_provider: 'email',
    });
    const res = await realFetch(`${baseUrl}/oauth/authorize?${q}`, { redirect: 'manual' });
    const html = await res.text();
    const csrf = html.match(/name="_csrf"\s+value="([^"]+)"/)![1];
    const cookie = res.headers.get('set-cookie')!.match(/_hadron_csrf=([^;]+)/)![1];
    const returnTo = html.match(/name="return_to"\s+value="([^"]+)"/)![1].replace(/&amp;/g, '&');
    return { csrf, cookie, returnTo };
  }

  async function post(token?: string) {
    const { csrf, cookie, returnTo } = await entry();
    const res = await realFetch(`${baseUrl}/oauth/authorize/email`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `_hadron_csrf=${cookie}`,
        'x-forwarded-for': uniqueIp(),
      },
      body: new URLSearchParams({
        _csrf: csrf, return_to: returnTo, email: uniqueEmail(),
        ...(token === undefined ? {} : { [FIELD]: token }),
      }).toString(),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  }

  it('flag off: sends with no token', async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(sendMagicLinkMock).toHaveBeenCalledOnce();
  });

  it('no token: refused 403, no send', async () => {
    enable();
    const r = await post();
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'bot_check_failed', reason: 'missing_token' });
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('valid token: sends', async () => {
    enable();
    const r = await post('good-token');
    expect(r.status).toBe(200);
    expect(sendMagicLinkMock).toHaveBeenCalledOnce();
    expect(siteverify).toHaveBeenCalledOnce();
  });
});
