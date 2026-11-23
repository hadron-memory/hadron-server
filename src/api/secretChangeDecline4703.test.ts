/**
 * #4703 (BLIND P2 on #4798): the decline route's HAPPY path, end to end over real HTTP. A real express app on a real socket, a real
 * database, real software-passkey assertions: proof challenge -> proof -> decline, with the cookie nonce the page itself carries.
 * A miswired `decline` branch (or a route that is mounted but answers 403 for a good request) fails here; the page model and the
 * service tests alone could not see it.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { resolvers, type Context } from './graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { mountSecretChangeCeremonyRoutes } from './secretChangeCeremonyRoutes.js';

const RP = 'localhost', ORIGIN = 'http://localhost:4000';
const key = softPasskey();
let userId: string, appId: string, secretId: string, server: Server | undefined, base = '';
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
const b64 = (b: Buffer) => b.toString('base64url');

beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '22'.repeat(32); process.env.PASSKEY_SIGNING_ENABLED = 'true';
  process.env.PASSKEY_RP_ID = RP; process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 decline route', urn: `${generateId().toLowerCase()}:s4r` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
  await insertSoftPasskey(db, userId, key, { rpId: RP });
  const app = express();
  mountSecretChangeCeremonyRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server!.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

/** One browser: the page's own cookie jar (the ceremony nonce) and its JSON POSTs. */
function browser(id: string) {
  let cookie = '';
  const post = async (op: string, body: unknown = {}, origin: string | null = ORIGIN) => {
    const res = await fetch(`${base}/secret-changes/${id}/${op}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json() as any };
  };
  const assertion = (opt: { ceremonyId: string; challenge: string }) => {
    const a = key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(opt.challenge, 'base64url'), origin: ORIGIN, rpId: RP });
    return { ceremonyId: opt.ceremonyId, credentialId: b64(key.credentialId), authenticatorData: b64(a.authenticatorData), clientDataJson: b64(a.clientDataJson), signature: b64(a.signature) };
  };
  return { post, assertion };
}
const stage = async () => (await error(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged-canary' }, ctx()))).extensions.requestId as string;
const state = async (id: string) => (await db.$queryRaw<Array<{ state: string; staged_value_encrypted: string | null }>>`SELECT state, staged_value_encrypted FROM secret_change_requests WHERE id=${id}`)[0];

describe('#4703 POST /secret-changes/:id/decline over real HTTP', () => {
  it('proof challenge -> proof -> decline: the request is declined, the staged value cleared, and the page is told ok', async () => {
    const id = await stage(), b = browser(id);
    const challenge = await b.post('proof/challenge');
    expect(challenge.status).toBe(200);
    const proof = await b.post('proof', b.assertion(challenge.json));
    expect(proof.status).toBe(200);
    expect(proof.json).toMatchObject({ outcome: 'change', decline: { ceremonyId: expect.any(String), challenge: expect.any(String) } });
    expect(JSON.stringify(proof.json)).not.toContain('staged-canary');
    // The page asserts the decline ceremony with the proof response's rpId, exactly as its script does.
    const declined = await b.post('decline', b.assertion(proof.json.decline));
    expect(declined).toMatchObject({ status: 200, json: { ok: true } });
    expect(await state(id)).toMatchObject({ state: 'declined', staged_value_encrypted: null });
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });

  it('a second decline over HTTP is the uniform 403 and changes nothing', async () => {
    const id = await stage(), b = browser(id);
    const proof = await b.post('proof', b.assertion((await b.post('proof/challenge')).json));
    const body = b.assertion(proof.json.decline);
    expect((await b.post('decline', body)).status).toBe(200);
    const again = await b.post('decline', body);
    expect(again).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await state(id)).state).toBe('declined');
  });

  it('the APPROVE ceremony cannot be sent to the decline route', async () => {
    const id = await stage(), b = browser(id);
    const proof = await b.post('proof', b.assertion((await b.post('proof/challenge')).json));
    const wrong = await b.post('decline', b.assertion(proof.json));
    expect(wrong).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await state(id)).state).toBe('open');
  });

  it('a decline without the page\'s Origin is refused before anything is judged', async () => {
    const id = await stage(), b = browser(id);
    const proof = await b.post('proof', b.assertion((await b.post('proof/challenge')).json));
    const res = await b.post('decline', b.assertion(proof.json.decline), null);
    expect(res).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await state(id)).state).toBe('open');
  });

  it('a decline from an Origin the ceremony does not trust is refused, even with a good assertion', async () => {
    const id = await stage(), b = browser(id);
    const proof = await b.post('proof', b.assertion((await b.post('proof/challenge')).json));
    const res = await b.post('decline', b.assertion(proof.json.decline), 'https://untrusted.invalid');
    expect(res).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await state(id)).state).toBe('open');
  });
});
