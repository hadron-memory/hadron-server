/**
 * #1631 PR2 (cor:aut:040:02, 07, 08): registration and the cancel link over HTTP, end to end from a fresh sign-in leg,
 * with GitHub's two HTTP calls stubbed and a software authenticator.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { signJwt } from '../auth/jwt.js';
import { issueCancelToken } from '../lib/passkeys/cancel.js';
import { createSignIn } from '../auth/signIn.js';
import { PASSKEY_CANCEL_RATE_LIMIT_PER_MINUTE } from './passkeyCeremonyRoutes.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const realFetch = globalThis.fetch;
let server: Server | undefined;
let base: string;
let ana: string;
let bea: string;
let ghId = 4242;

async function boot() {
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_ID', 'gh-client');
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_SECRET', 'gh-secret');
  vi.stubEnv('GITHUB_ORG', '');
  ana = (await db.user.create({ data: { handle: 'http-ana', githubId: 4242, roles: [] } })).id;
  bea = (await db.user.create({ data: { handle: 'http-bea', githubId: 4343, roles: [] } })).id;
  ghId = 4242;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: ghId, login: `gh-${ghId}`, name: null, avatar_url: '' });
    return realFetch(input, init);
  });
  await boot();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const cookieNamed = (r: Response, name: string) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''])
  .map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`)) ?? '';
const post = (path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}, origin: string | null = ORIGIN) =>
  realFetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...extra },
    body: JSON.stringify(body ?? {}),
  });

/** A confirmed GitHub fresh sign-in in one browser; returns that browser's sign-in cookie. */
async function signInLeg(githubId = 4242): Promise<string> {
  ghId = githubId;
  const start = await realFetch(`${base}/passkeys/sign-in/github/start`, { method: 'POST', redirect: 'manual', headers: { origin: ORIGIN } });
  const browser = cookieNamed(start, 'hadron_ceremony_browser');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cb = await realFetch(`${base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual' });
  const leg = cookieNamed(cb, 'hadron_ceremony_leg');
  const ok = await realFetch(`${base}/passkeys/sign-in/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: `${browser}; ${leg}` }, body: '',
  });
  expect(ok.status).toBe(200);
  return browser;
}

async function challenge() {
  const r = await post('/passkeys/register/challenge', {});
  expect(r.status).toBe(200);
  const { ceremonyId } = await r.json() as { ceremonyId: string };
  return { ceremonyId, ceremony: cookieNamed(r, 'hadron_ceremony') };
}

type Options = { publicKey: { challenge: string; user: { id: string; name: string }; excludeCredentials: Array<{ id: string }>; rp: { id: string } }; account: { handle: string } };

const createResponse = (key: SoftPasskey, challengeB64: string, over: { uv?: boolean } = {}) =>
  key.create({ rawChallenge: Buffer.from(challengeB64, 'base64url'), origin: ORIGIN, rpId: RP, uv: over.uv });

