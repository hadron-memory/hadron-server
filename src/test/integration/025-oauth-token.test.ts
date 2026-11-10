/**
 * Spec 025-oauth-for-mcp Phase 2D — `POST /oauth/token` integration
 * tests (T043 per tasks.md).
 *
 * Closes the OAuth dance. Every test seeds an `AuthCode` row directly
 * (rather than walking through the consent UI) so this file isolates
 * the token-redemption surface from the consent-flow surface. The
 * cross-format parity check (issued OAuth token validates via the
 * same middleware as a portal-minted key, FR-015 + SC-001) lives
 * here too — it's the only file that has both ends.
 *
 * Race-safety is a separate file (`025-oauth-token-race.test.ts`,
 * T044) because it needs N=20 iterations and ~Postgres-roundtrip
 * setup per iteration; keeping it isolated stops it from inflating
 * this file's runtime.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import {
  resolveAuthContext,
  USER_API_KEY_PREFIX,
} from '../../middleware/auth.js';

// ── Test fixtures + helpers ──────────────────────────────────────────

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
      clientName: 'Test MCP Client',
      redirectUris: [REGISTERED_REDIRECT],
    },
  });
});

/**
 * Build a PKCE pair — a 43-char base64url verifier + its derived
 * S256 challenge. Two callers per test (`/authorize` writes the
 * challenge, `/token` submits the verifier), but we only need the
 * verifier+challenge tuple at the test level.
 */
function buildPkcePair(): { verifier: string; challenge: string } {
  // 32 bytes → 43-char base64url (the minimum valid length per RFC
  // 7636 §4.1). Matches the consent flow's typical client output.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Seed an AuthCode row directly. Returns the raw code (handed to the
 * "client" in our test scenario) + the verifier (used to redeem) +
 * the AuthCode row id (for state assertions).
 */
async function seedAuthCode(
  overrides: {
    expiresInMs?: number;
    redeemedAt?: Date | null;
    resource?: string[];
    clientId?: string;
    redirectUri?: string;
    oauthScopes?: string[];
  } = {},
): Promise<{
  rawCode: string;
  codeHash: string;
  verifier: string;
  challenge: string;
  authCodeId: string;
}> {
  const rawCode = randomBytes(32).toString('hex');
  const codeHash = createHash('sha256').update(rawCode).digest('hex');
  const { verifier, challenge } = buildPkcePair();
  const row = await db.authCode.create({
    data: {
      codeHash,
      clientId: overrides.clientId ?? TEST_CLIENT_ID,
      userId: testUser.id,
      redirectUri: overrides.redirectUri ?? REGISTERED_REDIRECT,
      codeChallenge: challenge,
      resource: overrides.resource ?? [RESOURCE_URL],
      oauthScopes: overrides.oauthScopes ?? ['mcp'],
      expiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 10 * 60 * 1000)),
      redeemedAt: overrides.redeemedAt ?? null,
      createdBy: testUser.id,
    },
  });
  return { rawCode, codeHash, verifier, challenge, authCodeId: row.id };
}

/**
 * POST /oauth/token with form-urlencoded body. Defaults a valid set
 * of fields; per-call overrides via `fields`.
 */
async function postToken(fields: Record<string, string | undefined>): Promise<Response> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) params.set(k, v);
  }
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

function defaultFields(
  rawCode: string,
  verifier: string,
): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code: rawCode,
    client_id: TEST_CLIENT_ID,
    redirect_uri: REGISTERED_REDIRECT,
    code_verifier: verifier,
    resource: RESOURCE_URL,
  };
}

async function assertCodeRedeemed(authCodeId: string): Promise<void> {
  const row = await db.authCode.findUniqueOrThrow({ where: { id: authCodeId } });
  expect(row.redeemedAt).not.toBeNull();
}

async function assertCodeNotRedeemed(authCodeId: string): Promise<void> {
  const row = await db.authCode.findUniqueOrThrow({ where: { id: authCodeId } });
  expect(row.redeemedAt).toBeNull();
}

// ── Happy path + RFC 6749 §5.1 response shape ────────────────────────

