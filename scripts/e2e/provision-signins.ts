import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { generateKeyPair, SignJWT } from 'jose';
import type { PrismaClient } from '../../src/generated/prisma/index.js';
import { db as authDb } from '../../src/integrations/db/client.js';
import { mintProviderNonce } from '../../src/auth/providerNonce.js';
import { verifyGoogleIdToken, resolveGoogleUser } from '../../src/auth/google.js';
import { verifyAppleIdToken, resolveAppleUser } from '../../src/auth/apple.js';

export type SignInEvidence = Record<string, { path: string; isNew?: boolean }>;

// All transport stays on this process's loopback server. Local signing keys
// replace IdP JWKS only through the existing verifier's test injection seam.
export async function provisionSignIns(db: PrismaClient): Promise<SignInEvidence> {
  const evidence: SignInEvidence = {};
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  for (const provider of ['google', 'apple'] as const) {
    const handle = `${provider}-user`;
    const envName = `${provider.toUpperCase()}_CLIENT_ID`;
    const previous = process.env[envName];
    process.env[envName] = 'e2e-local-fixture';
    try {
      // #2204: the verifier requires the login's nonce back; mint one the way the start routes do.
      const { nonce, nonceHash } = mintProviderNonce();
      const token = await new SignJWT({ email: `${handle}@e2e.test`, email_verified: true, name: handle, nonce })
        .setProtectedHeader({ alg: 'RS256' }).setSubject(`synthetic-${provider}-subject`)
        .setIssuer(provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com')
        .setAudience('e2e-local-fixture').setIssuedAt().setExpirationTime('2m').sign(privateKey);
      const user = provider === 'google'
        ? await resolveGoogleUser(await verifyGoogleIdToken(token, { bound: nonceHash }, async () => publicKey))
        : await resolveAppleUser(await verifyAppleIdToken(token, { bound: nonceHash }, async () => publicKey), handle);
      assert.equal(user.identityProvider, provider.toUpperCase());
      assert.equal(user.handle, handle);
      evidence[handle] = { path: `${provider}-local-token` };
    } finally {
      if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
    }
  }

  const previousEmail = process.env.REVIEW_DEMO_EMAIL;
  const previousCode = process.env.REVIEW_DEMO_CODE;
  const reviewCode = randomBytes(24).toString('hex');
  process.env.REVIEW_DEMO_EMAIL = 'email-code-user@e2e.test';
  process.env.REVIEW_DEMO_CODE = reviewCode;
  // createServer also starts background sweeps outside test mode. This
  // short-lived seed server exercises routes only; no background jobs.
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const { createServer } = await import('../../src/server.js');
  const app = await createServer();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // Simulate delivery only: the real verify route creates the first-login
    // user and the real handoff route redeems its browser-bound login code.
    const clientState = randomBytes(24).toString('hex');
    const raw = randomBytes(32).toString('hex');
    await db.emailVerificationToken.create({ data: { email: 'fresh-user@e2e.test', token: raw,
      expiresAt: new Date(Date.now() + 120000), clientStateHash: createHash('sha256').update(clientState).digest('hex') } });
    const verified = await fetch(`${base}/auth/email/verify?token=${raw}`, { redirect: 'manual' });
    assert.equal(verified.status, 302);
    const code = new URL(verified.headers.get('location')!).searchParams.get('code');
    assert(code);
    const redeemed = await fetch(`${base}/auth/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, clientState }) });
    assert.equal(redeemed.status, 200);
    const session = await redeemed.json() as { token: string; isNew: boolean };
    assert.equal(session.isNew, true);
    const fresh = await db.user.findUniqueOrThrow({ where: { email: 'fresh-user@e2e.test' } });
    const identity = await graphqlIdentity(base, session.token);
    assert.equal(identity.id, fresh.id);
    assert.equal(await db.orgMember.count({ where: { userId: fresh.id } }), 0);
    assert.equal(await db.memory.count({ where: { OR: [{ userId: fresh.id }, { ownerUserId: fresh.id }, { createdBy: fresh.id }] } }), 0);
    evidence['fresh-user'] = { path: 'email-verify-and-handoff', isNew: true };

    // The only code-entry flow on main is REVIEW_DEMO for an existing account.
    // Exercise its CSRF form and actual signed cookie; never send real email.
    await db.oAuthClient.create({ data: { clientId: 'e2e-review', clientName: 'Synthetic E2E review',
      redirectUris: ['http://localhost:4000/e2e-callback'] } });
    const returnTo = '/oauth/authorize?' + new URLSearchParams({ client_id: 'e2e-review',
      redirect_uri: 'http://localhost:4000/e2e-callback', login_provider: 'email' });
    const jar = new Map<string, string>();
    const remember = (res: Response) => {
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]; jar.set(pair.split('=')[0], pair);
      }
    };
    const entry = await fetch(base + returnTo); assert.equal(entry.status, 200); remember(entry);
    let html = await entry.text();
    const csrf = () => {
      const value = html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1]; assert(value); return value;
    };
    const post = (path: string, fields: Record<string, string>) => fetch(base + path, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded',
        cookie: [...jar.values()].join('; ') }, body: new URLSearchParams(fields),
    });
    const codePage = await post('/oauth/authorize/email', { _csrf: csrf(), return_to: returnTo, email: 'email-code-user@e2e.test' });
    assert.equal(codePage.status, 200); remember(codePage); html = await codePage.text();
    const signed = await post('/oauth/authorize/email/code', { _csrf: csrf(), return_to: returnTo,
      email: 'email-code-user@e2e.test', code: reviewCode });
    assert.equal(signed.status, 302); remember(signed);
    const jwt = jar.get('hadron_token')?.slice('hadron_token='.length); assert(jwt);
    assert.equal((await graphqlIdentity(base, decodeURIComponent(jwt))).email, 'email-code-user@e2e.test');
    evidence['email-code-user'] = { path: 'review-demo-code' };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousEmail === undefined) delete process.env.REVIEW_DEMO_EMAIL; else process.env.REVIEW_DEMO_EMAIL = previousEmail;
    if (previousCode === undefined) delete process.env.REVIEW_DEMO_CODE; else process.env.REVIEW_DEMO_CODE = previousCode;
  }
  return evidence;
}
async function graphqlIdentity(base: string, token: string): Promise<{ id: string; email: string }> {
  const res = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: '{ me { id email } }' }) });
  assert.equal(res.status, 200);
  const body = await res.json(); assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data.me;
}
export async function disconnectSignInDb() { await authDb.$disconnect(); }
