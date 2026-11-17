/** Restricted #1794: synthetic HTTP boundary regression; details in restricted evidence. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { hashAppKey } from '../../middleware/auth.js';
import { signJwt } from '../../auth/jwt.js';

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });
beforeEach(async () => { await cleanDb(db); });
const post = (path: string, body: unknown, token?: string) => fetch(baseUrl + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body), redirect: 'manual',
});

describe('restricted #1794 HTTP regression', () => {
  it('keeps independent identities separate through the actual profile and login routes', async () => {
    const original = await db.user.create({ data: { handle: 'security1794-original', githubId: 1794001, identityProvider: 'GITHUB', roles: ['READER'] } });
    const bearer = await signJwt({ sub: original.id, roles: ['READER'] });
    const email = 'fresh@security1794.test';
    const edited = await post('/graphql', { query: 'mutation($email:String){updateMyProfile(email:$email){id email}}', variables: { email } }, bearer);
    const profile = await edited.json() as { errors?: { extensions?: { code?: string } }[] };
    expect.soft(profile.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect.soft((await db.user.findUniqueOrThrow({ where: { id: original.id } })).email).toBeNull();

    // Synthetic inbox delivery: a real single-use token, no mail provider mock.
    const clientState = 'security1794-browser-nonce';
    const token = 'security1794-magic-link';
    await db.emailVerificationToken.create({ data: { email, token, expiresAt: new Date(Date.now() + 60000), clientStateHash: createHash('sha256').update(clientState).digest('hex') } });
    const verified = await fetch(`${baseUrl}/auth/email/verify?token=${token}`, { redirect: 'manual' });
    expect(verified.status).toBe(302);
    const code = new URL(verified.headers.get('location')!, baseUrl).searchParams.get('code');
    expect(code).toBeTruthy();
    const redeemed = await post('/auth/session', { code, clientState });
    expect(redeemed.status).toBe(200);
    const session = await redeemed.json() as { token: string; isNew: boolean };
    const me = await fetch(baseUrl + '/auth/me', { headers: { authorization: `Bearer ${session.token}` } });
    expect(me.status).toBe(200);
    const current = await me.json() as { id: string; email: string };
    expect(current.id).not.toBe(original.id);
    expect(current.email).toBe(email);
    expect(session.isNew).toBe(true);
    const stillOriginal = await fetch(baseUrl + '/auth/me', { headers: { authorization: `Bearer ${bearer}` } });
    expect((await stillOriginal.json() as { id: string }).id).toBe(original.id);
  });
  it('keeps ordinary existing-account sign-in unchanged', async () => {
    const email = 'existing@security1794.test';
    const original = await db.user.create({ data: { handle: 'security1794-existing', email, identityProvider: 'EMAIL', roles: ['READER'] } });
    const clientState = 'security1794-existing-browser';
    const token = 'security1794-existing-link';
    await db.emailVerificationToken.create({ data: { email, token, expiresAt: new Date(Date.now() + 60000), clientStateHash: createHash('sha256').update(clientState).digest('hex') } });
    const verified = await fetch(`${baseUrl}/auth/email/verify?token=${token}`, { redirect: 'manual' });
    expect(verified.status).toBe(302);
    const code = new URL(verified.headers.get('location')!, baseUrl).searchParams.get('code');
    const redeemed = await post('/auth/session', { code, clientState });
    expect(redeemed.status).toBe(200);
    const session = await redeemed.json() as { token: string; isNew: boolean };
    const me = await fetch(baseUrl + '/auth/me', { headers: { authorization: `Bearer ${session.token}` } });
    expect((await me.json() as { id: string }).id).toBe(original.id);
    expect(session.isNew).toBe(false);
  });

  it('keeps app-provisioned and verified identities separate at the HTTP boundary', async () => {
    const owner = await db.user.create({ data: { handle: 'security1794-app-owner', roles: ['READER'] } });
    const app = await db.app.create({ data: { name: 'Security fixture', urn: 'security1794-app-owner:fixture', ownerUserId: owner.id } });
    // SYNTHETIC: a made-up App key, shaped like a real one so the key-hash path is exercised. Not a credential.
    const key = 'hdr_app_security1794syntheticfixture';
    await db.appKey.create({ data: { appId: app.id, keyHash: hashAppKey(key), keyPreview: key.slice(-4) } });
    const email = 'app-fresh@security1794.test';
    const edited = await post('/graphql', { query: 'mutation($email:String){createAppUser(externalId:"fixture",email:$email){id email}}', variables: { email } }, key);
    const response = await edited.json() as { errors?: { extensions?: { code?: string } }[] };
    expect.soft(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const claimed = await db.user.findFirst({ where: { externalAppId: app.id, externalId: 'fixture' } });
    expect.soft(claimed).toBeNull();

    const clientState = 'security1794-app-browser';
    const token = 'security1794-app-link';
    await db.emailVerificationToken.create({ data: { email, token, expiresAt: new Date(Date.now() + 60000), clientStateHash: createHash('sha256').update(clientState).digest('hex') } });
    const verified = await fetch(baseUrl + '/auth/email/verify?token=' + token, { redirect: 'manual' });
    expect(verified.status).toBe(302);
    const code = new URL(verified.headers.get('location')!, baseUrl).searchParams.get('code');
    const redeemed = await post('/auth/session', { code, clientState });
    expect(redeemed.status).toBe(200);
    const session = await redeemed.json() as { token: string; isNew: boolean };
    const me = await fetch(baseUrl + '/auth/me', { headers: { authorization: 'Bearer ' + session.token } });
    const current = await me.json() as { id: string };
    expect(current.id).not.toBe(claimed?.id);
    expect(session.isNew).toBe(true);

    const ordinary = await post('/graphql', { query: 'mutation{createAppUser(externalId:"ordinary",name:"Fixture"){id email}}' }, key);
    const ordinaryResult = await ordinary.json() as { data?: { createAppUser: { id: string; email: string | null } }; errors?: unknown };
    expect(ordinaryResult.errors).toBeUndefined();
    expect(ordinaryResult.data?.createAppUser.email).toBeNull();
    const repeated = await post('/graphql', { query: 'mutation{createAppUser(externalId:"ordinary"){id}}' }, key);
    expect((await repeated.json() as { data: { createAppUser: { id: string } } }).data.createAppUser.id).toBe(ordinaryResult.data?.createAppUser.id);
  });

});
