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

interface Issued { ceremonyId: string; ch: string; cookie: string }

async function challengeStatus(origin: string | null = ORIGIN) {
  return (await fetch(`${base}/passkeys/revoke/challenge`, { method: 'POST', headers: origin ? { origin } : {} })).status;
}

async function challenge(): Promise<Issued> {
  const r = await fetch(`${base}/passkeys/revoke/challenge`, { method: 'POST', headers: { origin: ORIGIN } });
  expect(r.status).toBe(200);
  const { ceremonyId, challenge: ch } = await r.json() as { ceremonyId: string; challenge: string };
  return { ceremonyId, ch, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
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
  it('accepts a UV assertion over the issued challenge from the cookie holder, mints no session, advances the counter, lists the owner\'s passkeys', async () => {
    const c = await challenge();
    expect((c.cookie.length)).toBeGreaterThan(0);
    const r = await start(body(c.ceremonyId, c.ch), c.cookie);
    expect(r.status).toBe(200);
    // #1631 PR3: the proof now binds a REVOKE ceremony and lists the owner's passkeys, the prover marked.
    const { passkeys } = await r.json() as { passkeys: Array<{ credentialId: string; prover: boolean }> };
    expect(passkeys).toEqual([expect.objectContaining({ credentialId: key.credentialId.toString('base64url'), prover: true })]);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(1n);
  });

  it('is single-use: replaying the same proof is the uniform 403', async () => {
    const c = await challenge();
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
    const o = make(c);
    const r = await start(body(c.ceremonyId, c.ch, { uv: o.uv }), o.cookie, o.origin);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    // The genuine holder can still use it.
    expect((await start(body(c.ceremonyId, c.ch), c.cookie)).status).toBe(200);
  });

  it('refuses a challenge request from an unlisted origin and when the allowlist is empty', async () => {
    expect(await challengeStatus('https://evil.example')).toBe(403);
    expect(await challengeStatus(null)).toBe(403);
    vi.stubEnv('SIGNING_CEREMONY_ORIGINS', '');
    expect(await challengeStatus()).toBe(403);
  });

  it('refuses a revoked credential', async () => {
    const c = await challenge();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id = ${passkeyId}`;
    expect((await start(body(c.ceremonyId, c.ch), c.cookie)).status).toBe(403);
  });

  it('refuses a valid assertion from a retained credential of a soft-deleted owner, consuming nothing', async () => {
    const c = await challenge();
    await db.$executeRaw`UPDATE users SET deleted_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id = (SELECT owner_id FROM passkey_credentials WHERE id = ${passkeyId})`;
    const r = await start(body(c.ceremonyId, c.ch), c.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    const [row] = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`SELECT consumed_at FROM passkey_ceremonies WHERE id = ${c.ceremonyId}`;
    expect(row.consumed_at).toBeNull();
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(0n);
  });

  it('refuses a credential enrolled under another RP ID, even with a valid assertion for this one, consuming nothing (#1631 PR1b)', async () => {
    const owner = await db.user.create({ data: { handle: 'moved-owner', roles: [] } });
    const moved = softPasskey();
    const movedId = await insertSoftPasskey(db, owner.id, moved, { rpId: 'old.example' });
    const c = await challenge();
    const a = moved.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(c.ch, 'base64url'), origin: ORIGIN, rpId: 'example.test', counter: 1 });
    const r = await start(JSON.stringify({
      ceremonyId: c.ceremonyId, credentialId: moved.credentialId.toString('base64url'),
      authenticatorData: a.authenticatorData.toString('base64url'), clientDataJson: a.clientDataJson.toString('base64url'), signature: a.signature.toString('base64url'),
    }), c.cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
    const [row] = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`SELECT consumed_at FROM passkey_ceremonies WHERE id = ${c.ceremonyId}`;
    expect(row.consumed_at).toBeNull();
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: movedId } })).counter).toBe(0n);
  });

  it('keeps register/start refusing everyone, even with a valid proof', async () => {
    const c = await challenge();
    const r = await fetch(`${base}/passkeys/register/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: c.cookie }, body: body(c.ceremonyId, c.ch),
    });
    expect(r.status).toBe(403);
  });
});
