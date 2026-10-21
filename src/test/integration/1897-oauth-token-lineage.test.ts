/**
 * #1897 foundation A (R66): POST /oauth/token claims the code and mints the key in ONE anchored
 * transaction that carries the code's sign-in root. Cancellation first => invalid_grant and no
 * key; mint first => the cancellation sees and revokes the key. Real HTTP, real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { createSignIn, endSignInsCompletedBy } from '../../auth/signIn.js';
import { lockAuthorityAnchors } from '../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../lockWait.js';

let server: Server;
let baseUrl: string;
const REDIRECT = 'https://client.example.com/callback';
const RESOURCE = 'https://hadron.example/mcp';
const CLIENT_ID = `dcr_${'b'.repeat(32)}`;
let userId: string;
let passkeyId: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))); });

async function newPasskey(): Promise<string> {
  const id = generateId();
  await db.$executeRaw`INSERT INTO passkey_credentials
    (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up)
    VALUES (${id}, ${userId}, ${Buffer.from(`c-${id}`)}, ${Buffer.from('pk')}, -7, ${Buffer.alloc(32, 1)}, 'example.test', 'S',
      (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ARRAY['internal'], false, false)`;
  return id;
}
async function cancel(pk: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${pk}`;
    await endSignInsCompletedBy(tx, pk);
  });
}
async function seedCode(signInId: string | null) {
  const rawCode = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  await db.authCode.create({ data: {
    codeHash: createHash('sha256').update(rawCode).digest('hex'), clientId: CLIENT_ID, userId, redirectUri: REDIRECT,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'), resource: [RESOURCE], oauthScopes: ['mcp'],
    expiresAt: new Date(Date.now() + 600_000), createdBy: userId, signInId,
  } });
  return { rawCode, verifier };
}
function redeem(s: { rawCode: string; verifier: string }) {
  return fetch(`${baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: s.rawCode, client_id: CLIENT_ID, redirect_uri: REDIRECT,
      code_verifier: s.verifier, resource: RESOURCE }).toString() });
}

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { githubUsername: 'lineage', githubId: 1897100, roles: ['CONTRIBUTOR'] } })).id;
  await db.oAuthClient.create({ data: { clientId: CLIENT_ID, clientName: 'Lineage', redirectUris: [REDIRECT] } });
  passkeyId = await newPasskey();
});

describe('POST /oauth/token carries the sign-in root (#1897)', () => {
  it('mints a key whose origin is the code\'s sign-in', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId }));
    const res = await redeem(await seedCode(si.id));
    expect(res.status).toBe(200);
    expect((await db.userApiKey.findFirstOrThrow({ where: { userId } })).originSignInId).toBe(si.id);
  });
  it('a code with no sign-in mints a legacy key with no root (S6/S11)', async () => {
    expect((await redeem(await seedCode(null))).status).toBe(200);
    expect((await db.userApiKey.findFirstOrThrow({ where: { userId } })).originSignInId).toBeNull();
  });
  it('cancellation first: invalid_grant and no key', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId }));
    const seed = await seedCode(si.id);
    await cancel(passkeyId);
    const res = await redeem(seed);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_grant');
    expect(await db.userApiKey.count({ where: { userId } })).toBe(0);
  });
  it('a sign-in ended between claim and mint cannot leave a live key (race, both orders)', async () => {
    for (let i = 0; i < 12; i++) {
      const pk = await newPasskey();
      const si = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId: pk }));
      const seed = await seedCode(si.id);
      await Promise.all([redeem(seed), cancel(pk)]);
      expect(await db.userApiKey.count({ where: { originSignInId: si.id, revokedAt: null } })).toBe(0);
    }
  });
  it('an already-cancelled code stays unclaimed so a failed mint does not burn evidence silently', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId }));
    const seed = await seedCode(si.id);
    await cancel(passkeyId);
    await redeem(seed);
    expect(await db.userApiKey.count({ where: { userId } })).toBe(0);
  });

  it('DETERMINISTIC cancel-first (Jane): a redeem parked on the user anchor, then a cancel committing, yields invalid_grant and no key', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId }));
    const seed = await seedCode(si.id);
    let redeemed: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: userId }], 'exclusive');
      redeemed = redeem(seed);
      await waitForLockWaitersOfType(db, 'advisory');
      await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${passkeyId}`;
      await endSignInsCompletedBy(tx, passkeyId);
    });
    const res = await redeemed!;
    expect(res.status).toBe(400);
    expect(await db.userApiKey.count({ where: { userId } })).toBe(0);
  });
  it('DETERMINISTIC mint-first: the cancel after a committed redeem revokes the minted key', async () => {
    const si = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId }));
    expect((await redeem(await seedCode(si.id))).status).toBe(200);
    await cancel(passkeyId);
    expect(await db.userApiKey.count({ where: { originSignInId: si.id, revokedAt: null } })).toBe(0);
    expect(await db.userApiKey.count({ where: { originSignInId: si.id } })).toBe(1);
  });
  it('Baloo P2-2: a code that expires while the redeem waits on the user anchor mints nothing', async () => {
    const seed = await seedCode(null);
    await db.authCode.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() + 1500) } });
    let redeemed: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: userId }], 'exclusive');
      redeemed = redeem(seed);
      await waitForLockWaitersOfType(db, 'advisory');
      await new Promise((r) => setTimeout(r, 1700));
    });
    const res = await redeemed!;
    expect(res.status).toBe(400);
    expect(await db.userApiKey.count({ where: { userId } })).toBe(0);
    expect((await db.authCode.findFirstOrThrow({ where: { userId } })).redeemedAt).toBeNull();
  });

  it('Ruth P2: a code that expires while its ROW is locked by another transaction is not claimed (database clock after the lock)', async () => {
    for (const rooted of [false, true]) {
      await db.userApiKey.deleteMany({ where: { userId } });
      await db.authCode.deleteMany({ where: { userId } });
      const si = rooted ? await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId })) : null;
      const seed = await seedCode(si?.id ?? null);
      await db.authCode.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() + 1500) } });
      let redeemed: Promise<Response> | undefined;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM auth_codes WHERE user_id = ${userId} FOR UPDATE`;
        redeemed = redeem(seed);
        await waitForLockWaitersOfType(db, 'transactionid');
        await new Promise((r) => setTimeout(r, 1700));
      });
      expect((await redeemed!).status).toBe(400);
      expect(await db.userApiKey.count({ where: { userId } })).toBe(0);
      expect((await db.authCode.findFirstOrThrow({ where: { userId } })).redeemedAt).toBeNull();
    }
  });
});
