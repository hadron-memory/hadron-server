/**
 * #1631 PR1b slice 2 (cor:aut:040:09): the ceremony's sign-in legs over HTTP. The GitHub leg is driven end to end
 * through the real callback with GitHub's two HTTP calls stubbed; the email leg with the mail send stubbed.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const sent = vi.hoisted(() => [] as Array<{ to: string; url: string }>);
vi.mock('../auth/email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/email.js')>()),
  sendCeremonySignInLink: async (to: string, url: string) => { sent.push({ to, url }); },
}));

const { createServer } = await import('../server.js');
const { db } = await import('../integrations/db/client.js');
const { cleanDb } = await import('../test/helpers.js');

const ORIGIN = 'https://sign.example.test';
const h = (v: string) => createHash('sha256').update(v).digest('hex');
const realFetch = globalThis.fetch;
let server: Server | undefined;
let base: string;
/** The GitHub identity the stubbed API returns for the next callback. */
/** Locally generated IdP signing keys, served as each provider's JWKS by the fetch stub. */
const idp = {} as Record<'google' | 'apple', { key: CryptoKey; jwk: JWK }>;
/** The ID-token claims the stubbed provider returns for the next callback (`auth_time: undefined` omits it). */
let claims: Record<'google' | 'apple', Record<string, unknown>> = { google: {}, apple: {} };
let applePem = '';
const nowS = () => Math.floor(Date.now() / 1000);

async function idToken(provider: 'google' | 'apple') {
  const { auth_time, ...rest } = claims[provider];
  return new SignJWT({ ...rest, ...(auth_time === undefined ? {} : { auth_time }) })
    .setProtectedHeader({ alg: provider === 'google' ? 'RS256' : 'ES256', kid: `${provider}-kid` })
    .setIssuer(provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com')
    .setAudience(provider === 'google' ? 'google-client' : 'apple-client')
    .setIssuedAt().setExpirationTime('5m')
    .sign(idp[provider].key);
}

beforeAll(async () => {
  for (const [provider, alg] of [['google', 'RS256'], ['apple', 'ES256']] as const) {
    const pair = await generateKeyPair(alg, { extractable: true });
    idp[provider] = { key: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: `${provider}-kid`, alg, use: 'sig' } };
  }
  // Apple's client-secret JWT is signed with the team's .p8 key; any ES256 key serves for the stubbed token call.
  applePem = await exportPKCS8((await generateKeyPair('ES256', { extractable: true })).privateKey);
});

let ghIdentity = { id: 4242, login: 'octo-alice', name: 'Alice', avatar_url: 'https://a.example/x.png' };

async function boot() {
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await cleanDb(db);
  sent.length = 0;
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_ID', 'gh-client');
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_SECRET', 'gh-secret');
  vi.stubEnv('GITHUB_ORG', '');
  vi.stubEnv('BASE_URL', 'https://api.example.test');
  vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret');
  vi.stubEnv('APPLE_CLIENT_ID', 'apple-client');
  vi.stubEnv('APPLE_TEAM_ID', 'TEAM123456');
  vi.stubEnv('APPLE_KEY_ID', 'KEY1234567');
  vi.stubEnv('APPLE_PRIVATE_KEY', applePem);
  claims = { google: {}, apple: {} };
  ghIdentity = { id: 4242, login: 'octo-alice', name: 'Alice', avatar_url: 'https://a.example/x.png' };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json(ghIdentity);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: await idToken('google') });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [idp.google.jwk] });
    if (url === 'https://appleid.apple.com/auth/token') return Response.json({ id_token: await idToken('apple') });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [idp.apple.jwk] });
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

const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

/** Start a GitHub ceremony leg; returns the browser's cookie and the state the IdP will echo back. */
async function startGithub(origin: string | null = ORIGIN) {
  const r = await realFetch(`${base}/passkeys/sign-in/github/start`, {
    method: 'POST', redirect: 'manual', headers: origin ? { origin } : {},
  });
  if (r.status !== 303) return { status: r.status, cookie: '', state: '' };
  const idp = new URL(r.headers.get('location')!);
  return { status: r.status, cookie: cookieOf(r), state: idp.searchParams.get('state')!, setCookie: r.headers.get('set-cookie')! };
}

