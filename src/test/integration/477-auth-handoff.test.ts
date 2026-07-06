/**
 * #477 — session JWT out of URLs: endpoint contract for the handoff rewiring.
 *
 * Drives the real Express app over HTTP (like 025-auth-github-return-to):
 *   - POST /auth/session redeems a login code → { token, redirect, isNew } and
 *     rejects unknown / fixation-mismatched codes.
 *   - POST /auth/microsoft/start requires a Bearer JWT.
 *   - GET /auth/microsoft rejects a missing/invalid nonce (no JWT in the URL).
 *
 * The GitHub/email callbacks themselves aren't driven end-to-end here (they
 * exchange with external IdPs); the code-mint helpers are unit-tested in
 * src/auth/authHandoff.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { issueLoginCode } from '../../auth/authHandoff.js';
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
    data: { githubId: 47701, githubUsername: 'handoff-int', roles: ['READER'] },
  });
  userId = user.id;
  const org = await db.organization.create({ data: { name: 'exch-org', urn: 'exch-org' } });
  orgId = org.id;
  // The initiating user is an ADMIN of this org (the role /auth/microsoft/start
  // now requires, #506).
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
});

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

describe('POST /auth/session', () => {
  it('redeems a login code and returns a JWT in the body (never a URL)', async () => {
    const code = await issueLoginCode({ userId, redirect: '/app/setup', isNew: true });
    const res = await postJson('/auth/session', { code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; redirect: string; isNew: boolean };
    expect(body.redirect).toBe('/app/setup');
    expect(body.isNew).toBe(true);
    expect(body.token.split('.')).toHaveLength(3); // a JWT
  });

  it('rejects a missing code with 400', async () => {
    const res = await postJson('/auth/session', {});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown code with 400', async () => {
    const res = await postJson('/auth/session', { code: 'deadbeef'.repeat(8) });
    expect(res.status).toBe(400);
  });

  it('rejects a fixation-bound code when the clientState is wrong', async () => {
    const code = await issueLoginCode({
      userId,
      redirect: '/app',
      isNew: false,
      clientState: 'real-nonce',
    });
    const res = await postJson('/auth/session', { code, clientState: 'attacker-nonce' });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/microsoft/start', () => {
  it('401s without a Bearer token', async () => {
    const res = await postJson('/auth/microsoft/start', { orgId: 'o1' });
    expect(res.status).toBe(401);
  });

  it('returns a nonce for an org admin (#506)', async () => {
    const jwt = await signJwt({ sub: userId, roles: ['READER'] });
    const res = await postJson(
      '/auth/microsoft/start',
      { orgId, redirect: `/app/orgs/${orgId}/integrations` },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string };
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it('403s when the caller is not an admin of the target org (#506)', async () => {
    // A different org the caller has no membership in — attaching a mailbox
    // here would be a cross-tenant write.
    const otherOrg = await db.organization.create({ data: { name: 'other-org', urn: 'other-org' } });
    const jwt = await signJwt({ sub: userId, roles: ['READER'] });
    const res = await postJson(
      '/auth/microsoft/start',
      { orgId: otherOrg.id, redirect: '/' },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(403);
  });

  it('403s when the caller is only a non-admin member (#506)', async () => {
    // CONTRIBUTOR in an org — managing integrations requires ADMIN.
    const contributor = await db.user.create({
      data: { githubId: 47702, githubUsername: 'handoff-contrib', roles: ['READER'] },
    });
    await db.orgMember.create({ data: { organizationId: orgId, userId: contributor.id, role: 'CONTRIBUTOR' } });
    const jwt = await signJwt({ sub: contributor.id, roles: ['READER'] });
    const res = await postJson(
      '/auth/microsoft/start',
      { orgId, redirect: '/' },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /auth/microsoft', () => {
  it('rejects a missing nonce with 400 (no JWT-in-URL path anymore)', async () => {
    const res = await fetch(`${baseUrl}/auth/microsoft`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid nonce with 400', async () => {
    const res = await fetch(`${baseUrl}/auth/microsoft?nonce=nope`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });
});
