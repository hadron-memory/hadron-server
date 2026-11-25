/**
 * #4675 (cor:api:260:03): a rate refusal shown to a browser navigation is a short page; every other caller gets
 * the JSON of cor:api:260:02. Driven over HTTP on the real server with the real limiter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { createServerOnCleanDb, closeServerIfStarted } from '../test/startServerFixture.js';
import { withinOneRateWindow, RATE_WINDOW_TEST_TIMEOUT_MS } from '../test/rateWindow.js';

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
/** The ruled navigation routes: sign-in start and callback, verification link, authorize page. */
const PAGE_ROUTES: Array<[string, string]> = [
  ['GET', '/auth/github'], ['GET', '/auth/github/callback'],
  ['GET', '/auth/google'], ['GET', '/auth/google/callback'],
  ['GET', '/auth/apple'], ['POST', '/auth/apple/callback'],
  ['GET', '/auth/email/verify'], ['GET', '/oauth/authorize'],
];
/** Every other guarded route: never a page, whatever the Accept header says. */
const JSON_ROUTES: Array<[string, string]> = [
  ['POST', '/oauth/token'], ['POST', '/oauth/authorize'], ['POST', '/auth/session'], ['GET', '/auth/me'],
  ...['microsoft', 'gmail', 'google-cal', 'google-drive'].flatMap(p => [
    ['POST', `/auth/${p}/start`], ['GET', `/auth/${p}`], ['POST', `/auth/${p}`], ['GET', `/auth/${p}/callback`],
  ] as Array<[string, string]>),
];

let server: Server | undefined;
let base: string;
/** Accept is set explicitly: fetch's own default is the wildcard. */
const request = (method: string, path: string, accept: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { Accept: accept, ...headers }, redirect: 'manual' });
const setPolicy = (data: Record<string, unknown>) => db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data });
const spend = async () => { await (await request('GET', '/auth/me', '*/*')).arrayBuffer(); };
const expectRefusalHeaders = (r: Response) => {
  expect(r.status).toBe(429);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
  return Number(r.headers.get('retry-after'));
};
const expectJson = async (r: Response, protocol: 'rest' | 'oauth') => {
  const n = expectRefusalHeaders(r);
  expect(r.headers.get('content-type')).toMatch(/^application\/json/);
  expect(await r.json()).toEqual({
    error: protocol === 'oauth' ? 'temporarily_unavailable' : 'RATE_LIMITED',
    ...(protocol === 'oauth' ? { error_description: 'Too many requests.' } : {}),
    code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds: n,
  });
};
const visibleText = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

beforeAll(async () => {
  server = httpServer(await createServerOnCleanDb());
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await db.rateLimitBucket.deleteMany();
  await setPolicy({ enforcementMode: 'ENFORCING', principalLimit: 30, keyLimit: 30, ipLimit: 1 });
  await withinOneRateWindow(db, 'CREDENTIALS');
  await spend();
});
afterAll(async () => { vi.restoreAllMocks(); await closeServerIfStarted(server); });

describe('#4675 the page', () => {
  it.each(PAGE_ROUTES)('%s %s answers a browser navigation with the page, same status and headers', async (method, path) => {
    const r = await request(method, path, BROWSER);
    const n = expectRefusalHeaders(r);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // The whole visible text: too many requests and the wait, and nothing else.
    expect(visibleText(await r.text())).toBe(`Too many requests Too many requests Please wait ${n} second${n === 1 ? '' : 's'} before you try again.`);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('S4: nothing from the request, the limiter or the provider appears in the page', async () => {
    const r = await request('GET', '/auth/github/callback?code=secret-code-4675&state=secret-state-4675&provider=secret-provider-4675',
      BROWSER, { Cookie: 'hadron_token=secret-cookie-4675', Authorization: 'Bearer secret-bearer-4675', 'User-Agent': 'secret-agent-4675' });
    expectRefusalHeaders(r);
    const html = await r.text();
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/secret-|CREDENTIALS|RATE_LIMITED|github|127\.0\.0\.1|principal|ipLimit/i);
    expect(html).not.toMatch(/<(script|a|form|img|link|iframe)\b/i);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('the page can load, submit or leak nothing: CSP, nosniff and no-referrer', async () => {
    const r = await request('GET', '/auth/email/verify?token=secret-4675', BROWSER);
    expectRefusalHeaders(r);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    await r.arrayBuffer();
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});

describe('#4675 negotiation', () => {
  it.each([
    ['text/html'], [BROWSER], ['TEXT/HTML'], ['text/html, application/json'], ['text/html, application/json;q=0.9'],
    ['application/json;q=0.5, text/html;q=0.6'],
  ])('Accept %s gets the page', async (accept) => {
    for (const path of ['/auth/github', '/oauth/authorize']) {
      const r = await request('GET', path, accept);
      expectRefusalHeaders(r);
      expect(r.headers.get('content-type'), path).toMatch(/^text\/html/);
      await r.arrayBuffer();
    }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it.each([
    [''], ['*/*'], ['text/*'], ['application/json'], ['application/json, text/plain, */*'], ['application/xhtml+xml'], ['text/plain'],
    ['application/json, text/html'], ['application/json, text/html;q=0.9'], ['text/html;q=0.5, */*'], ['text/html;q=0'],
    ['text/html;q=0, */*'], ['text/htmlx'], ['not a media type'],
  ])('Accept "%s" gets the JSON', async (accept) => {
    await expectJson(await request('GET', '/auth/github', accept), 'rest');
    await expectJson(await request('GET', '/oauth/authorize', accept), 'oauth');
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('no Accept header at all gets the JSON', async () => {
    const { request: raw } = await import('node:http');
    for (const path of ['/auth/github', '/oauth/authorize']) {
      const { type, body } = await new Promise<{ type?: string; body: string }>((resolve, reject) => {
        raw(base + path, res => {
          expect(res.statusCode).toBe(429);
          let body = '';
          res.on('data', chunk => { body += chunk; }).on('end', () => resolve({ type: res.headers['content-type'], body }));
        }).on('error', reject).end();
      });
      expect(type, path).toMatch(/^application\/json/);
      expect(JSON.parse(body)).toMatchObject({ code: 'RATE_LIMITED' });
    }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it.each(JSON_ROUTES)('%s %s never answers with a page', async (method, path) => {
    await expectJson(await request(method, path, BROWSER), path.startsWith('/oauth/') ? 'oauth' : 'rest');
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});