/** The IdP redirecting whichever browser finished the sign-in back to our callback (a cross-site GET: no Strict cookie). */
const callback = (state: string) =>
  realFetch(`${base}/auth/github/callback?code=gh-code&state=${state}`, { redirect: 'manual' });

/** The confirm POST: an IdP leg id rides in its cookie (Rook 6316353964), never in the form. */
const confirm = (leg: string | undefined, cookie: string | undefined, origin: string | null = ORIGIN) => {
  const cookies = [cookie, leg === undefined ? undefined : `hadron_ceremony_leg=${leg}`].filter(Boolean).join('; ');
  return realFetch(`${base}/passkeys/sign-in/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}), ...(cookies ? { cookie: cookies } : {}) },
    body: '',
  });
};

/** The email leg's confirm POST: the emailed token rides in the form. */
const confirmEmail = (token: string, cookie: string | undefined, origin: string | null = ORIGIN) =>
  realFetch(`${base}/passkeys/sign-in/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: `token=${encodeURIComponent(token)}`,
  });

/** The leg id from the callback's Set-Cookie (the only place it travels). */
const legOf = (r: Response) => /hadron_ceremony_leg=([A-Za-z0-9_-]{43})/.exec(r.headers.get('set-cookie') ?? '')![1];

describe('GitHub leg', () => {
  let alice: string;
  beforeEach(async () => {
    alice = (await db.user.create({ data: { handle: 'fsi-alice', githubId: 4242, githubUsername: 'octo-alice', roles: [] } })).id;
  });

  it('start sets the Strict ceremony browser cookie and binds only its hash to the pending state', async () => {
    const s = await startGithub();
    expect(s.status).toBe(303);
    expect(s.setCookie).toMatch(/^hadron_ceremony_browser=[A-Za-z0-9_-]{43};/);
    expect(s.setCookie).toMatch(/HttpOnly/i);
    expect(s.setCookie).toMatch(/SameSite=Strict/i);
    expect(s.setCookie).toMatch(/Path=\/passkeys/i);
    expect(s.setCookie).toMatch(/Max-Age=900/i);
    const row = await db.pendingLoginState.findUniqueOrThrow({ where: { state: s.state } });
    expect(row).toMatchObject({ provider: 'github', ceremonyNonceHash: h(s.cookie.split('=')[1]), clientState: null, returnTo: null });
  });

  it('refuses a start from an unlisted or absent Origin', async () => {
    expect((await startGithub('https://evil.example')).status).toBe(403);
    expect((await startGithub(null)).status).toBe(403);
    expect(await db.pendingLoginState.count()).toBe(0);
  });

  it('the callback mints no session and no handoff code, and redirects to confirm with a leg id; the same browser confirms', async () => {
    const s = await startGithub();
    const cb = await callback(s.state);
    expect(cb.status).toBe(303);
    // The leg id never rides a URL: only the Strict cookie scoped to the confirm path carries it.
    expect(cb.headers.get('location')).toBe('/passkeys/sign-in/confirm');
    expect(cb.headers.get('referrer-policy')).toBe('same-origin');
    const legCookie = cb.headers.get('set-cookie')!;
    expect(legCookie).toMatch(/^hadron_ceremony_leg=[A-Za-z0-9_-]{43};/);
    expect(legCookie).toMatch(/HttpOnly/i);
    expect(legCookie).toMatch(/SameSite=Strict/i);
    expect(legCookie).toMatch(/Path=\/passkeys\/sign-in\/confirm/i);
    expect(legCookie).toMatch(/Max-Age=900/i);
    expect(legCookie).not.toMatch(/hadron_token/);
    expect(await db.authHandoffCode.count()).toBe(0);
    const leg = legOf(cb);

    const pageR = await realFetch(`${base}/passkeys/sign-in/confirm`);
    expect(pageR.status).toBe(200);
    expect(pageR.headers.get('referrer-policy')).toBe('same-origin');
    expect(pageR.headers.get('x-frame-options')).toBe('DENY');
    const html = await pageR.text();
    expect(html).not.toContain(leg);
    expect(html).not.toContain('name="leg"');
    expect(html).toContain('Never share this page');
    // Rendering the page confirms nothing.
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } })).confirmedAt).toBeNull();

    const ok = await confirm(leg, s.cookie);
    expect(ok.status).toBe(200);
    // The leg cookie is cleared; nothing else is set (no session).
    expect(ok.headers.get('set-cookie')).toMatch(/^hadron_ceremony_leg=;/);
    expect(ok.headers.get('set-cookie')).not.toMatch(/hadron_token/);
    const row = await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } });
    expect(row).toMatchObject({ method: 'github', browserNonceHash: h(s.cookie.split('=')[1]) });
    expect(row.confirmedAt).not.toBeNull();
  });

  it('a leg started in browser A and finished in browser B confirms in neither (Ruth red pin 1)', async () => {
    const a = await startGithub();            // the agent's browser starts the leg...
    const b = await startGithub();            // ...browser B holds a ceremony cookie of its own
    const cb = await callback(a.state);       // ...and B finishes A's IdP leg, so only B learns the leg id
    const leg = legOf(cb);
    expect((await confirm(leg, b.cookie)).status).toBe(403);
    expect((await confirm(leg, undefined)).status).toBe(403);
    expect((await confirm(undefined, a.cookie)).status).toBe(403);
    expect((await confirm('A'.repeat(43), a.cookie)).status).toBe(403);
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } })).confirmedAt).toBeNull();
  });

  it('an IdP leg id offered in the form, not its cookie, confirms nothing (no URL or form fallback)', async () => {
    const s = await startGithub();
    const leg = legOf(await callback(s.state));
    expect((await confirmEmail(leg, s.cookie)).status).toBe(403);
    // ...nor with some other leg cookie alongside it: the form is only ever the email channel.
    expect((await confirmEmail(leg, `${s.cookie}; hadron_ceremony_leg=${'B'.repeat(43)}`)).status).toBe(403);
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } })).confirmedAt).toBeNull();
    expect((await confirm(leg, s.cookie)).status).toBe(200);
  });

  it('clears the leg cookie even when the confirm is refused', async () => {
    const s = await startGithub();
    const leg = legOf(await callback(s.state));
    const r = await confirm(leg, 'hadron_ceremony_browser=someone-else');
    expect(r.status).toBe(403);
    expect(r.headers.get('set-cookie')).toMatch(/^hadron_ceremony_leg=;.*Path=\/passkeys\/sign-in\/confirm/i);
  });

  it('confirm refuses a cross-origin or Origin-less POST even with both halves', async () => {
    const s = await startGithub();
    const leg = legOf(await callback(s.state));
    expect((await confirm(leg, s.cookie, 'https://evil.example')).status).toBe(403);
    expect((await confirm(leg, s.cookie, null)).status).toBe(403);
    expect((await confirm(leg, s.cookie)).status).toBe(200);
  });

  it('a callback after the switch went off records nothing', async () => {
    const s = await startGithub();
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    const cb = await callback(s.state);
    expect(cb.status).toBe(403);
    expect(await db.freshSignIn.count()).toBe(0);
  });
});

