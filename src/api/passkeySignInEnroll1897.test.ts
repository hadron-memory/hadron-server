/**
 * #1897 slice B2: an email sign-in for a person with NO passkey. The sign-in link signs nobody in and enrols nobody;
 * the page sends them to the registration page, which confirms them with its OWN second link or IdP leg bound to that
 * browser (cor:aut:040:09), they add the passkey, return, and sign in by assertion. Real HTTP, real Postgres, a
 * software authenticator, GitHub's two HTTP calls stubbed (as in passkeyRegistration1631.test.ts).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';

const sent = vi.hoisted(() => [] as Array<{ to: string; url: string }>);
vi.mock('../auth/email.js', async (original) => ({
  ...(await original<typeof import('../auth/email.js')>()),
  sendCeremonySignInLink: async (to: string, url: string) => { sent.push({ to, url }); },
}));

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const EMAIL = 'enrol-ana@example.test';
const realFetch = globalThis.fetch;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let server: Server | undefined;
let base: string;
let ana: string;

beforeEach(async () => {
  await cleanDb(db);
  sent.length = 0;
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('BASE_URL', 'https://api.example.test');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_ID', 'gh-client');
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_SECRET', 'gh-secret');
  vi.stubEnv('GITHUB_ORG', '');
  ana = (await db.user.create({ data: { email: EMAIL, handle: 'enrol-ana', githubId: 4242, roles: ['READER'] } })).id;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 4242, login: 'gh-4242', name: null, avatar_url: '' });
    return realFetch(input, init);
  });
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const cookieNamed = (r: Response, name: string) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`)) ?? '';
const post = (path: string, body: unknown, cookie?: string, origin: string | null = ORIGIN) => realFetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}),
});

async function magicLink(opts: { clientState?: string | null } = {}) {
  const token = generateId() + generateId();
  await db.emailVerificationToken.create({ data: {
    email: EMAIL, token, expiresAt: new Date(Date.now() + 600_000),
    clientStateHash: opts.clientState === null ? null : sha(opts.clientState ?? 'portal-nonce'),
  } });
  return token;
}
const verify = (token: string, qs = '') => realFetch(`${base}/auth/email/verify?token=${token}${qs}`, { redirect: 'manual' });
async function begin() {
  const r = await verify(await magicLink());
  return { r, pending: cookieNamed(r, 'hadron_pending_signin') };
}
const page = (path: string, cookie?: string) => realFetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });

/** A confirmed GitHub leg in one browser (the registration page's own confirmation); returns that browser's cookie. */
async function githubLeg(next = 'sign-in'): Promise<{ browser: string; nextCookie: string; confirmBody: string }> {
  const start = await realFetch(`${base}/passkeys/sign-in/github/start`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: `next=${next}`,
  });
  const browser = cookieNamed(start, 'hadron_ceremony_browser');
  const nextCookie = cookieNamed(start, 'hadron_ceremony_next');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cb = await realFetch(`${base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual' });
  const leg = cookieNamed(cb, 'hadron_ceremony_leg');
  const ok = await realFetch(`${base}/passkeys/sign-in/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: `${browser}; ${nextCookie}; ${leg}` }, body: '',
  });
  expect(ok.status).toBe(200);
  return { browser, nextCookie, confirmBody: await ok.text() };
}

async function register(browser: string, key: SoftPasskey) {
  const ch = await post('/passkeys/register/challenge', {});
  const { ceremonyId } = await ch.json() as { ceremonyId: string };
  const ceremony = cookieNamed(ch, 'hadron_ceremony');
  const start = await post('/passkeys/register/start', { ceremonyId }, `${ceremony}; ${browser}`);
  expect(start.status).toBe(200);
  const opts = await start.json() as { publicKey: { challenge: string } };
  const fin = await post('/passkeys/register/finish', {
    ceremonyId, label: 'Laptop',
    response: key.create({ rawChallenge: Buffer.from(opts.publicKey.challenge, 'base64url'), origin: ORIGIN, rpId: RP }),
  }, `${ceremony}; ${browser}`);
  return fin;
}

