/**
 * #1631 PR3 (cor:aut:040:08): revocation over HTTP. Proved by another passkey's assertion or by a fresh GitHub sign-in
 * (GitHub's two HTTP calls stubbed), never by a magic link; then one of the owner's passkeys is revoked.
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
import { confirmFreshSignIn, startEmailSignIn } from '../lib/passkeys/freshSignIn.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const realFetch = globalThis.fetch;
const h = (v: string) => createHash('sha256').update(v).digest('hex');
let server: Server | undefined;
let base: string;
let ana: string;
let laptop: SoftPasskey; let laptopId: string;
let phone: SoftPasskey; let phoneId: string;

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
  ana = (await db.user.create({ data: { handle: 'rv-ana', githubId: 5151, roles: [] } })).id;
  laptop = softPasskey(); laptopId = await insertSoftPasskey(db, ana, laptop, { label: 'Laptop' });
  phone = softPasskey(); phoneId = await insertSoftPasskey(db, ana, phone, { label: 'Phone' });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 5151, login: 'rv-ana', name: null, avatar_url: '' });
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

const cookieNamed = (r: Response, name: string) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`)) ?? '';
const post = (path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}, origin: string | null = ORIGIN) =>
  realFetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...extra },
    body: JSON.stringify(body ?? {}),
  });
async function challenge() {
  const r = await post('/passkeys/revoke/challenge', {});
  expect(r.status).toBe(200);
  return { ceremonyId: ((await r.json()) as { ceremonyId: string }).ceremonyId, ceremony: cookieNamed(r, 'hadron_ceremony') };
}
const proofBody = (key: SoftPasskey, ceremonyId: string) => {
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(ceremonyId, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
  return { ceremonyId, credentialId: key.credentialId.toString('base64url'), authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url') };
};
type Listed = { passkeys: Array<{ credentialId: string; label: string; prover: boolean }> };
const rec = (id: string) => db.passkeyCredential.findUniqueOrThrow({ where: { id } });

/** A confirmed GitHub fresh sign-in started from the revoke page; returns that browser's cookie. */
async function githubLeg(): Promise<string> {
  const start = await realFetch(`${base}/passkeys/sign-in/github/start`, {
    method: 'POST', redirect: 'manual', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'next=revoke',
  });
  const browser = cookieNamed(start, 'hadron_ceremony_browser');
  expect(cookieNamed(start, 'hadron_ceremony_next')).toBe('hadron_ceremony_next=revoke');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cb = await realFetch(`${base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual' });
  const ok = await realFetch(`${base}/passkeys/sign-in/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: `${browser}; ${cookieNamed(cb, 'hadron_ceremony_leg')}` }, body: '',
  });
  expect(ok.status).toBe(200);
  return browser;
}

describe('revoke with another passkey (040:08 S1)', () => {
  it('proves, lists the owner\'s passkeys with the prover marked, and removes another one, clearing the ceremony cookie', async () => {
    const { ceremonyId, ceremony } = await challenge();
    const start = await post('/passkeys/revoke/start', proofBody(phone, ceremonyId), ceremony);
    expect(start.status).toBe(200);
    const { passkeys } = await start.json() as Listed;
    expect(passkeys.map((p) => [p.label, p.prover]).sort()).toEqual([['Laptop', false], ['Phone', true]]);
    const fin = await post('/passkeys/revoke/finish', { ceremonyId, credentialId: laptop.credentialId.toString('base64url') }, ceremony);
    expect(fin.status).toBe(200);
    expect(await fin.json()).toEqual({ ok: true, windowCancelled: false });
    expect(fin.headers.getSetCookie().some((c) => c.startsWith('hadron_ceremony=;'))).toBe(true);
    expect((await rec(laptopId)).revokedAt).not.toBeNull();
    expect((await rec(phoneId)).revokedAt).toBeNull();
  });

  it('the prover can\'t remove itself, and a finish from another browser does nothing', async () => {
    const { ceremonyId, ceremony } = await challenge();
    await post('/passkeys/revoke/start', proofBody(phone, ceremonyId), ceremony);
    expect((await post('/passkeys/revoke/finish', { ceremonyId, credentialId: phone.credentialId.toString('base64url') }, ceremony)).status).toBe(403);
    expect((await post('/passkeys/revoke/finish', { ceremonyId, credentialId: laptop.credentialId.toString('base64url') }, 'hadron_ceremony=other')).status).toBe(403);
    expect((await rec(laptopId)).revokedAt).toBeNull();
  });
});