describe('GitHub leg: an unknown identity links and creates nothing (Ruth red pin 2)', () => {
  it('a GitHub id no user carries creates no user and records nothing', async () => {
    const before = await db.user.count();
    const s = await startGithub();
    ghIdentity = { id: 999_001, login: 'stranger', name: null as unknown as string, avatar_url: '' };
    const cb = await callback(s.state);
    expect(cb.status).toBe(403);
    expect(await db.user.count()).toBe(before);
    expect(await db.freshSignIn.count()).toBe(0);
  });

  it('a matching username without the GitHub id is not linked (login would link it by username)', async () => {
    const u = await db.user.create({ data: { handle: 'fsi-seed', githubUsername: 'octo-seed', roles: [] } });
    const s = await startGithub();
    ghIdentity = { id: 777, login: 'octo-seed', name: 'Seed', avatar_url: '' };
    expect((await callback(s.state)).status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).githubId).toBeNull();
    expect(await db.freshSignIn.count()).toBe(0);
  });

  it('a deleted user is not found', async () => {
    await db.user.create({ data: { handle: 'fsi-gone', githubId: 4242, roles: [], deletedAt: new Date() } });
    const s = await startGithub();
    expect((await callback(s.state)).status).toBe(403);
    expect(await db.freshSignIn.count()).toBe(0);
  });
});