describe('POST /oauth/token — happy path', () => {
  it('mints a hdr_user_<…> token + marks the code redeemed', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      access_token: expect.stringMatching(
        new RegExp(`^${USER_API_KEY_PREFIX}[0-9a-f]{64}$`),
      ),
      token_type: 'Bearer',
      scope: 'mcp',
    });
    // RFC 6749 §5.1: don't emit expires_in (long-lived per
    // D-2026-05-17-001) and don't emit refresh_token (out of scope).
    expect(body.expires_in).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();

    await assertCodeRedeemed(authCodeId);

    // Issued UserApiKey row carries the FR-015 audit fields.
    const keys = await db.userApiKey.findMany({ where: { userId: testUser.id } });
    expect(keys).toHaveLength(1);
    expect(keys[0].issuedVia).toBe(`oauth:${TEST_CLIENT_ID}`);
    expect(keys[0].createdBy).toBe(testUser.id);
    expect(keys[0].label).toBe('OAuth: Test MCP Client');
    expect(keys[0].oauthScopes).toEqual(['mcp']);
    // REV-5 carries over to UserApiKey: only the hash is stored.
    expect(keys[0].keyHash).toBe(
      createHash('sha256').update(body.access_token as string).digest('hex'),
    );
  });

  it('copies an account grant unchanged to the key and token response', async () => {
    const { rawCode, verifier } = await seedAuthCode({ oauthScopes: ['account'] });
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ scope: 'account' });
    const key = await db.userApiKey.findFirstOrThrow({ where: { userId: testUser.id } });
    expect(key.oauthScopes).toEqual(['account']);
  });

  it('falls back to clientId in the label when clientName is empty', async () => {
    await db.oAuthClient.update({
      where: { clientId: TEST_CLIENT_ID },
      data: { clientName: '' },
    });
    const { rawCode, verifier } = await seedAuthCode();
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(200);
    const keys = await db.userApiKey.findMany({ where: { userId: testUser.id } });
    expect(keys[0].label).toBe(`OAuth: ${TEST_CLIENT_ID}`);
  });

  it('caps the OAuth label at USER_API_KEY_LABEL_MAX_LEN (defense in depth)', async () => {
    // DCR (PR #154) caps client_name at 200 chars, so today the
    // OAuth label is implicitly bounded. The label cap at the
    // OAuth call site is defense in depth: if a future change
    // relaxes DCR's cap (or a row is written via direct SQL), the
    // OAuth label should still stay bounded. Force a 500-char
    // clientName via direct DB update — bypassing DCR — to pin the
    // call-site cap.
    const longName = 'x'.repeat(500);
    await db.oAuthClient.update({
      where: { clientId: TEST_CLIENT_ID },
      data: { clientName: longName },
    });
    const { rawCode, verifier } = await seedAuthCode();
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(200);
    const keys = await db.userApiKey.findMany({ where: { userId: testUser.id } });
    // 200 is USER_API_KEY_LABEL_MAX_LEN; the "OAuth: " prefix counts.
    expect(keys[0].label!.length).toBeLessThanOrEqual(200);
    expect(keys[0].label!.startsWith('OAuth: ')).toBe(true);
  });

  it('the issued token validates via resolveUserApiKey (FR-015 / SC-001 cross-format parity)', async () => {
    // The whole point of FR-015 is that an OAuth-minted token and a
    // portal-minted token are byte-identical at the credential layer:
    // both flow through the same hash → same DB row shape → same
    // resolveUserApiKey path. This test threads an OAuth-minted
    // token through resolveAuthContext to prove it.
    const { rawCode, verifier } = await seedAuthCode();
    const tokenRes = await postToken(defaultFields(rawCode, verifier));
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken } = (await tokenRes.json()) as {
      access_token: string;
    };
    const fakeReq = {
      headers: { authorization: `Bearer ${accessToken}` },
    } as unknown as Request;
    const ctx = await resolveAuthContext(fakeReq, db);
    expect(ctx.userId).toBe(testUser.id);
    expect(ctx.clientId).toBe('github:alice');
    expect(ctx.roles).toEqual(['CONTRIBUTOR']);
    expect(ctx.oauthScopes).toEqual(['mcp']);
  });
});

// ── Invalid grant_type / unknown code / already redeemed ─────────────

