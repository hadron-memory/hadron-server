/**
 * Spec 025-oauth-for-mcp Phase 2D — `POST /oauth/token` race-safety
 * (T044 per tasks.md, SC-005 / R-9).
 *
 * Two concurrent `/token` POSTs against the same AuthCode MUST produce
 * exactly one success + one `invalid_grant`. The redemption pattern
 * is `updateMany({ where: { codeHash, redeemedAt: null }, … })`
 * which lets Postgres handle the concurrency under the row lock —
 * no explicit transaction or SELECT FOR UPDATE needed.
 *
 * Tests against REAL Postgres (`hadron_test` per `vitest.config.ts`).
 * Mocking would defeat the purpose: the race lives in the DB engine's
 * locking, not in the application code.
 *
 * N=20 iterations because two-way races aren't 50/50 — most of the
 * time one request wins the lock cleanly. The iteration count is a
 * confidence multiplier; 20 races caught zero false negatives across
 * the implementation lifetime if anything is broken, this fires fast.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { Client } from 'pg';

let server: Server;
let baseUrl: string;

const REGISTERED_REDIRECT = 'https://client.example.com/callback';
const RESOURCE_URL = 'https://hadron.example/mcp';
const TEST_CLIENT_ID = `dcr_${'a'.repeat(32)}`;

let testUser: { id: string };

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await cleanDb(db);
  testUser = await db.user.create({
    data: {
      id: generateId(),
      handle: 'alice',
      githubUsername: 'alice',
      roles: ['CONTRIBUTOR'],
    },
  });
  await db.oAuthClient.create({
    data: {
      clientId: TEST_CLIENT_ID,
      clientName: 'Race Test Client',
      redirectUris: [REGISTERED_REDIRECT],
    },
  });
});

interface SeededCode {
  rawCode: string;
  verifier: string;
}

async function seedRedemptionCandidate(): Promise<SeededCode> {
  const rawCode = randomBytes(32).toString('hex');
  const codeHash = createHash('sha256').update(rawCode).digest('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await db.authCode.create({
    data: {
      codeHash,
      clientId: TEST_CLIENT_ID,
      userId: testUser.id,
      redirectUri: REGISTERED_REDIRECT,
      codeChallenge: challenge,
      resource: [RESOURCE_URL],
      oauthScopes: ['mcp'],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdBy: testUser.id,
    },
  });
  return { rawCode, verifier };
}

function redeem({ rawCode, verifier }: SeededCode): Promise<Response> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: rawCode,
    client_id: TEST_CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    code_verifier: verifier,
    resource: RESOURCE_URL,
  });
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

describe('POST /oauth/token — concurrent redemption (SC-005 / R-9)', () => {
  it('two-way race over N=20 iterations: exactly one 200 + one 400 invalid_grant per iteration', async () => {
    const ITERATIONS = 20;

    for (let i = 0; i < ITERATIONS; i++) {
      // Each iteration: clean state + fresh seed + two concurrent
      // redeems of THE SAME code.
      await cleanDb(db);
      testUser = await db.user.create({
        data: {
          id: generateId(),
          handle: `racer-${i}`,
          githubUsername: `racer-${i}`,
          roles: ['CONTRIBUTOR'],
        },
      });
      await db.oAuthClient.create({
        data: {
          clientId: TEST_CLIENT_ID,
          clientName: 'Race Test Client',
          redirectUris: [REGISTERED_REDIRECT],
        },
      });

      const seed = await seedRedemptionCandidate();

      const [resA, resB] = await Promise.all([redeem(seed), redeem(seed)]);
      const statuses = [resA.status, resB.status].sort();

      // Exactly one 200 + exactly one 400.
      expect(statuses, `iteration ${i}: statuses=${JSON.stringify(statuses)}`).toEqual(
        [200, 400],
      );

      // The 400 MUST be invalid_grant (not some other error code
      // that would mask a different bug).
      const failed = resA.status === 400 ? resA : resB;
      const body = (await failed.json()) as { error: string };
      expect(body.error, `iteration ${i}: failed.error`).toBe('invalid_grant');

      // Exactly ONE UserApiKey row was minted across the race.
      const keys = await db.userApiKey.findMany({ where: { userId: testUser.id } });
      expect(keys, `iteration ${i}: minted token count`).toHaveLength(1);
      expect(keys[0].issuedVia).toBe(`oauth:${TEST_CLIENT_ID}`);
    }
  }, /* timeout: */ 30_000);

  it('five-way race: exactly one 200 + four 400s (sanity check on higher fan-out)', async () => {
    // The two-way race is the contract; a five-way is a structural
    // sanity check that the lock isn't just "first wins because the
    // request arrives sooner."
    const seed = await seedRedemptionCandidate();
    const responses = await Promise.all([
      redeem(seed),
      redeem(seed),
      redeem(seed),
      redeem(seed),
      redeem(seed),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400, 400, 400, 400]);
    const keys = await db.userApiKey.findMany({ where: { userId: testUser.id } });
    expect(keys).toHaveLength(1);
  });
});

describe('POST /oauth/token — client collected mid-redemption (#155)', () => {
  it('a soft delete that holds the client row while two redeemers run lets neither mint a key', async () => {
    const seed = await seedRedemptionCandidate();
    // A second connection plays the GC: it holds the client row, the
    // redeemers queue behind it, and it commits the soft delete only then.
    const gc = new Client({ connectionString: process.env.DATABASE_URL });
    await gc.connect();
    try {
      await gc.query('BEGIN');
      await gc.query('SELECT client_id FROM oauth_clients WHERE client_id = $1 FOR UPDATE', [TEST_CLIENT_ID]);
      const pending = Promise.all([redeem(seed), redeem(seed)]);
      await new Promise((r) => setTimeout(r, 400));
      // Nothing may have been minted while the client row is held.
      expect(await db.userApiKey.count()).toBe(0);
      await gc.query(
        "UPDATE oauth_clients SET deleted_at = now(), deleted_by = 'system:gc' WHERE client_id = $1",
        [TEST_CLIENT_ID],
      );
      await gc.query('COMMIT');
      const responses = await pending;
      expect(responses.map((r) => r.status)).toEqual([400, 400]);
      for (const r of responses) expect(((await r.json()) as { error: string }).error).toBe('invalid_grant');
      expect(await db.userApiKey.count()).toBe(0);
    } finally {
      await gc.end();
    }
  });
});