/** Start a Google or Apple leg, then have the provider send the finishing browser to our callback. */
async function idpLeg(provider: 'google' | 'apple') {
  const r = await realFetch(`${base}/passkeys/sign-in/${provider}/start`, { method: 'POST', redirect: 'manual', headers: { origin: ORIGIN } });
  expect(r.status).toBe(303);
  const authorize = new URL(r.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  const cb = provider === 'google'
    ? await realFetch(`${base}/auth/google/callback?code=c&state=${state}`, { redirect: 'manual' })
    // Apple form_posts cross-site: no cookie.
    : await realFetch(`${base}/auth/apple/callback`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=c&state=${state}`,
    });
  return { authorize, cb, cookie: cookieOf(r) };
}

describe('Google leg (R154: re-authentication requested and verified)', () => {
  it('asks Google for max_age=0, and a fresh auth_time for a known Google id records a google row the browser confirms', async () => {
    const u = await db.user.create({ data: { handle: 'fsi-gina', googleId: 'g-gina', roles: [] } });
    claims.google = { sub: 'g-gina', auth_time: nowS() };
    const { authorize, cb, cookie } = await idpLeg('google');
    expect(authorize.searchParams.get('max_age')).toBe('0');
    expect(cb.status).toBe(303);
    expect(cb.headers.get('set-cookie')).not.toMatch(/hadron_token/);
    expect((await confirm(legOf(cb), cookie)).status).toBe(200);
    expect(await db.freshSignIn.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ method: 'google' });
  });

  it.each([
    ['older than the leg (a silent Google session)', () => nowS() - 3600],
    ['missing', () => undefined],
  ])('refuses an auth_time %s and records nothing', async (_c, authTime) => {
    await db.user.create({ data: { handle: 'fsi-gina', googleId: 'g-gina', roles: [] } });
    claims.google = { sub: 'g-gina', auth_time: authTime() };
    expect((await idpLeg('google')).cb.status).toBe(403);
    expect(await db.freshSignIn.count()).toBe(0);
  });

  it('an unknown Google id whose verified email matches a user links nothing, creates nothing, records nothing (Ruth red pin 2)', async () => {
    const u = await db.user.create({ data: { handle: 'fsi-hal', email: 'hal@example.test', roles: [] } });
    const before = await db.user.count();
    claims.google = { sub: 'g-new', email: 'hal@example.test', email_verified: true, auth_time: nowS() };
    expect((await idpLeg('google')).cb.status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).googleId).toBeNull();
    expect(await db.user.count()).toBe(before);
    expect(await db.freshSignIn.count()).toBe(0);
  });
});

describe('Apple leg (no re-authentication request: a silent session is accepted, R154)', () => {
  it('a known Apple id records an apple row the browser confirms', async () => {
    const u = await db.user.create({ data: { handle: 'fsi-ari', appleId: 'a-ari', roles: [] } });
    claims.apple = { sub: 'a-ari' };
    const { cb, cookie } = await idpLeg('apple');
    expect(cb.status).toBe(303);
    expect((await confirm(legOf(cb), cookie)).status).toBe(200);
    expect(await db.freshSignIn.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ method: 'apple' });
  });

  it('an unknown Apple id whose verified email matches a user links nothing, creates nothing, records nothing (Ruth red pin 2)', async () => {
    const u = await db.user.create({ data: { handle: 'fsi-ivy', email: 'ivy@example.test', roles: [] } });
    const before = await db.user.count();
    claims.apple = { sub: 'a-new', email: 'ivy@example.test', email_verified: 'true' };
    expect((await idpLeg('apple')).cb.status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).appleId).toBeNull();
    expect(await db.user.count()).toBe(before);
    expect(await db.freshSignIn.count()).toBe(0);
  });

  it('a deleted Apple user records nothing', async () => {
    await db.user.create({ data: { handle: 'fsi-gone-a', appleId: 'a-gone', roles: [], deletedAt: new Date() } });
    claims.apple = { sub: 'a-gone' };
    expect((await idpLeg('apple')).cb.status).toBe(403);
    expect(await db.freshSignIn.count()).toBe(0);
  });
});

describe('email leg', () => {
  const startEmail = (email: string, origin: string | null = ORIGIN) => realFetch(`${base}/passkeys/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ email }),
  });

  it('answers the same for an address no one owns, sends nothing and creates no account', async () => {
    const before = await db.user.count();
    const r = await startEmail('nobody@example.test');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(cookieOf(r)).toMatch(/^hadron_ceremony_browser=/);
    expect(sent).toEqual([]);
    expect(await db.user.count()).toBe(before);
    expect(await db.freshSignIn.count()).toBe(0);
  });

  it('emails a live user a link whose GET spends nothing; the starting browser\'s POST is the proof', async () => {
    const carol = await db.user.create({ data: { handle: 'fsi-carol', email: 'carol@example.test', roles: [] } });
    const r = await startEmail('Carol@Example.test');
    expect(await r.json()).toEqual({ ok: true });
    const cookie = cookieOf(r);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('carol@example.test');
    const link = new URL(sent[0].url);
    expect(link.origin + link.pathname).toBe('https://api.example.test/passkeys/sign-in/email/verify');
    const token = link.searchParams.get('token')!;

    const pageR = await realFetch(`${base}/passkeys/sign-in/email/verify?token=${token}`);
    expect(pageR.status).toBe(200);
    expect(pageR.headers.get('referrer-policy')).toBe('same-origin');
    expect(await db.freshSignIn.findFirstOrThrow({ where: { userId: carol.id } })).toMatchObject({ signedInAt: null, confirmedAt: null });

    // The ordinary magic-link route never sees this token, so it can't become a session (Option-C included).
    const login = await realFetch(`${base}/auth/email/verify?token=${token}&return_to=%2Foauth%2Fauthorize`, { redirect: 'manual' });
    expect(login.status).toBe(400);
    expect(login.headers.get('set-cookie') ?? '').not.toMatch(/hadron_token/);

    expect((await confirmEmail(token, 'hadron_ceremony_browser=someone-else')).status).toBe(403);
    // An emailed token is never accepted in the leg cookie's place.
    expect((await confirm(token, cookie)).status).toBe(403);
    expect((await confirmEmail(token, cookie)).status).toBe(200);
    const row = await db.freshSignIn.findFirstOrThrow({ where: { userId: carol.id } });
    expect(row.method).toBe('email');
    expect(row.signedInAt).not.toBeNull();
    expect(row.confirmedAt).not.toBeNull();
  });

  it('sends nothing to a deleted user\'s address', async () => {
    await db.user.create({ data: { handle: 'fsi-erin', email: 'erin@example.test', roles: [], deletedAt: new Date() } });
    const r = await startEmail('erin@example.test');
    expect(await r.json()).toEqual({ ok: true });
    expect(sent).toEqual([]);
    expect(await db.freshSignIn.count()).toBe(0);
  });

  it('refuses an unlisted Origin before sending anything', async () => {
    await db.user.create({ data: { handle: 'fsi-dave', email: 'dave@example.test', roles: [] } });
    expect((await startEmail('dave@example.test', 'https://evil.example')).status).toBe(403);
    expect(sent).toEqual([]);
  });
});

describe('switch off', () => {
  it('mounts nothing', async () => {
    await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    await boot();
    expect((await startGithub()).status).toBe(404);
    expect((await realFetch(`${base}/passkeys/sign-in/confirm`)).status).toBe(404);
  });
});
