/**
 * #1631 PR1b slice 2 (cor:aut:040:09): the ceremony's sign-in legs over HTTP. The GitHub leg is driven end to end
 * through the real callback with GitHub's two HTTP calls stubbed; the email leg with the mail send stubbed.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  ghIdentity = { id: 4242, login: 'octo-alice', name: 'Alice', avatar_url: 'https://a.example/x.png' };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json(ghIdentity);
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

const confirm = (leg: string | undefined, cookie: string | undefined, origin: string | null = ORIGIN) =>
  realFetch(`${base}/passkeys/sign-in/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: leg === undefined ? '' : `leg=${encodeURIComponent(leg)}`,
  });

const legOf = (r: Response) => new URL(r.headers.get('location')!, base).searchParams.get('leg')!;

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
    expect(cb.headers.get('location')).toMatch(/^\/passkeys\/sign-in\/confirm\?leg=[A-Za-z0-9_-]{43}$/);
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    expect(cb.headers.get('set-cookie')).toBeNull();
    expect(await db.authHandoffCode.count()).toBe(0);
    const leg = legOf(cb);

    const pageR = await realFetch(`${base}/passkeys/sign-in/confirm?leg=${leg}`);
    expect(pageR.status).toBe(200);
    expect(pageR.headers.get('referrer-policy')).toBe('no-referrer');
    expect(pageR.headers.get('x-frame-options')).toBe('DENY');
    expect(await pageR.text()).toContain(`value="${leg}"`);
    // Rendering the page confirms nothing.
    expect((await db.freshSignIn.findFirstOrThrow({ where: { userId: alice } })).confirmedAt).toBeNull();

    const ok = await confirm(leg, s.cookie);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toBeNull();
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
    expect(pageR.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await db.freshSignIn.findFirstOrThrow({ where: { userId: carol.id } })).toMatchObject({ signedInAt: null, confirmedAt: null });

    // The ordinary magic-link route never sees this token, so it can't become a session (Option-C included).
    const login = await realFetch(`${base}/auth/email/verify?token=${token}&return_to=%2Foauth%2Fauthorize`, { redirect: 'manual' });
    expect(login.status).toBe(400);
    expect(login.headers.get('set-cookie') ?? '').not.toMatch(/hadron_token/);

    expect((await confirm(token, 'hadron_ceremony_browser=someone-else')).status).toBe(403);
    expect((await confirm(token, cookie)).status).toBe(200);
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
    expect((await realFetch(`${base}/passkeys/sign-in/confirm?leg=${'a'.repeat(43)}`)).status).toBe(404);
  });
});
