import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { createServerOnCleanDb, closeServerIfStarted } from '../test/startServerFixture.js';
import { withinOneRateWindow, RATE_WINDOW_TEST_TIMEOUT_MS } from '../test/rateWindow.js';
import { signJwt } from './jwt.js';

// Every new mounted charge point, including the connect confirmation POST that consumes a nonce.
const routes: Array<[string, string]> = [
  ['GET', '/auth/github'], ['GET', '/auth/github/callback'],
  ['GET', '/auth/google'], ['GET', '/auth/google/callback'],
  ['GET', '/auth/apple'], ['POST', '/auth/apple/callback'],
  ['GET', '/auth/email/verify'], ['POST', '/auth/session'], ['GET', '/auth/me'],
  ['GET', '/oauth/authorize'], ['POST', '/oauth/authorize'], ['POST', '/oauth/token'],
  ...['microsoft', 'gmail', 'google-cal', 'google-drive'].flatMap(p => [
    ['POST', `/auth/${p}/start`], ['GET', `/auth/${p}`],
    ['POST', `/auth/${p}`], ['GET', `/auth/${p}/callback`],
  ] as Array<[string, string]>),
];
let server: Server | undefined;
let base: string;
let app: Awaited<ReturnType<typeof createServerOnCleanDb>>;
const request = (method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers, redirect: 'manual' });
beforeAll(async () => {
  app = await createServerOnCleanDb();
  app.set('trust proxy', ['203.0.113.0/24']);
  server = httpServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.rateLimitBucket.deleteMany();
  await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: {
    enforcementMode: 'ENFORCING', principalLimit: 30, keyLimit: 30, ipLimit: 1,
  } });
  await withinOneRateWindow(db, 'CREDENTIALS');
});
afterAll(async () => { vi.restoreAllMocks(); await closeServerIfStarted(server); });

describe('#419 auth-route admission', () => {
  it.each(routes)('%s %s refuses before its handler once the shared IP budget is spent', async (method, path) => {
    expect((await request('GET', '/auth/me')).status).toBe(401);
    const before = await db.rateLimitBucket.findMany();
    const refused = await request(method, path);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds: expect.any(Number) });
    expect(await db.rateLimitBucket.findMany()).toEqual(before);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('admits below and at the configured limit, then refuses without trusting forged XFF or ids', async () => {
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { ipLimit: 2 } });
    expect((await request('GET', '/auth/me?userId=victim', { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(401);
    expect((await request('GET', '/auth/me?userId=other', { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(401);
    expect((await request('GET', '/auth/me', { 'X-Forwarded-For': '198.51.100.3', Authorization: 'Bearer invalid' })).status).toBe(429);
    const rows = await db.rateLimitBucket.findMany();
    expect(rows).toHaveLength(1); expect(rows[0].dimension).toBe('ip'); expect(rows[0].used).toBe(2n);
    expect(JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? String(v) : v)).not.toContain('127.0.0.1');
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('shares a verified JWT principal across IPs, with no invented JWT key bucket', async () => {
    app.set('trust proxy', true);
    try {
      const user = await db.user.create({ data: { handle: 'auth-rate-419', roles: ['READER'] } });
      const token = await signJwt({ sub: user.id, roles: ['READER'] });
      await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { principalLimit: 1, ipLimit: 100 } });
      const auth = { Authorization: `Bearer ${token}` };
      expect((await request('GET', '/auth/me', { ...auth, 'X-Forwarded-For': '198.51.100.10' })).status).toBe(200);
      expect((await request('GET', '/auth/me', { ...auth, 'X-Forwarded-For': '198.51.100.11' })).status).toBe(429);
      expect(await db.rateLimitBucket.count({ where: { dimension: 'principal' } })).toBe(1);
      expect(await db.rateLimitBucket.count({ where: { dimension: 'key' } })).toBe(0);
    } finally { app.set('trust proxy', ['203.0.113.0/24']); }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('keeps LOG_ONLY counting over-limit attempts without refusing', async () => {
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { enforcementMode: 'LOG_ONLY' } });
    expect((await request('GET', '/auth/me')).status).toBe(401);
    expect((await request('GET', '/auth/me')).status).toBe(401);
    expect((await db.rateLimitBucket.findMany({ where: { dimension: 'ip' } })).map(r => r.used)).toEqual([2n]);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('fails closed on an unreadable policy even in LOG_ONLY, with fixed OAuth/REST carriers', async () => {
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { enforcementMode: 'LOG_ONLY' } });
    for (const path of ['/auth/me', '/oauth/token']) {
      vi.spyOn(db, '$transaction').mockRejectedValueOnce(Object.assign(new Error('private store detail'), { code: 'P1001' }));
      const r = await request(path === '/auth/me' ? 'GET' : 'POST', path);
      expect(r.status).toBe(429);
      const body = await r.json();
      expect(body).toMatchObject({ code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds: 900 });
      expect(JSON.stringify(body)).not.toContain('private store detail');
      vi.restoreAllMocks();
    }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('does not add a shared charge to the already limited email/code/DCR routes or discovery', async () => {
    for (const [method, path] of [['POST', '/auth/email'], ['POST', '/oauth/authorize/email'],
      ['POST', '/oauth/authorize/email/code'], ['POST', '/oauth/register'], ['GET', '/.well-known/oauth-authorization-server']]) {
      await request(method, path);
    }
    expect(await db.rateLimitBucket.count({ where: { fieldClass: 'CREDENTIALS' } })).toBe(0);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});
