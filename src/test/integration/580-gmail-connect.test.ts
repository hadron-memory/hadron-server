/**
 * #580 — Gmail mailbox-connect wiring: endpoint contract for the /auth/gmail
 * trio mounted through the shared mailboxConnect module.
 *
 * Drives the real Express app over HTTP (sibling of 477-auth-handoff, which
 * covers the Microsoft flavor of the same shared trio):
 *   - POST /auth/gmail/start requires a Bearer JWT + org ADMIN (#506) and
 *     answers 503 while GMAIL_CLIENT_ID is unset (fails safe, #583 posture).
 *   - GET /auth/gmail rejects a missing/invalid nonce, and redirects to
 *     Google's consent screen with access_type=offline&prompt=consent (the
 *     refresh-token prerequisites) when configured.
 *
 * The callback isn't driven end-to-end (it exchanges with Google via the
 * provider tool); its shared implementation is exercised by the Microsoft
 * tests + the tool's own suite.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { confirmConnect } from '../connectInterstitial.js';
import { issueExchangeStartNonce } from '../../auth/authHandoff.js';
import { signJwt } from '../../auth/index.js';

let server: Server;
let baseUrl: string;
let userId: string;
let orgId: string;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({
    data: { githubId: 58001, githubUsername: 'gmail-connect-int', roles: ['READER'] },
  });
  userId = user.id;
  const org = await db.organization.create({ data: { name: 'gmail-org', urn: 'gmail-org' } });
  orgId = org.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
});

afterEach(() => {
  delete process.env.GMAIL_CLIENT_ID;
});

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

describe('POST /auth/gmail/start', () => {
  it('401s without a Bearer token', async () => {
    const res = await postJson('/auth/gmail/start', { orgId });
    expect(res.status).toBe(401);
  });

  it('returns a nonce for an org admin (#506)', async () => {
    const jwt = await signJwt({ sub: userId, roles: ['READER'] });
    const res = await postJson(
      '/auth/gmail/start',
      { orgId, redirect: `/app/orgs/${orgId}/integrations` },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string };
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it('403s when the caller is not an admin of the target org (#506)', async () => {
    const otherOrg = await db.organization.create({ data: { name: 'other-org', urn: 'other-org' } });
    const jwt = await signJwt({ sub: userId, roles: ['READER'] });
    const res = await postJson(
      '/auth/gmail/start',
      { orgId: otherOrg.id, redirect: '/' },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(403);
  });

  it('503s while GMAIL_CLIENT_ID is unset (fails safe until #583-style provisioning)', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const jwt = await signJwt({ sub: userId, roles: ['READER'] });
    const res = await postJson('/auth/gmail/start', { orgId }, { authorization: `Bearer ${jwt}` });
    expect(res.status).toBe(503);
  });
});

describe('GET /auth/gmail', () => {
  it('rejects a missing nonce with 400 (no JWT-in-URL path, #477)', async () => {
    const res = await fetch(`${baseUrl}/auth/gmail`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid nonce with 400', async () => {
    const res = await fetch(`${baseUrl}/auth/gmail?nonce=nope`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('503s while GMAIL_CLIENT_ID is unset — WITHOUT burning the nonce', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const nonce = await issueExchangeStartNonce({ userId, orgId, redirect: '/', provider: 'gmail' });
    const res = await fetch(`${baseUrl}/auth/gmail?nonce=${nonce}`, { redirect: 'manual' });
    expect(res.status).toBe(503);

    // The nonce survives the misconfiguration and works once configured.
    process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
    const retry = await confirmConnect(`${baseUrl}/auth/gmail?nonce=${nonce}`);
    expect(retry.status).toBe(302);
  });

  it('rejects a nonce minted for a DIFFERENT provider (provider-bound, no cross-redemption)', async () => {
    const msNonce = await issueExchangeStartNonce({ userId, orgId, redirect: '/', provider: 'ms-exchange' });
    const res = await fetch(`${baseUrl}/auth/gmail?nonce=${msNonce}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('redirects to Google consent with the refresh-token prerequisites', async () => {
    const nonce = await issueExchangeStartNonce({ userId, orgId, redirect: '/app', provider: 'gmail' });
    const res = await confirmConnect(`${baseUrl}/auth/gmail?nonce=${nonce}`);
    expect(res.status).toBe(302);

    const loc = new URL(res.headers.get('location') as string);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('client_id')).toBe('gmail-client-id.apps.googleusercontent.example');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('prompt')).toBe('consent');
    expect(loc.searchParams.get('redirect_uri')).toMatch(/\/auth\/gmail\/callback$/);
    expect(loc.searchParams.get('scope')).toContain('gmail.modify');
    expect(loc.searchParams.get('scope')).toContain('gmail.send');
    expect(loc.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    // The single-use nonce is burnt.
    const replay = await fetch(`${baseUrl}/auth/gmail?nonce=${nonce}`, { redirect: 'manual' });
    expect(replay.status).toBe(400);
  });
});