describe('a first passkey, end to end (040:02 S1)', () => {
  it('registers from a fresh GitHub sign-in, names the account before the prompt, and clears both cookies', async () => {
    const browser = await signInLeg();
    const { ceremonyId, ceremony } = await challenge();
    const start = await post('/passkeys/register/start', { ceremonyId }, `${ceremony}; ${browser}`);
    expect(start.status).toBe(200);
    const opts = await start.json() as Options;
    expect(opts.account.handle).toBe('http-ana');
    expect(opts.publicKey).toMatchObject({ challenge: ceremonyId, user: { name: 'http-ana' }, rp: { id: RP }, excludeCredentials: [] });
    // cor:aut:040:05: every credential is discoverable (Andi P2-1).
    expect(opts.publicKey).toMatchObject({ authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, extensions: { credProps: true } });
    const key = softPasskey();
    const fin = await post('/passkeys/register/finish', { ceremonyId, response: createResponse(key, opts.publicKey.challenge), label: 'Laptop' }, `${ceremony}; ${browser}`);
    expect(fin.status).toBe(200);
    expect(await fin.json()).toEqual({ ok: true, kind: 'first' });
    const cleared = fin.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith('hadron_ceremony=;'))).toBe(true);
    expect(cleared.some((c) => c.startsWith('hadron_ceremony_browser=;'))).toBe(true);
    expect(cleared.some((c) => /hadron_token/.test(c))).toBe(false);
    const c = await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: ana } });
    expect(c).toMatchObject({ registrationMethod: 'github', enrollmentRpId: RP, label: 'Laptop' });
    expect(c.windowEndsAt).not.toBeNull();
    expect(Buffer.from(c.userHandle).toString('base64url')).toBe(opts.publicKey.user.id);
    expect(await db.passkeyRegistrationNotice.count({ where: { passkeyId: c.id, kind: 'first' } })).toBe(1);
  });

  it('a bearer credential for another user cannot steer the ceremony; it is ignored (040:02 S3, Rook Q2.2)', async () => {
    const browser = await signInLeg();
    const { ceremonyId, ceremony } = await challenge();
    const beaJwt = await signJwt({ sub: bea, roles: [] });
    const start = await post('/passkeys/register/start', { ceremonyId, userId: bea }, `${ceremony}; ${browser}; hadron_token=${beaJwt}`, { authorization: `Bearer ${beaJwt}` });
    expect(((await start.json()) as Options).account.handle).toBe('http-ana');
  });

  it('a bearer credential alone registers nothing (040:02 S3)', async () => {
    const anaJwt = await signJwt({ sub: ana, roles: [] });
    const { ceremonyId, ceremony } = await challenge();
    const start = await post('/passkeys/register/start', { ceremonyId }, `${ceremony}; hadron_token=${anaJwt}`, { authorization: `Bearer ${anaJwt}` });
    expect(start.status).toBe(403);
    expect(await db.passkeyCredential.count()).toBe(0);
  });

  it('refuses a finish without the sign-in browser\'s cookie (Rook Q1.1)', async () => {
    const browser = await signInLeg();
    const { ceremonyId, ceremony } = await challenge();
    const opts = await (await post('/passkeys/register/start', { ceremonyId }, `${ceremony}; ${browser}`)).json() as Options;
    const fin = await post('/passkeys/register/finish', { ceremonyId, response: createResponse(softPasskey(), opts.publicKey.challenge), label: 'L' }, ceremony);
    expect(fin.status).toBe(403);
    expect(await db.passkeyCredential.count()).toBe(0);
  });

  it('refuses a registration without user verification (040:02 S6)', async () => {
    const browser = await signInLeg();
    const { ceremonyId, ceremony } = await challenge();
    const opts = await (await post('/passkeys/register/start', { ceremonyId }, `${ceremony}; ${browser}`)).json() as Options;
    const fin = await post('/passkeys/register/finish', { ceremonyId, response: createResponse(softPasskey(), opts.publicKey.challenge, { uv: false }), label: 'L' }, `${ceremony}; ${browser}`);
    expect(fin.status).toBe(403);
  });

  it.each(['/passkeys/register/challenge', '/passkeys/register/start', '/passkeys/register/finish'])('%s refuses an unlisted or absent Origin', async (path) => {
    expect((await post(path, {}, undefined, {}, 'https://evil.example')).status).toBe(403);
    expect((await post(path, {}, undefined, {}, null)).status).toBe(403);
  });
});

