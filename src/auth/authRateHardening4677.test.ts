/**
 * #4677 (refs #419, #4659): regression coverage and hardening pins for the shared CREDENTIALS admission.
 *
 * What the refusal-body pins here pin is #4659's ENGINEERING shape (status, headers and the REST / OAuth
 * body fields), not a minted spec; when the corpus rule for the shared admission refusal lands these pins
 * follow the rule, not the reverse. No policy class, threshold or rollout is touched by this file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { db } from '../integrations/db/client.js';
import { createServerOnCleanDb, closeServerIfStarted } from '../test/startServerFixture.js';
import { withinOneRateWindow, RATE_WINDOW_TEST_TIMEOUT_MS } from '../test/rateWindow.js';
import { readRateKeys } from '../lib/rateLimit/config.js';
import { signJwt } from './jwt.js';
import { createSignIn } from './signIn.js';
import { AUTH_COOKIE_NAME } from './cookieName.js';
import { AUTH_RATE_ADMISSION_PREFIX, authRateAdmissionName, type CredentialSource, type RefusalForm, type RefusalProtocol } from './authRate.js';
import { connectInterstitialToken, peekExchangeStartNonce } from './authHandoff.js';

type Inventory = Array<[method: string, path: string, protocol: RefusalProtocol, credential: CredentialSource, form: RefusalForm]>;
/** The audited list of every route that carries the shared charge, and with which choices (#4677 item 16). */
const GUARDED: Inventory = [
  ['GET', '/auth/github', 'rest', 'none', 'page'], ['GET', '/auth/github/callback', 'rest', 'none', 'page'],
  ['GET', '/auth/google', 'rest', 'none', 'page'], ['GET', '/auth/google/callback', 'rest', 'none', 'page'],
  ['GET', '/auth/apple', 'rest', 'none', 'page'], ['POST', '/auth/apple/callback', 'rest', 'none', 'page'],
  ['GET', '/auth/email/verify', 'rest', 'none', 'page'], ['POST', '/auth/session', 'rest', 'none', 'json'],
  ['GET', '/auth/me', 'rest', 'bearer', 'json'],
  ['GET', '/oauth/authorize', 'oauth', 'cookie', 'page'], ['POST', '/oauth/authorize', 'oauth', 'cookie', 'json'],
  ['POST', '/oauth/token', 'oauth', 'none', 'json'],
  ...['microsoft', 'gmail', 'google-cal', 'google-drive'].flatMap(p => [
    ['POST', `/auth/${p}/start`, 'rest', 'bearer', 'json'], ['GET', `/auth/${p}`, 'rest', 'none', 'json'],
    ['POST', `/auth/${p}`, 'rest', 'none', 'json'], ['GET', `/auth/${p}/callback`, 'rest', 'none', 'json'],
  ] as Inventory),
];
/** Auth/OAuth routes deliberately WITHOUT the shared charge: own limiters (email, code, DCR), discovery, dev login. */
const EXCLUDED: Array<[string, string]> = [
  ['POST', '/auth/email'], ['POST', '/oauth/authorize/email'], ['POST', '/oauth/authorize/email/code'],
  ['POST', '/oauth/register'], ['GET', '/auth/dev/login'],
  ['GET', '/.well-known/oauth-protected-resource'], ['GET', '/.well-known/oauth-authorization-server'],
];

const savedClientId = process.env.MICROSOFT_CLIENT_ID;
let server: Server | undefined;
let base: string;
let app: Express;
const request = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  fetch(base + path, { method, headers, body, redirect: 'manual' });
/** The bucket subject the admission core derives for a principal (HMAC under the CURRENT ring key). */
const principalSubject = (userId: string) => {
  const ring = readRateKeys();
  const digest = createHmac('sha256', ring.keys.get(ring.current)!)
    .update(JSON.stringify(['v1', 'CREDENTIALS', 'principal', `USER:${userId}`])).digest('hex');
  return `${ring.current}:${digest}`;
};
const principalBuckets = () => db.rateLimitBucket.findMany({ where: { dimension: 'principal' } });
const setPolicy = (data: Record<string, unknown>) => db.rateLimitPolicy.update({ where: { fieldClass: 'CREDENTIALS' }, data });
const makeUser = (handle: string) => db.user.create({ data: { handle, roles: ['READER'] } });

