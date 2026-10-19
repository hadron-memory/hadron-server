/** #1631 S2a PR1a: revoke/start is opened only by an existing passkey's assertion over a server-issued challenge. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../test/softPasskey.js';

const ORIGIN = 'https://sign.example.test';
let server: Server | undefined;
let base: string;
let key: SoftPasskey;
let passkeyId: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  const owner = await db.user.create({ data: { handle: 'revoke-owner', roles: [] } });
  key = softPasskey();
  passkeyId = await insertSoftPasskey(db, owner.id, key);
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

async function challenge(origin: string | null = ORIGIN) {
  const r = await fetch(`${base}/passkeys/revoke/challenge`, { method: 'POST', headers: origin ? { origin } : {} });
  if (r.status !== 200) return { status: r.status } as const;
  const { ceremonyId, challenge: ch } = await r.json() as { ceremonyId: string; challenge: string };
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: 200, ceremonyId, ch, cookie } as const;
}

function body(ceremonyId: string, ch: string, over: { counter?: number; origin?: string; uv?: boolean } = {}) {
  const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(ch, 'base64url'), origin: over.origin ?? ORIGIN, rpId: 'example.test', counter: over.counter ?? 1, uv: over.uv });
  return JSON.stringify({
    ceremonyId, credentialId: key.credentialId.toString('base64url'),
    authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
  });
}
const start = (b: string, cookie: string | undefined, origin: string | null = ORIGIN) => fetch(`${base}/passkeys/revoke/start`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: b,
});

describe('#1631 revoke/start proof by existing passkey', () => {
  it('accepts a UV assertion over the issued challenge from the cookie holder, mints no session, advances the counter', async () => {
    const c = await challenge();
    if (c.status !== 200) throw new Error('challenge refused');
    expect((c.cookie.length)).toBeGreaterThan(0);
    const r = await start(body(c.ceremonyId, c.ch), c.cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(1n);
  });

  it('is single-use: replaying the same proof is the uniform 403', async () => {
    const c = await challenge();
    if (c.status !== 200) throw new Error('challenge refused');
    const b = body(c.ceremonyId, c.ch);
    expect((await start(b, c.cookie)).status).toBe(200);
    expect((await start(b, c.cookie)).status).toBe(403);
  });

  it.each([
    ['another browser (no cookie)', (c: { cookie: string }) => ({ cookie: undefined as string | undefined, origin: ORIGIN, uv: undefined as boolean | undefined })],
    ['a different cookie value', () => ({ cookie: 'hadron_ceremony=forged', origin: ORIGIN, uv: undefined })],
    ['an unlisted Origin header', (c: { cookie: string }) => ({ cookie: c.cookie, origin: 'https://evil.example', uv: undefined })],
    ['no Origin header', (c: { cookie: string }) => ({ cookie: c.cookie, origin: null as string | null, uv: undefined })],
    ['an assertion without user verification', (c: { cookie: string }) => ({ cookie: c.cookie, origin: ORIGIN, uv: false })],
  ])('refuses %s with the uniform 403 and consumes nothing', async (_n, make) => {
    const c = await challenge();
    if (c.status !== 200) throw new Error('challenge refused');
    const o = make(c);
    const r = await start(body(c.ceremonyId, c.ch, { uv: o.uv }), o.cookie, o.origin);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    // The genuine holder can still use it.
    expect((await start(body(c.ceremonyId, c.ch), c.cookie)).status).toBe(200);
  });

  it('refuses a challenge request from an unlisted origin and when the allowlist is empty', async () => {
    expect((await challenge('https://evil.example')).status).toBe(403);
    expect((await challenge(null)).status).toBe(403);
    vi.stubEnv('SIGNING_CEREMONY_ORIGINS', '');
    expect((await challenge()).status).toBe(403);
  });

  it('refuses a revoked credential', async () => {
    const c = await challenge();
    if (c.status !== 200) throw new Error('challenge refused');
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id = ${passkeyId}`;
    expect((await start(body(c.ceremonyId, c.ch), c.cookie)).status).toBe(403);
  });

  it('keeps register/start refusing everyone, even with a valid proof', async () => {
    const c = await challenge();
    if (c.status !== 200) throw new Error('challenge refused');
    const r = await fetch(`${base}/passkeys/register/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: c.cookie }, body: body(c.ceremonyId, c.ch),
    });
    expect(r.status).toBe(403);
  });
});