describe('POST /oauth/token — grant_type + code lookup', () => {
  it('grant_type != authorization_code → 400 unsupported_grant_type', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const res = await postToken({
      ...defaultFields(rawCode, verifier),
      grant_type: 'client_credentials',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unsupported_grant_type');
    // Wrong grant_type doesn't reach the code lookup — code NOT revoked.
    await assertCodeNotRedeemed(authCodeId);
  });

  it('missing code → 400 invalid_grant', async () => {
    const res = await postToken({
      grant_type: 'authorization_code',
      client_id: TEST_CLIENT_ID,
      redirect_uri: REGISTERED_REDIRECT,
      code_verifier: 'a'.repeat(43),
      resource: RESOURCE_URL,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('unknown code → 400 invalid_grant', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const res = await postToken(defaultFields('deadbeef'.repeat(8), verifier));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    // No row was ever created with that hash — nothing to revoke.
    expect(await db.userApiKey.count()).toBe(0);
  });

  it('already-redeemed code → 400 invalid_grant (indistinguishable from unknown)', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode({
      redeemedAt: new Date(),
    });
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description?: string };
    expect(body.error).toBe('invalid_grant');
    // No token minted on top of the redemption.
    expect(await db.userApiKey.count()).toBe(0);
    // Row still marked (the previous redemption stands).
    await assertCodeRedeemed(authCodeId);
  });

  it('empty body (no fields at all) → 400 unsupported_grant_type', async () => {
    // Pins the grant_type branch's treatment of a missing field as
    // the same shape as "wrong grant_type". RFC 6749 §5.2 nominally
    // would split this into invalid_request (missing) vs
    // unsupported_grant_type (wrong); we collapse both into
    // unsupported_grant_type for the same uniform-error privacy
    // posture as the missing-code case.
    const res = await postToken({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unsupported_grant_type');
    expect(await db.userApiKey.count()).toBe(0);
    expect(await db.authCode.count()).toBe(0);
  });

  it('sequential redemption: redeem then re-redeem same code → 200 then 400 invalid_grant', async () => {
    // The race test (025-oauth-token-race.test.ts) covers concurrent
    // redemption; this is the simpler sequential case — a client
    // that successfully exchanges a code and then (by bug or
    // attacker action) tries the same code again must get
    // `invalid_grant`, NOT another token. Implicit in the race
    // contract but a direct test is clearer to read.
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const firstRes = await postToken(defaultFields(rawCode, verifier));
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as { access_token: string };
    expect(firstBody.access_token).toMatch(
      new RegExp(`^${USER_API_KEY_PREFIX}[0-9a-f]{64}$`),
    );

    // Same code, immediately replayed. The atomic-claim updateMany's
    // `redeemedAt: null` predicate must reject this — count=0 path.
    const secondRes = await postToken(defaultFields(rawCode, verifier));
    expect(secondRes.status).toBe(400);
    const secondBody = (await secondRes.json()) as { error: string };
    expect(secondBody.error).toBe('invalid_grant');

    // Exactly ONE token across both attempts.
    expect(await db.userApiKey.count()).toBe(1);
    // Row's redeemedAt was set by the first redemption and stays.
    await assertCodeRedeemed(authCodeId);
  });
});

// ── Binding mismatches: client_id / redirect_uri / resource ──────────

describe('POST /oauth/token — binding mismatches revoke the code', () => {
  // Each test asserts:
  //   1. response is 400 invalid_grant
  //   2. NO UserApiKey was minted
  //   3. AuthCode.redeemedAt is now non-null (probing defense)

  it('client_id mismatch → 400 + code revoked', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const res = await postToken({
      ...defaultFields(rawCode, verifier),
      client_id: 'dcr_wrong',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    expect(await db.userApiKey.count()).toBe(0);
    await assertCodeRedeemed(authCodeId);
  });

  it('redirect_uri mismatch → 400 + code revoked', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const res = await postToken({
      ...defaultFields(rawCode, verifier),
      redirect_uri: 'https://evil.example/steal',
    });
    expect(res.status).toBe(400);
    expect(await db.userApiKey.count()).toBe(0);
    await assertCodeRedeemed(authCodeId);
  });

  it('resource mismatch → 400 + code revoked', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const res = await postToken({
      ...defaultFields(rawCode, verifier),
      resource: 'https://hadron.example/different-resource',
    });
    expect(res.status).toBe(400);
    expect(await db.userApiKey.count()).toBe(0);
    await assertCodeRedeemed(authCodeId);
  });

  it('multi-value resource → 400 invalid_request + code revoked', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    // URLSearchParams append rather than set produces repeated params.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(defaultFields(rawCode, verifier))) {
      if (k !== 'resource') params.set(k, v);
    }
    params.append('resource', RESOURCE_URL);
    params.append('resource', `${RESOURCE_URL}/other`);
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
    await assertCodeRedeemed(authCodeId);
  });

  it('stored resource[] of length 0 (defensive — should never happen) → 400 + revoked', async () => {
    // Pin the defensive `length !== 1` check. The /authorize handler
    // always writes a 1-element array, but a future bug or direct DB
    // edit could violate this; the /token handler should still
    // fail-closed.
    const { rawCode, verifier, authCodeId } = await seedAuthCode({ resource: [] });
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    await assertCodeRedeemed(authCodeId);
  });
});

// ── PKCE verifier ────────────────────────────────────────────────────

describe('POST /oauth/token — PKCE verifier', () => {
  it('PKCE verifier mismatch (wrong verifier for the stored challenge) → 400 + code revoked', async () => {
    const { rawCode, authCodeId } = await seedAuthCode();
    // A different verifier hashes to a different challenge.
    const wrongVerifier = randomBytes(32).toString('base64url');
    const res = await postToken({
      ...defaultFields(rawCode, wrongVerifier),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/PKCE/);
    expect(await db.userApiKey.count()).toBe(0);
    await assertCodeRedeemed(authCodeId);
  });

  it.each([
    ['too short (42 chars)', 'a'.repeat(42)],
    ['too long (129 chars)', 'a'.repeat(129)],
    ['invalid charset (+)', 'a'.repeat(40) + '+++'],
    ['invalid charset (=)', 'a'.repeat(40) + '==='],
  ])(
    'malformed code_verifier %s → 400 + code revoked',
    async (_label, badVerifier) => {
      const { rawCode, authCodeId } = await seedAuthCode();
      const res = await postToken({
        ...defaultFields(rawCode, badVerifier),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error_description: string };
      expect(body.error_description).toMatch(/PKCE|malformed/);
      await assertCodeRedeemed(authCodeId);
    },
  );

  it('missing code_verifier → 400 + code revoked', async () => {
    const { rawCode, authCodeId } = await seedAuthCode();
    const fields = defaultFields(rawCode, '');
    delete (fields as Record<string, string | undefined>).code_verifier;
    const res = await postToken(fields);
    expect(res.status).toBe(400);
    await assertCodeRedeemed(authCodeId);
  });
});

// ── Expiry ───────────────────────────────────────────────────────────

describe('POST /oauth/token — expiry', () => {
  it('expired code → 400 invalid_grant (no need to revoke)', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode({
      // Already past — code expired 1ms ago.
      expiresInMs: -1,
    });
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/expired/);
    expect(await db.userApiKey.count()).toBe(0);
    // Expired codes aren't revoked — they were already irretrievable.
    await assertCodeNotRedeemed(authCodeId);
  });
});

// ── #155: client lifetime ────────────────────────────────────────────

describe('POST /oauth/token — soft-deleted client (#155)', () => {
  it('refuses with the unknown-code answer, mints nothing, and leaves the code burned', async () => {
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    await db.oAuthClient.update({
      where: { clientId: TEST_CLIENT_ID },
      data: { deletedAt: new Date(), deletedBy: 'system:gc' },
    });
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(400);
    // The same answer as a lost race (R: Xabat's CHECKED Q2), so /token is no
    // oracle for client state.
    expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: 'code is unknown' });
    expect(await db.userApiKey.count()).toBe(0);
    await assertCodeRedeemed(authCodeId);
  });
});