describe('a person with no passkey', () => {
  it('a claimed sign-in link creates a thirty-minute pending flow and publishes nothing; the account exists (R82)', async () => {
    const { r, pending } = await begin();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/auth/passkey/sign-in');
    expect(pending).toBeTruthy();
    expect(cookieNamed(r, 'hadron_token')).toBe('');
    const row = await db.pendingEmailSignIn.findFirstOrThrow({ where: { userId: ana } });
    const ttl = (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000;
    expect(ttl).toBeGreaterThan(1790);
    expect(ttl).toBeLessThanOrEqual(1800);
    expect(r.headers.getSetCookie().find((c) => c.startsWith('hadron_pending_signin='))).toMatch(/Max-Age=180\d|Max-Age=1800/);
    expect(await db.authHandoffCode.count()).toBe(0);
    expect(await db.signIn.count()).toBe(0);
    expect(await db.passkeyCredential.count()).toBe(0);
  });

  it('the page offers enrolment, not an assertion: a link to the registration page, no script, same-origin referrer policy', async () => {
    const { pending } = await begin();
    const p = await page('/auth/passkey/sign-in', pending);
    expect(p.status).toBe(200);
    expect(p.headers.get('referrer-policy')).toBe('same-origin');
    expect(p.headers.get('cache-control')).toBe('no-store');
    const html = await p.text();
    expect(html).toContain('href="/passkeys/register?next=sign-in"');
    expect(html).not.toContain('<script');
    expect(html).not.toContain(EMAIL);
    // The assertion routes have nothing to offer or accept yet.
    expect((await post('/auth/passkey/sign-in/options', {}, pending)).status).toBe(403);
    expect((await page('/auth/passkey/sign-in')).status).toBe(400);
  });

  it('the sign-in link is not enrolment proof: the registration routes refuse a browser holding only the pending cookie', async () => {
    const { pending } = await begin();
    const ch = await post('/passkeys/register/challenge', {});
    const { ceremonyId } = await ch.json() as { ceremonyId: string };
    const ceremony = cookieNamed(ch, 'hadron_ceremony');
    const start = await post('/passkeys/register/start', { ceremonyId }, `${ceremony}; ${pending}`);
    expect(start.status).toBe(403);
    expect(await db.passkeyCredential.count()).toBe(0);
  });

  it('the registration page carries next=sign-in into its confirmation forms and shows the way back only for it', async () => {
    const withNext = await (await page('/passkeys/register?next=sign-in')).text();
    expect(withNext).toContain('data-next="sign-in"');
    expect(withNext).toContain('name="next" value="sign-in"');
    expect(withNext).toContain('id="continue-signin" hidden');
    expect(withNext).toContain('href="/auth/passkey/sign-in"');
    for (const q of ['', '?next=register', '?next=https://evil.example', '?next=sign-in%22%3E']) {
      const html = await (await page(`/passkeys/register${q}`)).text();
      expect(html).toContain('data-next="register"');
      expect(html).not.toContain('continue-signin');
    }
  });

  it('the second confirmation leads back to the registration page with next=sign-in', async () => {
    const leg = await githubLeg('sign-in');
    expect(leg.nextCookie).toBe('hadron_ceremony_next=sign-in');
    expect(leg.confirmBody).toContain('href="/passkeys/register?next=sign-in"');
    expect(leg.confirmBody).toContain('You have not been signed in');
    // An unknown next never becomes an open redirect.
    const other = await githubLeg('https://evil.example');
    expect(other.confirmBody).toContain('href="/passkeys/register"');
    expect(other.confirmBody).not.toContain('evil.example');
  });

  it('end to end (portal): sign-in link, own confirmation, add the first passkey, return, sign in by assertion', async () => {
    const { pending } = await begin();
    const leg = await githubLeg('sign-in');
    const key = softPasskey();
    const fin = await register(leg.browser, key);
    expect(fin.status).toBe(200);
    expect(await fin.json()).toEqual({ ok: true, kind: 'first' });
    const credential = await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: ana } });
    expect(credential.windowEndsAt).not.toBeNull();
    // Nothing was published by enrolling.
    expect(await db.signIn.count()).toBe(0);
    expect(await db.authHandoffCode.count()).toBe(0);
    // Back on the sign-in page with the same pending flow: now an assertion.
    const p = await page('/auth/passkey/sign-in', pending);
    expect(p.status).toBe(200);
    expect(await p.text()).toContain('<script');
    const optionsRes = await post('/auth/passkey/sign-in/options', {}, pending);
    expect(optionsRes.status).toBe(200);
    const o = await optionsRes.json() as { ceremonyId: string; challenge: string; allowCredentials: string[] };
    expect(o.allowCredentials).toEqual([key.credentialId.toString('base64url')]);
    const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(o.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    const done = await post('/auth/passkey/sign-in/complete', {
      ceremonyId: o.ceremonyId, credentialId: key.credentialId.toString('base64url'),
      authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
    }, pending);
    expect(done.status).toBe(200);
    const signIn = await db.signIn.findFirstOrThrow({ where: { userId: ana } });
    expect(signIn.completedByPasskeyId).toBe(credential.id);
    const handoff = await db.authHandoffCode.findFirstOrThrow({ where: { userId: ana } });
    expect(handoff.signInId).toBe(signIn.id);
    expect(handoff.clientStateHash).toBe(sha('portal-nonce'));
  });

  it('email-only second-link confirmation composes with enrollment and rightful-user sign-in (#2254)', async () => {
    const { pending } = await begin();
    const start = await post('/passkeys/sign-in/email', { email: EMAIL, next: 'sign-in' });
    expect(start.status).toBe(200);
    const browser = cookieNamed(start, 'hadron_ceremony_browser');
    const next = cookieNamed(start, 'hadron_ceremony_next');
    expect(browser).toBeTruthy();
    expect(next).toBe('hadron_ceremony_next=sign-in');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(EMAIL);
    const token = new URL(sent[0]!.url).searchParams.get('token')!;
    const preview = await page(`/passkeys/sign-in/email/verify?token=${encodeURIComponent(token)}`);
    expect(preview.status).toBe(200);
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).confirmedAt).toBeNull();
    const confirm = await realFetch(`${base}/passkeys/sign-in/confirm`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: `${browser}; ${next}` },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('href="/passkeys/register?next=sign-in"');
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } }))).toMatchObject({ method: 'email', confirmedAt: expect.any(Date) });
    const key = softPasskey();
    expect((await register(browser, key)).status).toBe(200);
    const credential = await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: ana } });
    expect(credential.registrationMethod).toBe('email');
    expect(await db.signIn.count()).toBe(0);
    expect(await db.authHandoffCode.count()).toBe(0);
    const o = await (await post('/auth/passkey/sign-in/options', {}, pending)).json() as { ceremonyId: string; challenge: string; allowCredentials: string[] };
    expect(o.allowCredentials).toEqual([key.credentialId.toString('base64url')]);
    const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(o.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    const done = await post('/auth/passkey/sign-in/complete', {
      ceremonyId: o.ceremonyId, credentialId: key.credentialId.toString('base64url'),
      authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
    }, pending);
    expect(done.status).toBe(200);
    const signIn = await db.signIn.findFirstOrThrow({ where: { userId: ana } });
    expect(signIn.completedByPasskeyId).toBe(credential.id);
    expect((await db.authHandoffCode.findFirstOrThrow({ where: { userId: ana } })).signInId).toBe(signIn.id);
  });

  it('a foreign-user passkey leaves the pending first-passkey flow untouched, then the rightful user completes it (#2254)', async () => {
    const { pending } = await begin();
    const rightful = softPasskey();
    const rightfulId = await insertSoftPasskey(db, ana, rightful, { firstWindow: true });
    const other = await db.user.create({ data: { handle: 'enrol-bea', email: 'enrol-bea@example.test', roles: ['READER'] } });
    const foreign = softPasskey();
    const foreignId = await insertSoftPasskey(db, other.id, foreign, { firstWindow: true });
    const options = await post('/auth/passkey/sign-in/options', {}, pending);
    expect(options.status).toBe(200);
    const o = await options.json() as { ceremonyId: string; challenge: string; allowCredentials: string[] };
    expect(o.allowCredentials).toEqual([rightful.credentialId.toString('base64url')]);
    const snapshot = async () => ({
      pending: await db.pendingEmailSignIn.findFirstOrThrow({ where: { userId: ana } }),
      ceremony: await db.passkeyCeremony.findUniqueOrThrow({ where: { id: o.ceremonyId } }),
      foreign: await db.passkeyCredential.findUniqueOrThrow({ where: { id: foreignId } }),
      rightful: await db.passkeyCredential.findUniqueOrThrow({ where: { id: rightfulId } }),
      signIns: await db.signIn.count(), handoffs: await db.authHandoffCode.count(),
    });
    const complete = async (key: SoftPasskey) => {
      const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(o.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
      return post('/auth/passkey/sign-in/complete', {
        ceremonyId: o.ceremonyId, credentialId: key.credentialId.toString('base64url'),
        authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
      }, pending);
    };
    const before = await snapshot();
    expect((await complete(foreign)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect((await complete(rightful)).status).toBe(200);
    const signIn = await db.signIn.findFirstOrThrow({ where: { userId: ana } });
    expect(signIn.completedByPasskeyId).toBe(rightfulId);
    expect(await db.signIn.count({ where: { userId: other.id } })).toBe(0);
    expect(await db.passkeyCredential.findUniqueOrThrow({ where: { id: foreignId } })).toEqual(before.foreign);
    expect((await db.pendingEmailSignIn.findUniqueOrThrow({ where: { id: before.pending.id } })).completedAt).not.toBeNull();
  });

  it('end to end (OAuth): the same journey resumes the validated return_to with an sid cookie', async () => {
    const returnTo = '/oauth/authorize?client_id=x&state=s';
    const r = await verify(await magicLink({ clientState: null }), `&return_to=${encodeURIComponent(returnTo)}`);
    const pending = cookieNamed(r, 'hadron_pending_signin');
    expect(pending).toBeTruthy();
    const leg = await githubLeg('sign-in');
    const key = softPasskey();
    expect((await register(leg.browser, key)).status).toBe(200);
    const o = await (await post('/auth/passkey/sign-in/options', {}, pending)).json() as { ceremonyId: string; challenge: string };
    const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(o.challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
    const done = await post('/auth/passkey/sign-in/complete', {
      ceremonyId: o.ceremonyId, credentialId: key.credentialId.toString('base64url'),
      authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
    }, pending);
    expect(done.status).toBe(200);
    expect((await done.json() as { next: string }).next).toBe(returnTo);
    expect(cookieNamed(done, 'hadron_token')).toBeTruthy();
  });

  it('the pending flow dies after thirty minutes: the page is the invalid page, and a fresh link then goes straight to an assertion', async () => {
    const { pending } = await begin();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE pending_email_sign_ins SET created_at = created_at - interval '31 minutes', expires_at = expires_at - interval '31 minutes'`;
    });
    expect((await page('/auth/passkey/sign-in', pending)).status).toBe(400);
    await insertSoftPasskey(db, ana, softPasskey());
    const again = await begin();
    expect(again.r.status).toBe(302);
    const row = await db.pendingEmailSignIn.findFirstOrThrow({ where: { browserHash: sha(again.pending.split('=')[1]!) } });
    expect((row.expiresAt.getTime() - row.createdAt.getTime()) / 1000).toBeLessThanOrEqual(600);
  });

  it('a person whose only passkey was revoked is treated as having none; one whose passkeys are all for another RP gets the fixed refusal', async () => {
    const id = await insertSoftPasskey(db, ana, softPasskey());
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${id}`;
    expect((await begin()).r.status).toBe(302);
    await db.pendingEmailSignIn.deleteMany({});
    await insertSoftPasskey(db, ana, softPasskey(), { rpId: 'elsewhere.example' });
    const r = await verify(await magicLink());
    expect(r.status).toBe(400);
    expect(await db.pendingEmailSignIn.count()).toBe(0);
  });
});
