// End-to-end smoke test for the D1b OAuth target. Skips the GitHub
// round-trip by minting a JWT directly and pasting it into the
// hadron_token cookie (the same JWT the GitHub callback would set).
//
// Walks: PRM discovery → AS metadata → /mcp 401 with WWW-Authenticate →
// /oauth/authorize (GET, with cookie) → consent POST → /oauth/token →
// use the minted hdr_user_ token against /mcp.

import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { signJwt } from '../src/auth/jwt.js';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4000';
const CLIENT_ID = 'test';
const REDIRECT_URI = 'http://localhost:9999/cb';
const RESOURCE = SERVER;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function main() {
  const db = new PrismaClient();

  // 1. PRM
  console.log('[1] GET /.well-known/oauth-protected-resource');
  const prmRes = await fetch(`${SERVER}/.well-known/oauth-protected-resource`);
  const prm = await prmRes.json() as any;
  console.log('   ', prm);
  if (!prm.authorization_servers?.length) throw new Error('PRM missing authorization_servers');

  // 2. AS metadata
  console.log('[2] GET /.well-known/oauth-authorization-server');
  const asRes = await fetch(`${SERVER}/.well-known/oauth-authorization-server`);
  const asMeta = await asRes.json() as any;
  console.log('   ', asMeta);
  if (asMeta.registration_endpoint) {
    throw new Error('AS metadata advertises registration_endpoint — DCR is skipped, this should be absent');
  }
  if (!asMeta.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('AS metadata missing S256');
  }

  // 3. /mcp 401 with WWW-Authenticate carrying PRM URL
  console.log('[3] POST /mcp (unauthenticated) — expect 401 with WWW-Authenticate');
  const mcpUnauthRes = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
  });
  console.log('    status:', mcpUnauthRes.status);
  const wwwAuth = mcpUnauthRes.headers.get('www-authenticate');
  console.log('    WWW-Authenticate:', wwwAuth);
  if (mcpUnauthRes.status !== 401) throw new Error('Expected 401');
  if (!wwwAuth?.includes('resource_metadata=')) {
    throw new Error('WWW-Authenticate missing resource_metadata pointer');
  }
  if (!wwwAuth.includes('/.well-known/oauth-protected-resource')) {
    throw new Error('WWW-Authenticate resource_metadata does not point at PRM URL');
  }

  // 4. Set up a server-domain session by minting a JWT for a real user
  //    (skips the GitHub round-trip — the cookie value is the same shape
  //    the GitHub callback would write).
  const user = await db.user.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) throw new Error('No users in dev DB');
  console.log(`[4] Using user ${user.id} (${user.handle ?? user.email})`);
  const jwt = await signJwt({
    sub: user.id,
    roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
    githubUsername: user.githubUsername ?? undefined,
    email: user.email ?? undefined,
    githubId: user.githubId ?? undefined,
  });
  const cookie = `hadron_token=${jwt}`;

  // 5. PKCE
  const { verifier, challenge } = pkce();
  console.log(`[5] PKCE: verifier=${verifier.slice(0, 12)}... challenge=${challenge.slice(0, 12)}...`);

  // 6. /oauth/authorize (GET) — expect consent HTML
  const authorizeUrl = new URL(`${SERVER}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', RESOURCE);
  authorizeUrl.searchParams.set('state', 'xyz123');

  console.log('[6] GET /oauth/authorize (with cookie) — expect consent HTML');
  const authGetRes = await fetch(authorizeUrl.toString(), {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  console.log('    status:', authGetRes.status, 'content-type:', authGetRes.headers.get('content-type'));
  if (authGetRes.status !== 200) {
    const body = await authGetRes.text();
    throw new Error(`Expected 200 HTML, got ${authGetRes.status}: ${body.slice(0, 300)}`);
  }
  const html = await authGetRes.text();
  if (!html.includes('Approve')) throw new Error('Consent HTML missing Approve button');

  // 7. POST /oauth/authorize with decision=approve
  console.log('[7] POST /oauth/authorize decision=approve — expect 302 with ?code=');
  const approveBody = new URLSearchParams({
    decision: 'approve',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    state: 'xyz123',
  });
  const approveRes = await fetch(`${SERVER}/oauth/authorize`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: approveBody,
    redirect: 'manual',
  });
  console.log('    status:', approveRes.status);
  const location = approveRes.headers.get('location');
  console.log('    Location:', location);
  if (approveRes.status !== 302 || !location) throw new Error('Expected 302 with Location header');
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get('code');
  const returnedState = redirectUrl.searchParams.get('state');
  if (!code) throw new Error('Redirect missing ?code=');
  if (returnedState !== 'xyz123') throw new Error('state echo mismatch');
  console.log(`    code: ${code.slice(0, 12)}... state-echoed: ${returnedState}`);

  // 8. POST /oauth/token
  console.log('[8] POST /oauth/token');
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  const tokenRes = await fetch(`${SERVER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  console.log('    status:', tokenRes.status);
  const tokenJson = await tokenRes.json() as any;
  console.log('    body:', { ...tokenJson, access_token: `${tokenJson.access_token?.slice(0, 15)}...` });
  if (tokenRes.status !== 200) throw new Error('Token exchange failed');
  if (!tokenJson.access_token?.startsWith('hdr_user_')) {
    throw new Error('access_token is not hdr_user_-prefixed');
  }
  if (tokenJson.token_type !== 'Bearer') throw new Error('token_type != Bearer');

  // 9. Use the token against /mcp
  console.log('[9] POST /mcp with OAuth-minted token — expect 200');
  const mcpAuthedRes = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${tokenJson.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'd1b-oauth-test', version: '0.0.1' },
      },
    }),
  });
  console.log('    status:', mcpAuthedRes.status);
  const mcpText = await mcpAuthedRes.text();
  console.log('    body (first 300):', mcpText.slice(0, 300));
  if (mcpAuthedRes.status !== 200) throw new Error('/mcp rejected the OAuth-minted token');

  // 10. Verify single-use: try to redeem the same code again
  console.log('[10] POST /oauth/token AGAIN with same code — expect 400 invalid_grant');
  const replayRes = await fetch(`${SERVER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  const replayJson = await replayRes.json() as any;
  console.log('    status:', replayRes.status, 'body:', replayJson);
  if (replayRes.status !== 400 || replayJson.error !== 'invalid_grant') {
    throw new Error('Code replay was NOT rejected — single-use violation');
  }

  await db.$disconnect();
  console.log('\nPASS: D1b OAuth target reachable end-to-end.');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