describe('POST /oauth/token — redemption extends the client (#155)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('moves an expiring client to 30 days from the redemption', async () => {
    await db.oAuthClient.update({
      where: { clientId: TEST_CLIENT_ID },
      data: { expiresAt: new Date(Date.now() + 2 * DAY) },
    });
    const { rawCode, verifier } = await seedAuthCode();
    const before = Date.now();
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(200);
    const row = await db.oAuthClient.findUniqueOrThrow({ where: { clientId: TEST_CLIENT_ID } });
    expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY - 5_000);
    expect(row.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY + 5_000);
  });

  it('leaves a client that never expires (NULL) at NULL', async () => {
    const { rawCode, verifier } = await seedAuthCode();
    const res = await postToken(defaultFields(rawCode, verifier));
    expect(res.status).toBe(200);
    const row = await db.oAuthClient.findUniqueOrThrow({ where: { clientId: TEST_CLIENT_ID } });
    expect(row.expiresAt).toBeNull();
  });
});

// ── DB failure containment ───────────────────────────────────────────

describe('POST /oauth/token — DB failure containment', () => {
  it('claim+mint transaction throws → 500 server_error (not a crash, nothing claimed or minted)', async () => {
    // Same posture as Phase 2B/2C: Express 4 doesn't auto-forward
    // async rejections; the try/catch keeps the failure local to
    // the request.
    const { rawCode, verifier, authCodeId } = await seedAuthCode();
    const spy = vi
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(new Error('simulated DB outage'));
    try {
      const res = await postToken(defaultFields(rawCode, verifier));
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('server_error');
      expect(JSON.stringify(body)).not.toMatch(/simulated DB outage/);
      // #1897: claim and mint are ONE anchored transaction, so a failed
      // transaction leaves the code unclaimed (no un-claim race exists any
      // more) and no token minted; the client may retry the same code.
      const row = await db.authCode.findUniqueOrThrow({ where: { id: authCodeId } });
      expect(row.redeemedAt).toBeNull();
      expect(await db.userApiKey.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