beforeAll(async () => {
  process.env.MICROSOFT_CLIENT_ID = 'ms-client-id.4677';
  app = await createServerOnCleanDb();
  app.set('trust proxy', ['203.0.113.0/24']);
  server = httpServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
// The policy is never cached by admission: this reset is what makes each test independent of the last.
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.rateLimitBucket.deleteMany();
  await setPolicy({ enforcementMode: 'ENFORCING', principalLimit: 30, keyLimit: 30, ipLimit: 1 });
  await withinOneRateWindow(db, 'CREDENTIALS');
});
afterAll(async () => {
  if (savedClientId === undefined) delete process.env.MICROSOFT_CLIENT_ID; else process.env.MICROSOFT_CLIENT_ID = savedClientId;
  vi.restoreAllMocks(); await closeServerIfStarted(server); });

describe('#4677 route inventory (item 4, 16)', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> };
    name?: string; handle?: { stack?: Layer[] }; regexp?: RegExp };
  const mounted = () => {
    const found: Array<{ method: string; path: string; guard?: string }> = [];
    const walk = (stack: Layer[]) => {
      for (const layer of stack) {
        if (layer.route) {
          const guard = layer.route.stack.map(s => s.handle.name).find(n => n.startsWith(AUTH_RATE_ADMISSION_PREFIX));
          for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: layer.route.path, guard });
        } else if (layer.name === 'router' && layer.handle?.stack) {
          // Only root-mounted routers exist today; a prefixed mount would make these paths wrong, so refuse it.
          expect(String(layer.regexp)).toBe(String(/^\/?(?=\/|$)/i));
          walk(layer.handle.stack);
        }
      }
    };
    walk((app as unknown as { _router: { stack: Layer[] } })._router.stack);
    return found.filter(r => /^\/(auth|oauth|\.well-known)\//.test(r.path));
  };

  it('every mounted auth/OAuth route is either guarded with the audited choices or explicitly excluded', () => {
    const actual = mounted();
    const guarded = actual.filter(r => r.guard).map(r => `${r.method} ${r.path} ${r.guard}`).sort();
    const expected = GUARDED.map(([m, p, proto, cred, form]) => `${m} ${p} ${authRateAdmissionName(proto, cred, form)}`).sort();
    expect(guarded).toEqual(expected);
    const unguarded = actual.filter(r => !r.guard).map(r => `${r.method} ${r.path}`).sort();
    expect(unguarded).toEqual(EXCLUDED.map(([m, p]) => `${m} ${p}`).sort());
  });
});

