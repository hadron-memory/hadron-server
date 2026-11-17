/**
 * #4339 (Slice 1 of hadron-server-private#37): sign-in never depends on a passkey and never prompts for one
 * (Holger's decision, 2026-11-17). With the passkey switches ON, a valid magic link signs the person in exactly as
 * with them off, whatever passkeys they hold; a passkey is asked for only by an act that needs one (signing).
 * Real HTTP and real Postgres. Pins marked RED fail on main (the verify route redirected to the passkey page);
 * pins marked GREEN pass on main by design and guard what must not move.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const realFetch = globalThis.fetch;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let server: Server | undefined;
let base: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_ID', 'gh-client');
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_SECRET', 'gh-secret');
  vi.stubEnv('GITHUB_ORG', '');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gh-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 4339, login: 'gh-4339', name: null, avatar_url: '' });
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

const cookieOf = (r: Response, name: string) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));
const verify = (token: string, qs = '') => realFetch(`${base}/auth/email/verify?token=${token}${qs}`, { redirect: 'manual' });
async function magicLink(email: string, clientState: string | null = 'portal-nonce') {
  const token = generateId() + generateId();
  await db.emailVerificationToken.create({ data: {
    email, token, expiresAt: new Date(Date.now() + 600_000), clientStateHash: clientState === null ? null : sha(clientState),
  } });
  return token;
}
const noPasskeyStep = async (r: Response) => {
  expect(cookieOf(r, 'hadron_pending_signin')).toBeUndefined();
  expect(await db.pendingEmailSignIn.count()).toBe(0);
  expect(r.headers.get('location') ?? '').not.toContain('/auth/passkey/sign-in');
  expect(r.headers.get('location') ?? '').not.toContain('/passkeys/register');
};

describe('#4339 email magic link, passkey switches ON', () => {
  it('RED: a user with NO passkey is signed in: the portal gets its handoff code, no passkey step', async () => {
    const email = 'nopass-4339@example.test';
    await verify(await magicLink(email)); // creates the account (R82) and spends the link
    const r = await verify(await magicLink(email));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/auth\/callback\?code=/);
    await noPasskeyStep(r);
    expect(await db.authHandoffCode.count({ where: { signInId: null } })).toBeGreaterThanOrEqual(1);
  });

  it('RED: a brand-new address (no account yet) is signed in at once', async () => {
    const r = await verify(await magicLink('brandnew-4339@example.test'));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/auth\/callback\?code=/);
    await noPasskeyStep(r);
    expect(await db.user.count({ where: { email: 'brandnew-4339@example.test' } })).toBe(1);
  });

  it('RED: a user WHO HOLDS a passkey is signed in with no passkey prompt', async () => {
    const email = 'haspass-4339@example.test';
    const u = await db.user.create({ data: { email, handle: 'haspass-4339', roles: ['READER'] } });
    await insertSoftPasskey(db, u.id, softPasskey());
    const r = await verify(await magicLink(email));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/auth\/callback\?code=/);
    await noPasskeyStep(r);
    expect(await db.authHandoffCode.count({ where: { userId: u.id } })).toBe(1);
  });

  it('RED: a user whose only passkey was enrolled for another RP ID is signed in too (no fixed refusal)', async () => {
    const email = 'elsewhere-4339@example.test';
    const u = await db.user.create({ data: { email, handle: 'elsewhere-4339', roles: ['READER'] } });
    await insertSoftPasskey(db, u.id, softPasskey(), { rpId: 'elsewhere.example' });
    const r = await verify(await magicLink(email));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/auth\/callback\?code=/);
    await noPasskeyStep(r);
  });

  it.each([['no passkey', false], ['a passkey', true]])('RED: the Option-C leg (%s) sets the hadron_token cookie and resumes return_to', async (_n, has) => {
    const email = `optc-${has}-4339@example.test`;
    const u = await db.user.create({ data: { email, handle: `optc-${has}-4339`, roles: ['READER'] } });
    if (has) await insertSoftPasskey(db, u.id, softPasskey());
    const returnTo = '/oauth/authorize?client_id=x&state=s';
    const r = await verify(await magicLink(email, null), `&return_to=${encodeURIComponent(returnTo)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(returnTo);
    expect(cookieOf(r, 'hadron_token')).toBeTruthy();
    await noPasskeyStep(r);
  });

  it('GREEN: fail-closed paths are unchanged: bad token, unbound link without return_to, tampered return_to, replay', async () => {
    const email = 'closed-4339@example.test';
    const bad = await verify('no-such-token');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid or expired token' });
    const unbound = await magicLink(email, null);
    expect((await verify(unbound)).status).toBe(400);
    const tampered = await magicLink(email, null);
    expect((await verify(tampered, '&return_to=https://evil.example')).status).toBe(400);
    const ok = await magicLink(email);
    expect((await verify(ok)).status).toBe(302);
    const replay = await verify(ok);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'Invalid or expired token' });
  });
});

describe('#4339 the other providers, switches ON', () => {
  it('GREEN on main by design: GitHub sign-in completes with a handoff code and no passkey step', async () => {
    await db.user.create({ data: { email: 'gh-4339@example.test', handle: 'gh-4339', githubId: 4339, roles: ['READER'] } });
    const start = await realFetch(`${base}/auth/github?client_state=${'a'.repeat(64)}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await realFetch(`${base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toMatch(/\/auth\/callback\?code=/);
    await noPasskeyStep(cb);
  });

  it('RED on main, then structural for good: no sign-in route (email, GitHub, Google, Apple) can begin a passkey step', () => {
    // Google and Apple need a provider token exchange that this suite does not stub; the property is structural:
    // the only thing that creates a pending sign-in flow is beginPasskeySignIn, and nothing but its definition names it.
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
    const users = walk(join(process.cwd(), 'src')).filter((p) => /beginPasskeySignIn|createPendingEmailSignIn/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(process.cwd().length + 1)).sort();
    expect(users).toEqual(['src/api/passkeySignInRoutes.ts', 'src/auth/pendingEmailSignIn.ts']);
  });
});
