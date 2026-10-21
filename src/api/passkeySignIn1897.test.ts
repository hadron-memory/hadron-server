/** #1897 slice B1: the server-hosted passkey step of an email sign-in, over real HTTP and real Postgres. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';
import * as pendingModule from '../auth/pendingEmailSignIn.js';
import * as evidenceModule from '../auth/loginEvidence.js';

// Pass-through spies: every call runs the real function unless a test overrides ONE call.
vi.mock('../auth/pendingEmailSignIn.js', async (orig) => {
  const real = await orig<typeof import('../auth/pendingEmailSignIn.js')>();
  return { ...real, completePending: vi.fn(real.completePending) };
});
vi.mock('../auth/loginEvidence.js', async (orig) => {
  const real = await orig<typeof import('../auth/loginEvidence.js')>();
  return { ...real, verifiedLoginEvidence: vi.fn(real.verifiedLoginEvidence) };
});

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let server: Server | undefined;
let base: string;
let key: SoftPasskey;
let userId: string;
let passkeyId: string;
const EMAIL = 'pending-signin@example.test';

async function boot(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const ON = { PASSKEY_SIGNING_ENABLED: 'true', PASSKEY_REGISTRATION_ENABLED: 'true', PASSKEY_RP_ID: RP, SIGNING_CEREMONY_ORIGINS: ORIGIN };

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_RP_ID', RP);
  userId = (await db.user.create({ data: { email: EMAIL, handle: 'pending-user', roles: ['READER'] } })).id;
  key = softPasskey();
  passkeyId = await insertSoftPasskey(db, userId, key);
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

async function magicLink(opts: { clientState?: string | null; email?: string } = {}) {
  const token = generateId() + generateId();
  await db.emailVerificationToken.create({ data: {
    email: opts.email ?? EMAIL, token, expiresAt: new Date(Date.now() + 600_000),
    clientStateHash: opts.clientState === undefined ? sha('portal-nonce') : opts.clientState === null ? null : sha(opts.clientState),
  } });
  return token;
}
const verify = (token: string, qs = '') => fetch(`${base}/auth/email/verify?token=${token}${qs}`, { redirect: 'manual' });
const cookieOf = (r: Response, name: string) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));
const pendingCount = () => db.pendingEmailSignIn.count();

/** Begin a portal flow and return the pending cookie. */
async function begin(over: { clientState?: string | null; qs?: string } = {}) {
  const r = await verify(await magicLink({ clientState: over.clientState }), over.qs ?? '');
  const cookie = cookieOf(r, 'hadron_pending_signin');
  return { r, cookie };
}
const post = (path: string, cookie: string | undefined, body?: unknown, origin: string | null = ORIGIN) => fetch(`${base}/auth/passkey/sign-in${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body ?? {}),
});
async function options(cookie: string) {
  const r = await post('/options', cookie);
  expect(r.status).toBe(200);
  return await r.json() as { ceremonyId: string; challenge: string; rpId: string; allowCredentials: string[] };
}
function answer(o: { ceremonyId: string; challenge: string }, over: { uv?: boolean; origin?: string; signer?: SoftPasskey; counter?: number } = {}) {
  const k = over.signer ?? key;
  const a = k.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(o.challenge, 'base64url'), origin: over.origin ?? ORIGIN, rpId: RP, counter: over.counter ?? 1, uv: over.uv });
  return {
    ceremonyId: o.ceremonyId, credentialId: k.credentialId.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
  };
}

describe('switch off or signing-only', () => {
  it.each([
    ['off', {}],
    ['signing-only', { PASSKEY_SIGNING_ENABLED: 'true', PASSKEY_RP_ID: RP, SIGNING_CEREMONY_ORIGINS: ORIGIN }],
  ])('%s: nothing is mounted and /auth/email/verify still hands the portal a code at once', async (_n, env) => {
    await boot(env);
    expect((await fetch(`${base}/auth/passkey/sign-in`)).status).toBe(404);
    expect((await post('/options', undefined)).status).toBe(404);
    const r = await verify(await magicLink());
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/\/auth\/callback\?code=/);
    expect(await pendingCount()).toBe(0);
    expect(await db.authHandoffCode.count({ where: { signInId: null } })).toBe(1);
  });
});

describe('portal continuation, switch on', () => {
  beforeEach(async () => { await boot(ON); });

  it('a claimed link publishes nothing: no handoff code, no JWT cookie, only a pending row and its cookie', async () => {
    const { r, cookie } = await begin();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/auth/passkey/sign-in');
    expect(cookie).toBeTruthy();
    expect(cookieOf(r, 'hadron_token')).toBeUndefined();
    expect(await db.authHandoffCode.count()).toBe(0);
    expect(await db.signIn.count()).toBe(0);
    expect(await pendingCount()).toBe(1);
    expect(r.headers.get('location')).not.toMatch(/token|code|@/);
  });

  it('the page renders only for the cookie holder, with the security headers, and never completes anything', async () => {
    const { cookie } = await begin();
    const ok = await fetch(`${base}/auth/passkey/sign-in`, { headers: { cookie: cookie! } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ok.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await ok.text()).not.toContain('<script>');
    const none = await fetch(`${base}/auth/passkey/sign-in`);
    const forged = await fetch(`${base}/auth/passkey/sign-in`, { headers: { cookie: 'hadron_pending_signin=forged' } });
    expect(none.status).toBe(400);
    expect(await none.text()).toBe(await forged.text());
    expect(await db.signIn.count()).toBe(0);
  });

  it('completing with the owner\'s passkey issues one handoff code that carries the sign-in and the ORIGINAL portal binding', async () => {
    const { cookie } = await begin({ clientState: 'portal-nonce' });
    const o = await options(cookie!);
    expect(o.rpId).toBe(RP);
    expect(o.allowCredentials).toEqual([key.credentialId.toString('base64url')]);
    const done = await post('/complete', cookie, answer(o));
    expect(done.status).toBe(200);
    const { next } = await done.json() as { next: string };
    const code = new URL(next).searchParams.get('code')!;
    expect(next).toContain('/auth/callback?code=');
    const signIn = await db.signIn.findFirstOrThrow({ where: { userId } });
    expect(signIn).toMatchObject({ completedByPasskeyId: passkeyId, method: 'email', endedAt: null });
    const handoff = await db.authHandoffCode.findFirstOrThrow({ where: { userId } });
    expect(handoff.signInId).toBe(signIn.id);
    expect(handoff.clientStateHash).toBe(sha('portal-nonce'));
    expect(handoff.codeHash).toBe(sha(code));
    expect((await db.pendingEmailSignIn.findFirstOrThrow()).signInId).toBe(signIn.id);
    expect(cookieOf(done, 'hadron_token')).toBeUndefined();
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(1n);
  });

  it('a replay of the same proof, and a second pending-less attempt, are the uniform 403 and add nothing', async () => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    const body = answer(o);
    expect((await post('/complete', cookie, body)).status).toBe(200);
    const again = await post('/complete', cookie, body);
    expect(again.status).toBe(403);
    expect(await again.text()).toBe('{"error":"forbidden"}');
    expect(await db.signIn.count()).toBe(1);
    expect(await db.authHandoffCode.count()).toBe(1);
  });

  it.each([
    ['no cookie', (c: string) => ({ cookie: undefined as string | undefined, origin: ORIGIN as string | null, uv: undefined as boolean | undefined, c })],
    ['a forged cookie', () => ({ cookie: 'hadron_pending_signin=forged-forged-forged-forged-forged', origin: ORIGIN, uv: undefined })],
    ['an unlisted Origin', (c: string) => ({ cookie: c, origin: 'https://evil.example', uv: undefined })],
    ['no Origin header', (c: string) => ({ cookie: c, origin: null, uv: undefined })],
    ['an assertion without user verification', (c: string) => ({ cookie: c, origin: ORIGIN, uv: false })],
  ])('refuses %s with the uniform 403 and publishes nothing', async (_n, make) => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    const m = make(cookie!);
    const r = await post('/complete', m.cookie, answer(o, { uv: m.uv }), m.origin);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    expect(await db.signIn.count()).toBe(0);
    expect(await db.authHandoffCode.count()).toBe(0);
    // The genuine holder can still finish.
    expect((await post('/complete', cookie, answer(o))).status).toBe(200);
  });

  it('refuses another user\'s passkey: the client supplies no authority', async () => {
    const other = await db.user.create({ data: { handle: 'someone-else', roles: [] } });
    const otherKey = softPasskey();
    await insertSoftPasskey(db, other.id, otherKey);
    const { cookie } = await begin();
    const o = await options(cookie!);
    const r = await post('/complete', cookie, answer(o, { signer: otherKey }));
    expect(r.status).toBe(403);
    expect(await db.signIn.count()).toBe(0);
  });

  it('a revoked passkey cannot complete', async () => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${passkeyId}`;
    expect((await post('/complete', cookie, answer(o))).status).toBe(403);
    expect(await db.signIn.count()).toBe(0);
  });

  it('a new options call retires the earlier challenge, and an expired flow is dead', async () => {
    const { cookie } = await begin();
    const first = await options(cookie!);
    const second = await options(cookie!);
    expect((await post('/complete', cookie, answer(first))).status).toBe(403);
    const pending = await db.pendingEmailSignIn.findFirstOrThrow();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE pending_email_sign_ins SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes' WHERE id = ${pending.id}`;
    });
    expect((await post('/complete', cookie, answer(second))).status).toBe(403);
    expect((await fetch(`${base}/auth/passkey/sign-in`, { headers: { cookie: cookie! } })).status).toBe(400);
    expect(await db.signIn.count()).toBe(0);
  });

  it('two concurrent completions of the same proof have exactly one winner', async () => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    const body = answer(o);
    const rs = await Promise.all([post('/complete', cookie, body), post('/complete', cookie, body)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await db.signIn.count()).toBe(1);
    expect(await db.authHandoffCode.count()).toBe(1);
  });

  it('a refusal after the sign-in was written rolls EVERYTHING back (Andi, Gene: late completePending=false)', async () => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    vi.mocked(pendingModule.completePending).mockResolvedValueOnce(false);
    const r = await post('/complete', cookie, answer(o));
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    // The deciding writes did not commit: no sign-in, no handoff code, the ceremony and counter are untouched,
    // and the pending flow is still live, so the genuine retry with the same proof succeeds.
    expect(await db.signIn.count()).toBe(0);
    expect(await db.authHandoffCode.count()).toBe(0);
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(0n);
    expect((await db.pendingEmailSignIn.findFirstOrThrow()).completedAt).toBeNull();
    expect((await post('/complete', cookie, answer(o))).status).toBe(200);
    expect(await db.signIn.count()).toBe(1);
  });

  it('reads the login evidence on the transaction, never on the shared pool (Charles: pool starvation)', async () => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    vi.mocked(evidenceModule.verifiedLoginEvidence).mockClear();
    expect((await post('/complete', cookie, answer(o))).status).toBe(200);
    const calls = vi.mocked(evidenceModule.verifiedLoginEvidence).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [client] of calls) expect(client === (db as unknown)).toBe(false);
  });

  it('options is refused for an unlisted Origin and for an expired flow, like complete', async () => {
    const { cookie } = await begin();
    expect((await post('/options', cookie, {}, 'https://evil.example')).status).toBe(403);
    expect((await post('/options', cookie, {}, null)).status).toBe(403);
    const pending = await db.pendingEmailSignIn.findFirstOrThrow();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE pending_email_sign_ins SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes' WHERE id = ${pending.id}`;
    });
    expect((await post('/options', cookie)).status).toBe(403);
  });

  it('a passkey enrolled for another RP ID does not count: the fixed refusal, no pending row', async () => {
    const elsewhere = await db.user.create({ data: { email: 'rp@example.test', handle: 'rp-user', roles: ['READER'] } });
    await insertSoftPasskey(db, elsewhere.id, softPasskey(), { rpId: 'elsewhere.example' });
    const r = await verify(await magicLink({ email: 'rp@example.test' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Invalid or expired token' });
    expect(await pendingCount()).toBe(0);
    expect(await db.authHandoffCode.count()).toBe(0);
  });

  it('a user with no passkey gets the fixed refusal and no pending row: the factor is never skipped', async () => {
    await db.user.create({ data: { email: 'nopass@example.test', handle: 'nopass', roles: ['READER'] } });
    const r = await verify(await magicLink({ email: 'nopass@example.test' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Invalid or expired token' });
    expect(await pendingCount()).toBe(0);
    expect(await db.authHandoffCode.count()).toBe(0);
    expect(cookieOf(r, 'hadron_token')).toBeUndefined();
  });

  it('a passkey cancelled after completion ends the sign-in and its handoff code is dead (lineage holds)', async () => {
    const { cookie } = await begin();
    const o = await options(cookie!);
    expect((await post('/complete', cookie, answer(o))).status).toBe(200);
    const { endSignInsCompletedBy } = await import('../auth/signIn.js');
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${passkeyId}`;
      await endSignInsCompletedBy(tx, passkeyId);
    });
    expect((await db.signIn.findFirstOrThrow({ where: { userId } })).endedAt).not.toBeNull();
    expect((await db.authHandoffCode.findFirstOrThrow({ where: { userId } })).redeemedAt).not.toBeNull();
  });
});

describe('OAuth continuation, switch on', () => {
  beforeEach(async () => { await boot(ON); });

  it('resumes the validated return_to with a revocable sid cookie, and only after the passkey', async () => {
    const returnTo = '/oauth/authorize?client_id=x&state=s';
    const r = await verify(await magicLink({ clientState: null }), `&return_to=${encodeURIComponent(returnTo)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/auth/passkey/sign-in');
    expect(cookieOf(r, 'hadron_token')).toBeUndefined();
    const cookie = cookieOf(r, 'hadron_pending_signin')!;
    const o = await options(cookie);
    const done = await post('/complete', cookie, answer(o));
    expect(done.status).toBe(200);
    expect((await done.json() as { next: string }).next).toBe(returnTo);
    const token = cookieOf(done, 'hadron_token')!.split('=')[1]!;
    const signIn = await db.signIn.findFirstOrThrow({ where: { userId } });
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(claims).toMatchObject({ sid: signIn.id, sub: userId });
    expect(await db.authHandoffCode.count()).toBe(0);
  });

  it('a tampered return_to is refused before the link is spent, and an unbound link without return_to still fails closed', async () => {
    const t = await magicLink({ clientState: null });
    expect((await verify(t, '&return_to=https://evil.example')).status).toBe(400);
    expect(await pendingCount()).toBe(0);
    expect((await verify(t)).status).toBe(400);
    expect(await pendingCount()).toBe(0);
  });
});