describe('revoke with an identity provider (040:08 S2)', () => {
  it('a fresh GitHub sign-in from the revoke page proves, then any of the owner\'s passkeys can be removed', async () => {
    const browser = await githubLeg();
    const page = await (await realFetch(`${base}/passkeys/revoke`, { headers: { cookie: browser } })).text();
    expect(page).toContain('Confirmed with GitHub');
    const { ceremonyId, ceremony } = await challenge();
    const start = await post('/passkeys/revoke/start', { ceremonyId }, `${ceremony}; ${browser}`);
    expect(start.status).toBe(200);
    expect(((await start.json()) as Listed).passkeys.every((p) => !p.prover)).toBe(true);
    const fin = await post('/passkeys/revoke/finish', { ceremonyId, credentialId: phone.credentialId.toString('base64url') }, `${ceremony}; ${browser}`);
    expect(fin.status).toBe(200);
    expect(fin.headers.getSetCookie().some((c) => c.startsWith('hadron_ceremony_browser=;'))).toBe(true);
    expect((await rec(phoneId)).revokedAt).not.toBeNull();
  });

  it('a magic-link fresh sign-in never proves a revocation (S10, Rook Q1.3)', async () => {
    const { token } = await startEmailSignIn(db, { userId: ana, browserNonceHash: h('mailbrowser') });
    expect(await confirmFreshSignIn(db, { legSecret: token, browserNonceHash: h('mailbrowser'), channel: 'email' })).toBe(true);
    const { ceremonyId, ceremony } = await challenge();
    expect((await post('/passkeys/revoke/start', { ceremonyId }, `${ceremony}; hadron_ceremony_browser=mailbrowser`)).status).toBe(403);
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: ana } })).consumedAt).toBeNull();
  });
});

describe('never by a bearer, and only on the server origin', () => {
  it('a bearer credential proves nothing and names nobody (040:08 S3)', async () => {
    const jwt = await signJwt({ sub: ana, roles: [] });
    const { ceremonyId, ceremony } = await challenge();
    expect((await post('/passkeys/revoke/start', { ceremonyId, userId: ana }, `${ceremony}; hadron_token=${jwt}`, { authorization: `Bearer ${jwt}` })).status).toBe(403);
    expect((await post('/passkeys/revoke/finish', { ceremonyId, credentialId: laptop.credentialId.toString('base64url') }, ceremony, { authorization: `Bearer ${jwt}` })).status).toBe(403);
    expect((await rec(laptopId)).revokedAt).toBeNull();
  });

  it.each(['/passkeys/revoke/challenge', '/passkeys/revoke/start', '/passkeys/revoke/finish'])('%s refuses an unlisted or absent Origin', async (path) => {
    expect((await post(path, {}, undefined, {}, 'https://evil.example')).status).toBe(403);
    expect((await post(path, {}, undefined, {}, null)).status).toBe(403);
  });
});

describe('the page', () => {
  it('says sessions stay signed in, offers no email link, and is dark with the switch', async () => {
    const r = await realFetch(`${base}/passkeys/revoke`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('signs out the sessions it signed in');
    expect(html).not.toContain('stay signed in');
    expect(html).not.toContain('id="email-form"');
    expect(html).toContain('action="/passkeys/sign-in/github/start"');
    expect(html).toContain('name="next" value="revoke"');
    await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    await boot();
    expect((await realFetch(`${base}/passkeys/revoke`)).status).toBe(404);
    expect((await post('/passkeys/revoke/finish', {})).status).toBe(404);
  });
});
