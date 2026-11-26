/**
 * #4626 (S4 follow-ups, items 10 and 12): the APPROVE side of the ceremony route over real HTTP. Item 12: a full
 * approve (challenge -> proof -> complete) ends with a new version and a completed row — only decline had an end-to-end
 * pin (secretChangeDecline4703.test.ts). Item 10: a foreign Origin is refused with 403, changing nothing, on the
 * challenge, proof and complete legs (the decline route already has its own). Real express app on a real socket, a real
 * database, real software-passkey assertions; no production or provider calls.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { resolvers, type Context } from './graphql/schema/resolvers.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { mountSecretChangeCeremonyRoutes } from './secretChangeCeremonyRoutes.js';
import { currentAppSecretValue } from '../lib/secrets/appSecrets.js';

const RP = 'localhost', ORIGIN = 'http://localhost:4000', FOREIGN_ORIGIN = 'https://untrusted.invalid';
const key = softPasskey();
let userId: string, appId: string, secretId: string, server: Server | undefined, base = '';
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
const b64 = (b: Buffer) => b.toString('base64url');

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP); vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 approve route', urn: `${generateId().toLowerCase()}:s4a` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
  await insertSoftPasskey(db, userId, key, { rpId: RP });
  const app = express();
  mountSecretChangeCeremonyRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server!.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

/** One browser: the page's own cookie jar (the ceremony nonce) and its JSON POSTs, at a choosable Origin. */
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

describe('#4626 item 12: a full HTTP approve (challenge, proof, complete)', () => {
  it('ends with a new version, a completed row and no staged value left', async () => {
    const id = await stage(), b = browser(id);
    const challenge = await b.post('proof/challenge');
    expect(challenge.status).toBe(200);
    const proof = await b.post('proof', b.assertion(challenge.json));
    expect(proof.status).toBe(200);
    expect(proof.json).toMatchObject({ outcome: 'change' });
    expect(JSON.stringify(proof.json)).not.toContain('staged-canary');
    const done = await b.post('complete', b.assertion(proof.json));
    expect(done).toMatchObject({ status: 200, json: { ok: true } });
    expect(await state(id)).toMatchObject({ state: 'completed', staged_value_encrypted: null });
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(2);
    expect(await currentAppSecretValue(db as never, { id: secretId, ownerId: appId })).toBe('staged-canary');
  });
});

describe('#4626 item 10: a foreign Origin is refused on every approve leg, changing nothing', () => {
  it('proof/challenge answers 403 and opens no proof ceremony', async () => {
    const id = await stage(), b = browser(id);
    const res = await b.post('proof/challenge', {}, FOREIGN_ORIGIN);
    expect(res).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM passkey_ceremonies WHERE purpose='SECRET_CHANGE_PROOF'`)[0].n).toBe(0n);
    expect((await state(id)).state).toBe('open');
  });
  it('proof answers 403 even with a good assertion, and the request stays open', async () => {
    const id = await stage(), b = browser(id);
    const challenge = await b.post('proof/challenge');
    expect(challenge.status).toBe(200);
    const res = await b.post('proof', b.assertion(challenge.json), FOREIGN_ORIGIN);
    expect(res).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await state(id)).state).toBe('open');
  });
  it('complete answers 403, and neither a version nor a completion is written', async () => {
    const id = await stage(), b = browser(id);
    const proof = await b.post('proof', b.assertion((await b.post('proof/challenge')).json));
    expect(proof.status).toBe(200);
    const res = await b.post('complete', b.assertion(proof.json), FOREIGN_ORIGIN);
    expect(res).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
    expect((await state(id)).state).toBe('open');
    expect((await state(id)).staged_value_encrypted).toBeTruthy();
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
  });
});