describe('a later passkey (040:02 S2, S4)', () => {
  it('registers with a vouch from an out-of-window passkey and excludes the existing ones', async () => {
    const voucher = softPasskey();
    await insertSoftPasskey(db, ana, voucher);
    const { ceremonyId, ceremony } = await challenge();
    const a = voucher.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(ceremonyId, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    const vouch = { credentialId: voucher.credentialId.toString('base64url'), authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url') };
    const start = await post('/passkeys/register/start', { ceremonyId, vouch }, ceremony);
    expect(start.status).toBe(200);
    const opts = await start.json() as Options;
    expect(opts.publicKey.excludeCredentials.map((e) => e.id)).toEqual([voucher.credentialId.toString('base64url')]);
    const fin = await post('/passkeys/register/finish', { ceremonyId, response: createResponse(softPasskey(), opts.publicKey.challenge), label: 'Key' }, ceremony);
    expect(await fin.json()).toEqual({ ok: true, kind: 'later' });
  });

  it('refuses a vouch from a passkey still in its window', async () => {
    const voucher = softPasskey();
    await insertSoftPasskey(db, ana, voucher, { firstWindow: true });
    const { ceremonyId, ceremony } = await challenge();
    const a = voucher.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(ceremonyId, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    const vouch = { credentialId: voucher.credentialId.toString('base64url'), authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url') };
    expect((await post('/passkeys/register/start', { ceremonyId, vouch }, ceremony)).status).toBe(403);
  });
});

describe('the cancel link (040:08 S6-S9)', () => {
  let passkeyId: string;
  let token: string;
  beforeEach(async () => {
    passkeyId = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
    token = await db.$transaction((tx) => issueCancelToken(tx, passkeyId));
  });
  const cancel = (t: string, origin: string | null = ORIGIN) => realFetch(`${base}/passkeys/cancel`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'MailApp/2', ...(origin ? { origin } : {}) },
    body: `token=${encodeURIComponent(t)}`,
  });

  it('the GET renders without spending, unframeable and with no referrer', async () => {
    const r = await realFetch(`${base}/passkeys/cancel?token=${token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).revokedAt).toBeNull();
  });

  it('the POST cancels with no sign-in, records the user agent, and ends the sign-ins; a second use gets the same refusal as an unknown link', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId }));
    const r = await cancel(token);
    expect(r.status).toBe(200);
    const c = await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } });
    expect(c).toMatchObject({ windowOutcome: 'cancelled', cancelUserAgent: 'MailApp/2' });
    expect(c.cancelIp).toBeTruthy();
    expect((await db.signIn.findUniqueOrThrow({ where: { id: si.id } })).endedAt).not.toBeNull();
    const again = await cancel(token);
    const unknown = await cancel('Z'.repeat(43));
    expect(again.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await again.text()).toBe(await unknown.text());
  });

  it('a refused link still says what to do if you did not add the passkey (Uma P2-3), and the page says Remove', async () => {
    expect(await (await realFetch(`${base}/passkeys/cancel?token=${token}`)).text()).toContain('Remove this passkey');
    const body = await (await cancel('Z'.repeat(43))).text();
    expect(body).toContain("If you didn't add this passkey");
  });

  it('refuses a cross-origin POST', async () => {
    expect((await cancel(token, 'https://evil.example')).status).toBe(403);
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).revokedAt).toBeNull();
  });

  it('is rate limited per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PASSKEY_CANCEL_RATE_LIMIT_PER_MINUTE + 1; i++) statuses.push((await cancel('Q'.repeat(43))).status);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('end the window early (040:07 S2, S7)', () => {
  it('a fresh sign-in with a different provider ends the window, then clears the sign-in cookie', async () => {
    const id = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registration_method = 'google' WHERE id = ${id}`;
    });
    const browser = await signInLeg();
    const r = await post('/passkeys/window/end', {}, browser);
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().some((c) => c.startsWith('hadron_ceremony_browser=;'))).toBe(true);
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id } })).windowOutcome).toBe('ended-early');
  });

  it('previews which passkey the step would act on, spending nothing (Rook P3-2)', async () => {
    await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true, label: 'My laptop' });
    const browser = await signInLeg();
    // registered via github in the fixture; a github sign-in can't end it, so nothing to preview
    expect((await post('/passkeys/window/preview', {}, browser)).status).toBe(403);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE passkey_credentials SET registration_method = 'google' WHERE owner_id = ${ana}`;
    });
    const r = await post('/passkeys/window/preview', {}, browser);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ label: 'My laptop', method: 'Google' });
    // The preview spent nothing: the step itself still succeeds.
    expect((await post('/passkeys/window/end', {}, browser)).status).toBe(200);
  });

  it('the same method, a bearer alone, or a cross-origin POST ends nothing', async () => {
    const id = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true });
    const browser = await signInLeg();
    expect((await post('/passkeys/window/end', {}, browser)).status).toBe(403);
    const anaJwt = await signJwt({ sub: ana, roles: [] });
    expect((await post('/passkeys/window/end', {}, undefined, { authorization: `Bearer ${anaJwt}` })).status).toBe(403);
    expect((await post('/passkeys/window/end', {}, browser, {}, 'https://evil.example')).status).toBe(403);
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id } })).windowOutcome).toBeNull();
  });
});

describe('the server-hosted pages', () => {
  it('/passkeys/register: same-origin script only, unframeable, the sign-in forms carry next=register', async () => {
    const r = await realFetch(`${base}/passkeys/register`);
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
    const html = await r.text();
    expect(html).toContain(`data-rp-id="${RP}"`);
    expect(html).toContain('action="/passkeys/sign-in/github/start"');
    expect(html).toContain('name="next" value="register"');
    expect(html).toContain('src="/passkeys/assets/ceremony.js"');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('/passkeys/register shows step 1 done once this browser is confirmed, and gates step 2 until then (Uma P2-1)', async () => {
    const before = await (await realFetch(`${base}/passkeys/register`)).text();
    expect(before).toMatch(/<button id="add-first" disabled/);
    expect(before).toContain('Available once step 1 is done');
    expect(before).toContain('cooling-off window of 72 hours');
    const browser = await signInLeg();
    const after = await (await realFetch(`${base}/passkeys/register`, { headers: { cookie: browser } })).text();
    expect(after).toMatch(/Confirmed with GitHub<\/strong>, (10|9) minute\(s\) left/);
    expect(after).toMatch(/<button id="add-first">/);
    expect(after).not.toContain('action="/passkeys/sign-in/github/start"');
    // Rendering spent nothing.
    expect(await db.freshSignIn.count({ where: { consumedAt: { not: null } } })).toBe(0);
  });

  it('"Not my account: stop" forgets the ceremony and the confirmation cookies (Uma P2-2)', async () => {
    const r = await post('/passkeys/register/stop', {});
    expect(r.status).toBe(200);
    const set = r.headers.getSetCookie();
    expect(set.some((c) => c.startsWith('hadron_ceremony=;'))).toBe(true);
    expect(set.some((c) => c.startsWith('hadron_ceremony_browser=;'))).toBe(true);
    expect((await post('/passkeys/register/stop', {}, undefined, {}, 'https://evil.example')).status).toBe(403);
  });

  it('/passkeys/window/end carries next=window, and the script is served as JavaScript', async () => {
    expect(await (await realFetch(`${base}/passkeys/window/end`)).text()).toContain('name="next" value="window"');
    const js = await realFetch(`${base}/passkeys/assets/ceremony.js`);
    expect(js.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    const script = await js.text();
    // The served script must at least parse: no test executes it, and a stray quote would break every page.
    expect(() => new Function(script)).not.toThrow();
    // Dorian P3s (#2210 LOCAL 6323189143): a non-OK email response isn't reported as sent, and a failed stop still
    // settles with a visible result.
    expect(script).toMatch(/sign-in\/email[\s\S]{0,200}if \(!r\.ok\) throw/);
    expect(script).toMatch(/register\/stop'\)\.then\(function \(r\) \{[\s\S]{0,400}\}, function \(e\) \{/);
    expect(script).toContain('navigator.credentials.create');
    // Uma P2-4: the end-window preview offers the "I didn't add this" path.
    expect(script).toContain("not-mine-window");
    expect(await (await realFetch(`${base}/passkeys/window/end`)).text()).toContain("I didn't add this passkey");
    // Andi P3: an email-form error on the end-window page reports into that page's own status line.
    expect(script).not.toMatch(/catch\(function \(e\) \{ say\('status-first', e\.message\); \}\)/);
    expect(await (await realFetch(`${base}/passkeys/window/end`)).text()).toContain('<button id="end-window">Continue</button>');
  });

  it('the confirm page links back to the page the leg started from', async () => {
    ghId = 4242;
    const start = await realFetch(`${base}/passkeys/sign-in/github/start`, {
      method: 'POST', redirect: 'manual', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'next=window',
    });
    const browser = cookieNamed(start, 'hadron_ceremony_browser');
    const next = cookieNamed(start, 'hadron_ceremony_next');
    expect(next).toBe('hadron_ceremony_next=window');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await realFetch(`${base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual' });
    const ok = await realFetch(`${base}/passkeys/sign-in/confirm`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: `${browser}; ${cookieNamed(cb, 'hadron_ceremony_leg')}; ${next}` }, body: '',
    });
    expect(await ok.text()).toContain('href="/passkeys/window/end"');
  });
});

