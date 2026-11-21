import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { createServerOnCleanDb, closeServerIfStarted } from '../test/startServerFixture.js';
import { withinOneRateWindow, RATE_WINDOW_TEST_TIMEOUT_MS } from '../test/rateWindow.js';
import { signJwt } from './jwt.js';
import { issueLoginCode } from './authHandoff.js';

// Every new mounted charge point, including the connect confirmation POST that consumes a nonce.
type RefusalStyle = 'rest' | 'oauth';
const routes: Array<[string, string, RefusalStyle]> = [
  ['GET', '/auth/github', 'rest'], ['GET', '/auth/github/callback', 'rest'],
  ['GET', '/auth/google', 'rest'], ['GET', '/auth/google/callback', 'rest'],
  ['GET', '/auth/apple', 'rest'], ['POST', '/auth/apple/callback', 'rest'],
  ['GET', '/auth/email/verify', 'rest'], ['POST', '/auth/session', 'rest'], ['GET', '/auth/me', 'rest'],
  ['GET', '/oauth/authorize', 'oauth'], ['POST', '/oauth/authorize', 'oauth'], ['POST', '/oauth/token', 'oauth'],
  ...['microsoft', 'gmail', 'google-cal', 'google-drive'].flatMap(p => [
    ['POST', `/auth/${p}/start`, 'rest'], ['GET', `/auth/${p}`, 'rest'],
    ['POST', `/auth/${p}`, 'rest'], ['GET', `/auth/${p}/callback`, 'rest'],
  ] as Array<[string, string, RefusalStyle]>),
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
  it.each(routes)('%s %s refuses before its handler once the shared IP budget is spent', async (method, path, style) => {
    expect((await request('GET', '/auth/me')).status).toBe(401);
    const before = await db.rateLimitBucket.findMany();
    const refused = await request(method, path);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    const body = await refused.json();
    expect(body).toMatchObject({ code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS', retryAfterSeconds: expect.any(Number),
      error: style === 'oauth' ? 'temporarily_unavailable' : 'RATE_LIMITED' });
    if (style === 'oauth') expect(body).toHaveProperty('error_description', 'Too many requests.');
    else expect(body).not.toHaveProperty('error_description');
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

  it('OAuth consent charges its verified cookie even when an unrelated invalid Bearer header is supplied', async () => {
    app.set('trust proxy', true);
    try {
      const user = await db.user.create({ data: { handle: 'auth-rate-cookie-419', roles: ['READER'] } });
      const token = await signJwt({ sub: user.id, roles: ['READER'] });
      await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { principalLimit: 1, ipLimit: 100 } });
      const headers = { Cookie: `hadron_token=${token}`, Authorization: 'Bearer unrelated-invalid' };
      expect((await request('GET', '/oauth/authorize', { ...headers, 'X-Forwarded-For': '198.51.100.20' })).status).not.toBe(429);
      expect((await request('GET', '/oauth/authorize', { ...headers, 'X-Forwarded-For': '198.51.100.21' })).status).toBe(429);
      expect(await db.rateLimitBucket.count({ where: { dimension: 'principal' } })).toBe(1);
    } finally { app.set('trust proxy', ['203.0.113.0/24']); }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('an impersonation JWT does not charge the target principal', async () => {
    const target = await db.user.create({ data: { handle: 'auth-rate-imp-target-419', roles: ['READER'] } });
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { principalLimit: 1, ipLimit: 100 } });
    const token = await signJwt({ sub: target.id, roles: [],
      imp: { sid: 'support-claim-419', act: 'support-actor', org: 'support-org' } });
    const response = await request('GET', '/auth/me', { Authorization: `Bearer ${token}` });
    // The exact handler refusal proves verification succeeded and reached its imp branch;
    // this route rejects every signed imp claim without looking up the support session.
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Impersonation tokens are not accepted here' });
    const rows = await db.rateLimitBucket.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dimension: 'ip', used: 1n });
    // Same sub and roles without imp: it is authenticated and spends this target's
    // one principal allowance, so a second ordinary request must be throttled.
    const ordinary = await signJwt({ sub: target.id, roles: [] });
    const auth = { Authorization: `Bearer ${ordinary}` };
    const admitted = await request('GET', '/auth/me', auth);
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({ id: target.id });
    expect(await db.rateLimitBucket.count({ where: { dimension: 'principal' } })).toBe(1);
    expect((await request('GET', '/auth/me', auth)).status).toBe(429);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('a spent Apple callback budget refuses before oversized form parsing', async () => {
    // beforeEach installs a one-request IP budget. Spend it before the form.
    expect((await request('GET', '/auth/me')).status).toBe(401);
    const before = await db.rateLimitBucket.findMany();
    const post = () => fetch(base + '/auth/apple/callback', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=' + 'x'.repeat(110 * 1024) });
    const response = await post();
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: 'RATE_LIMITED', code: 'RATE_LIMITED' });
    expect(await db.rateLimitBucket.findMany()).toEqual(before);
    // The same bytes exceed the actual mounted parser's limit when admitted;
    // changing that limit cannot silently make the ordering test vacuous.
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { ipLimit: 100 } });
    expect((await post()).status).toBe(413);
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

  it('forged, expired and deleted-account JWTs cannot spend a claimed principal budget', async () => {
    const user = await db.user.create({ data: { handle: 'auth-rate-invalid-419', roles: ['READER'] } });
    const valid = await signJwt({ sub: user.id, roles: ['READER'] });
    const forged = valid.slice(0, valid.lastIndexOf('.') + 1) + 'A'.repeat(43);
    const expired = await signJwt({ sub: user.id, roles: ['READER'] }, { expiresIn: -1 });
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { ipLimit: 100 } });
    for (const token of [forged, expired]) {
      expect((await request('GET', '/auth/me', { Authorization: `Bearer ${token}` })).status).not.toBe(200);
    }
    expect(await db.rateLimitBucket.count({ where: { dimension: 'principal' } })).toBe(0);
    await db.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    expect((await request('GET', '/auth/me', { Authorization: `Bearer ${valid}` })).status).not.toBe(200);
    expect(await db.rateLimitBucket.count({ where: { dimension: 'principal' } })).toBe(0);
    expect((await db.rateLimitBucket.findMany({ where: { dimension: 'ip' } })).map(r => r.used)).toEqual([3n]);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('unexpected identity/read faults are not swallowed as invalid credentials', async () => {
    const user = await db.user.create({ data: { handle: 'auth-rate-fault-419', roles: ['READER'] } });
    const token = await signJwt({ sub: user.id, roles: ['READER'] });
    vi.spyOn(db.user, 'findFirst').mockRejectedValueOnce(new Error('private identity detail'));
    const r = await request('GET', '/auth/me', { Authorization: `Bearer ${token}` });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('private identity detail');
    expect(await db.rateLimitBucket.count()).toBe(0);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('a refused handoff leaves one-use evidence intact, then an admitted retry redeems once', async () => {
    const user = await db.user.create({ data: { handle: 'auth-rate-handoff-419', roles: ['READER'] } });
    const code = await issueLoginCode({ userId: user.id, redirect: '/app', isNew: false, clientState: 'browser419' });
    await request('GET', '/auth/me');
    const before = await db.authHandoffCode.findMany({ where: { userId: user.id } });
    const post = () => fetch(base + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, clientState: 'browser419' }) });
    expect((await post()).status).toBe(429);
    expect(await db.authHandoffCode.findMany({ where: { userId: user.id } })).toEqual(before);
    await db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data: { ipLimit: 100 } });
    const accepted = await post(); expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ token: expect.any(String), redirect: '/app' });
    expect((await post()).status).toBe(400);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('concurrent routes share one atomic remaining allowance and IPv6 /56 cannot split it', async () => {
    app.set('trust proxy', true);
    try {
      const replies = await Promise.all([
        request('GET', '/auth/me', { 'X-Forwarded-For': '2001:db8:abcd:1200::1' }),
        request('POST', '/auth/session', { 'X-Forwarded-For': '2001:db8:abcd:12ff::2' }),
      ]);
      expect(replies.map(r => r.status).sort()).toEqual(expect.arrayContaining([429]));
      expect(replies.filter(r => r.status !== 429)).toHaveLength(1);
      expect((await db.rateLimitBucket.findMany({ where: { dimension: 'ip' } })).map(r => r.used)).toEqual([1n]);
    } finally { app.set('trust proxy', ['203.0.113.0/24']); }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('different unrecognized handoff inputs have the same throttled refusal, without echoing evidence', async () => {
    await request('GET', '/auth/me');
    const bodies = [];
    for (const code of ['unknown-evidence', 'expired-evidence', 'foreign-evidence']) {
      const r = await fetch(base + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      expect(r.status).toBe(429);
      const b = await r.json() as Record<string, unknown>; expect(JSON.stringify(b)).not.toContain(code);
      bodies.push({ ...b, retryAfterSeconds: 0 });
    }
    expect(bodies[1]).toEqual(bodies[0]); expect(bodies[2]).toEqual(bodies[0]);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('does not add a shared charge to the already limited email/code/DCR routes or discovery', async () => {
    for (const [method, path] of [['POST', '/auth/email'], ['POST', '/oauth/authorize/email'],
      ['POST', '/oauth/authorize/email/code'], ['POST', '/oauth/register'], ['GET', '/.well-known/oauth-authorization-server']]) {
      await request(method, path);
    }
    expect(await db.rateLimitBucket.count({ where: { fieldClass: 'CREDENTIALS' } })).toBe(0);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});
