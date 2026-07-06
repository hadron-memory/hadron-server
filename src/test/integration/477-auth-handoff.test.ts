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
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { issueLoginCode } from '../../auth/authHandoff.js';
import { signJwt } from '../../auth/index.js';

let server: Server;
let baseUrl: string;
let userId: string;

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

  it('returns a nonce for a valid Bearer token', async () => {
    const jwt = await signJwt({ sub: userId, roles: ['READER'] });
    const res = await postJson(
      '/auth/microsoft/start',
      { orgId: 'o1', redirect: '/app/orgs/o1/integrations' },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string };
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /auth/email', () => {
  it('rejects a request with no clientState (#505 — no unbound codes)', async () => {
    // Without the request-time browser nonce the minted handoff code would be
    // unbound and transferable — the email session-fixation vector. Must 400
    // BEFORE sending anything.
    const res = await postJson('/auth/email', { email: 'a@example.test' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/client_state is required/);
  });

  it('rejects a request with no email', async () => {
    const res = await postJson('/auth/email', { clientState: 'n' });
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/email/verify', () => {
  async function insertEmailToken(clientStateHash: string | null): Promise<string> {
    const token = `evtok-${generateId()}`;
    await db.emailVerificationToken.create({
      data: {
        id: generateId(),
        email: `verify-${token}@example.test`,
        token,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        clientStateHash,
      },
    });
    return token;
  }

  it('rejects a token with no clientStateHash — no unbound code minted (#511 P2)', async () => {
    const token = await insertEmailToken(null);
    const res = await fetch(`${baseUrl}/auth/email/verify?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('a bound token redeems to a ?code= handoff (no token in URL)', async () => {
    const token = await insertEmailToken(createHash('sha256').update('nonce').digest('hex'));
    const res = await fetch(`${baseUrl}/auth/email/verify?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.pathname).toBe('/auth/callback');
    expect(loc.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
    expect(loc.searchParams.get('token')).toBeNull();
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