describe('#4677 excluded routes (item 10)', () => {
  it('existing email/DCR/discovery routes are reachable (not 404) and open no CREDENTIALS bucket', async () => {
    for (const [method, path] of EXCLUDED.filter(([, p]) => p !== '/auth/dev/login')) {
      const r = await request(method, path);
      expect(r.status, `${method} ${path}`).not.toBe(404);
      expect(r.status, `${method} ${path}`).not.toBe(429);
      await r.arrayBuffer();
    }
    expect(await db.rateLimitBucket.count({ where: { fieldClass: 'CREDENTIALS' } })).toBe(0);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});

describe('#4677 impersonation (item 6, 14)', () => {
  it('a signed imp token never charges the target, gains no IP bypass, and the non-imp control charges the target bucket', async () => {
    const target = await makeUser('auth-rate-4677-imp');
    const imp = await signJwt({ sub: target.id, roles: [], imp: { sid: 'support-4677', act: 'support-actor', org: 'support-org' } });
    await setPolicy({ principalLimit: 1, ipLimit: 2 });
    const impHeaders = { Authorization: `Bearer ${imp}` };
    expect((await request('GET', '/auth/me', impHeaders)).status).toBe(401); // handler's imp refusal, admitted
    expect((await request('GET', '/auth/me', impHeaders)).status).toBe(401);
    // No bypass: the imp token still spends the shared IP budget, so the third request is refused.
    expect((await request('GET', '/auth/me', impHeaders)).status).toBe(429);
    expect(await principalBuckets()).toHaveLength(0);
    // Control: the same sub without imp is the intended user's principal bucket.
    await db.rateLimitBucket.deleteMany();
    await setPolicy({ principalLimit: 5, ipLimit: 100 });
    const ordinary = await signJwt({ sub: target.id, roles: [] });
    expect((await request('GET', '/auth/me', { Authorization: `Bearer ${ordinary}` })).status).toBe(200);
    const rows = await principalBuckets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: principalSubject(target.id), used: 1n, fieldClass: 'CREDENTIALS' });
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});

describe('#4677 credential sources (items 7, 8, 11)', () => {
  it('connect-start: a valid bearer charges its own principal (spent budget refuses); an invalid bearer is anonymous', async () => {
    const user = await makeUser('auth-rate-4677-start');
    const org = await db.organization.create({ data: { name: 'auth-rate-4677-org', urn: 'auth-rate-4677-org' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
    await setPolicy({ principalLimit: 1, ipLimit: 100 });
    const bearer = { Authorization: `Bearer ${await signJwt({ sub: user.id, roles: ['READER'] })}`, 'content-type': 'application/json' };
    const start = () => request('POST', '/auth/microsoft/start', bearer, JSON.stringify({ orgId: org.id, redirect: '/x' }));
    expect((await start()).status).toBe(200);
    const rows = await principalBuckets();
    expect(rows.map(r => [r.subject, r.used])).toEqual([[principalSubject(user.id), 1n]]);
    const refused = await start();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: 'RATE_LIMITED', code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS' });
    // Invalid bearer: anonymous for admission (no principal row), the handler still gives its own refusal.
    await db.rateLimitBucket.deleteMany();
    const invalid = await request('POST', '/auth/microsoft/start', { Authorization: 'Bearer not-a-jwt', 'content-type': 'application/json' }, '{}');
    expect(invalid.status).not.toBe(429);
    expect(invalid.status).not.toBe(200);
    expect(await principalBuckets()).toHaveLength(0);
    // The bearer-source mount never reads the cookie.
    const cookieOnly = await request('POST', '/auth/microsoft/start', { Cookie: `${AUTH_COOKIE_NAME}=${bearer.Authorization.slice(7)}` });
    expect(cookieOnly.status).toBe(401);
    expect(await principalBuckets()).toHaveLength(0);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('ended sid: anonymous for admission and refused by the handler; the live sid control is admitted and charged', async () => {
    const user = await makeUser('auth-rate-4677-sid');
    const live = await createSignIn(db, { userId: user.id, method: 'github', passkeyId: null });
    const ended = await createSignIn(db, { userId: user.id, method: 'github', passkeyId: null });
    await db.signIn.update({ where: { id: ended.id }, data: { endedAt: new Date(), endReason: 'test-4677' } });
    await setPolicy({ ipLimit: 100 });
    const endedToken = await signJwt({ sub: user.id, roles: ['READER'], sid: ended.id });
    const endedResponse = await request('GET', '/auth/me', { Authorization: `Bearer ${endedToken}` });
    expect(endedResponse.status).toBe(401);
    expect(await principalBuckets()).toHaveLength(0);
    const liveToken = await signJwt({ sub: user.id, roles: ['READER'], sid: live.id });
    expect((await request('GET', '/auth/me', { Authorization: `Bearer ${liveToken}` })).status).toBe(200);
    expect((await principalBuckets()).map(r => r.subject)).toEqual([principalSubject(user.id)]);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('cookie bucket: the live cookie user is charged, never the user of a conflicting Authorization header', async () => {
    app.set('trust proxy', true);
    try {
      const cookieUser = await makeUser('auth-rate-4677-cookie');
      const headerUser = await makeUser('auth-rate-4677-header');
      await setPolicy({ ipLimit: 100 });
      const cookie = `${AUTH_COOKIE_NAME}=${await signJwt({ sub: cookieUser.id, roles: ['READER'] })}`;
      const header = `Bearer ${await signJwt({ sub: headerUser.id, roles: ['READER'] })}`;
      expect((await request('GET', '/oauth/authorize', { Cookie: cookie, Authorization: header })).status).not.toBe(429);
      expect((await principalBuckets()).map(r => [r.subject, r.used])).toEqual([[principalSubject(cookieUser.id), 1n]]);
    } finally { app.set('trust proxy', ['203.0.113.0/24']); }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});

describe('#4677 carrier bodies (item 9)', () => {
  it('exact REST and OAuth refusal fields, with no echo of the request', async () => {
    expect((await request('GET', '/auth/me')).status).toBe(401); // spend the one-request IP budget
    const rest = await request('GET', '/auth/github/callback?code=secret-code-4677&state=secret-state-4677');
    expect(rest.status).toBe(429);
    const restBody = await rest.json() as Record<string, unknown>;
    expect(Object.keys(restBody).sort()).toEqual(['code', 'error', 'fieldClass', 'retryAfterSeconds']);
    expect(restBody).toMatchObject({ error: 'RATE_LIMITED', code: 'RATE_LIMITED', fieldClass: 'CREDENTIALS' });
    expect(rest.headers.get('retry-after')).toBe(String(restBody.retryAfterSeconds));
    const oauth = await request('GET', '/oauth/authorize?client_id=secret-client-4677&state=secret-state-4677');
    expect(oauth.status).toBe(429);
    const oauthBody = await oauth.json() as Record<string, unknown>;
    expect(Object.keys(oauthBody).sort()).toEqual(['code', 'error', 'error_description', 'fieldClass', 'retryAfterSeconds']);
    expect(oauthBody).toMatchObject({ error: 'temporarily_unavailable', error_description: 'Too many requests.', code: 'RATE_LIMITED' });
    expect(oauth.headers.get('retry-after')).toBe(String(oauthBody.retryAfterSeconds));
    for (const text of [JSON.stringify(restBody), JSON.stringify(oauthBody)]) expect(text).not.toMatch(/secret-(code|state|client)-4677/);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});

describe('#4677 refused starts and confirmations leave provider state untouched (item 12)', () => {
  it('an over-budget start mints no nonce; an over-budget confirmation redeems nothing and redirects nowhere; admitted retries succeed', async () => {
    const user = await makeUser('auth-rate-4677-nonce');
    const org = await db.organization.create({ data: { name: 'auth-rate-4677-nonce-org', urn: 'auth-rate-4677-nonce-org' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
    const auth = { Authorization: `Bearer ${await signJwt({ sub: user.id, roles: ['READER'] })}`, 'content-type': 'application/json' };
    const nonceRows = () => db.authHandoffCode.count({ where: { userId: user.id } });
    const startBody = JSON.stringify({ orgId: org.id, redirect: '/x' });

    // Start: spend the IP budget first.
    expect((await request('GET', '/auth/me')).status).toBe(401);
    const refusedStart = await request('POST', '/auth/microsoft/start', auth, startBody);
    expect(refusedStart.status).toBe(429);
    expect(await nonceRows()).toBe(0);
    await setPolicy({ ipLimit: 100 });
    const started = await request('POST', '/auth/microsoft/start', auth, startBody);
    expect(started.status).toBe(200);
    const { nonce } = await started.json() as { nonce: string };
    expect(await nonceRows()).toBe(1);

    // Confirmation: a valid interstitial token and binding, then an exhausted budget.
    const binding = 'ab'.repeat(16);
    const token = connectInterstitialToken('ms-exchange', nonce, binding);
    const confirm = () => request('POST', '/auth/microsoft',
      { 'content-type': 'application/x-www-form-urlencoded', Cookie: `hadron_connect_bind=${binding}` },
      new URLSearchParams({ nonce, token }).toString());
    await db.rateLimitBucket.deleteMany();
    await setPolicy({ ipLimit: 1 });
    expect((await request('GET', '/auth/me')).status).toBe(401);
    const refusedConfirm = await confirm();
    expect(refusedConfirm.status).toBe(429);
    expect(refusedConfirm.headers.get('location')).toBeNull();
    expect(await peekExchangeStartNonce(nonce, 'ms-exchange')).not.toBeNull(); // still redeemable
    await setPolicy({ ipLimit: 100 });
    const admitted = await confirm();
    expect(admitted.status).toBe(302);
    expect(admitted.headers.get('location')).toContain('ms-client-id.4677');
    expect(await peekExchangeStartNonce(nonce, 'ms-exchange')).toBeNull(); // now consumed, exactly once
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});

describe('#4677 Apple callback (item 15)', () => {
  it('the admitted oversized form is refused by the parser (413) and its body is consumed', async () => {
    await setPolicy({ ipLimit: 100 });
    const response = await request('POST', '/auth/apple/callback', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'code=' + 'x'.repeat(110 * 1024));
    expect(response.status).toBe(413);
    const text = await response.text(); // consume, so the connection is not left open
    expect(text).not.toContain('RATE_LIMITED');
    expect(await db.rateLimitBucket.count({ where: { dimension: 'ip' } })).toBe(1);
  }, RATE_WINDOW_TEST_TIMEOUT_MS);
});