/**
 * The Origin a browser sends for a non-GET, non-CORS-tainted request (a form POST, or a same-origin fetch), per the
 * Fetch standard's "append a request `Origin` header": the page's referrer policy can serialize it as "null". This is
 * the rule a real browser applied in Chip's #2210 QA, so the pins below drive the routes with exactly that Origin.
 */
function browserPostOrigin(referrerPolicy: string | null, pageOrigin: string, targetOrigin: string): string {
  const sameOrigin = pageOrigin === targetOrigin;
  const downgrade = pageOrigin.startsWith('https:') && targetOrigin.startsWith('http:');
  switch (referrerPolicy) {
    case 'no-referrer': return 'null';
    case 'same-origin': return sameOrigin ? pageOrigin : 'null';
    case 'no-referrer-when-downgrade': case 'strict-origin': case 'strict-origin-when-cross-origin': case null: case '':
      return downgrade ? 'null' : pageOrigin;
    default: return pageOrigin;
  }
}

describe('a real browser\'s form POST from the ceremony pages reaches the routes (Chip #2210 P2, Marco #29597)', () => {
  it('the rule itself: a no-referrer page sends Origin: null, which the allowlist refuses', async () => {
    expect(browserPostOrigin('no-referrer', ORIGIN, ORIGIN)).toBe('null');
    const r = await post('/passkeys/register/challenge', {}, undefined, {}, 'null');
    expect(r.status).toBe(403);
  });

  it.each([
    ['/passkeys/register', '/passkeys/sign-in/github/start'],
    ['/passkeys/window/end', '/passkeys/sign-in/github/start'],
    ['/passkeys/register', '/passkeys/register/challenge'],
  ])('a POST from %s to %s carries the real Origin and is admitted', async (pagePath, target) => {
    const page = await realFetch(`${base}${pagePath}`);
    const origin = browserPostOrigin(page.headers.get('referrer-policy'), ORIGIN, ORIGIN);
    expect(origin).toBe(ORIGIN);
    const r = await realFetch(`${base}${target}`, {
      method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'next=register',
    });
    expect([200, 303]).toContain(r.status);
  });
});

describe('Referrer-Policy keeps the real Origin (Chip #2210 browser QA 6329343431)', () => {
  // Under the Fetch spec a non-GET request from a page with Referrer-Policy: no-referrer serializes its Origin as
  // "null", so a real browser's form POSTs and same-origin fetch POSTs from these pages all failed the Origin
  // allowlist (stubbed tests set Origin themselves and couldn't see it). 'same-origin' sends the real Origin on
  // same-origin requests and still sends no referrer to any third party.
  it.each(['/passkeys/register', '/passkeys/window/end', '/passkeys/sign-in/confirm'])('%s is never no-referrer', async (path) => {
    const r = await realFetch(`${base}${path}`);
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
  });
});

describe('mounting', () => {
  it('a first-passkey window shorter than 72 hours fails at boot (cor:aut:040:07)', async () => {
    vi.stubEnv('PASSKEY_FIRST_WINDOW_HOURS', '48');
    await expect(createServer()).rejects.toThrow(/PASSKEY_FIRST_WINDOW_HOURS/);
  });

  it('with the registration switch off nothing is mounted', async () => {
    await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    await boot();
    for (const path of ['/passkeys/register/challenge', '/passkeys/register/start', '/passkeys/register/finish', '/passkeys/cancel', '/passkeys/window/end']) {
      expect((await post(path, {})).status).toBe(404);
    }
    expect((await realFetch(`${base}/passkeys/cancel?token=${'a'.repeat(43)}`)).status).toBe(404);
    for (const path of ['/passkeys/register', '/passkeys/window/end', '/passkeys/assets/ceremony.js']) {
      expect((await realFetch(`${base}${path}`)).status).toBe(404);
    }
  });
});

void createHash;
