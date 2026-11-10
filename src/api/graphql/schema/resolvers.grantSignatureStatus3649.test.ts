/**
 * #3649 slice D (cor:acl:140:07, :08; cor:dmo:130:04 mirror): `Grant.signatureStatus`, the signature state of every grant
 * read, worked out on each read and never stored.
 *
 * - S1: each record is re-verified from its stored assertion against its passkey's stored public key, with the challenge
 *   rebuilt from the record's OWN pins (grant, version, terms hash, request). A forged or altered record reads as an
 *   integrity problem, never as a signature. A record that verifies but whose version or terms no longer match the row
 *   reads EARLIER (not current). A first passkey's window rules apply: PENDING while it is open, CANCELLED when the passkey
 *   was revoked inside it. No grant state label is asserted (gate selection 3).
 * - S2: erasing the signer (account deletion) leaves the grant active and its signature verifiable; the signer reads as
 *   a deleted user (null), and no name, handle, email or sealed id of theirs is echoed.
 *
 * Grants come from the S1a fixtures: no runtime creator exists yet (#3690 sequencing (a)). Reads go over real GraphQL
 * POSTs as a bound worker, the only reader `grant(ref:)` admits (#3789).
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema, printSchema } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { DB_NOW, dropTestActions, insertGrant, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../../../lib/grants/terms.js';
import { grantSignaturePayloadBytes, GRANT_SIGNATURE_PAYLOAD_V1 } from '../../../lib/signing/grantPayload.js';
import { newSigningRequestId } from '../../../lib/signing/requests.js';
import { clearSignatureVerifyCache } from '../../../lib/signing/verify.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { deploymentSchema } from './deploymentSchema.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const RP = 'localhost';
const ORIGIN = 'http://localhost';
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

let http: Server;
let base: string;
beforeAll(async () => {
  // The schema is built once at boot from the signing switch (deploymentSchema, #1895): on for these reads.
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await cleanDb(db); await dropTestActions(); });

let w: World;
let rawKey: string;
let sessionId: string;

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  w = await seedWorld();
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: w.orgId, userId, role: 'CONTRIBUTOR' } });
  await db.user.update({ where: { id: w.user2Id }, data: { email: `signer-${generateId().slice(0, 6)}@example.test` } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: w.userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  rawKey = k;
});

async function read(grantId: string): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}`, 'x-hadron-session': sessionId },
    body: JSON.stringify({
      query: `query($r:ID!){grant(ref:$r){id allows issuerUserId verifiedBy signatureId signatureStatus{state integrityProblems
        signatures{id state signer{handle urn} passkeyLabel passkeyRevokedAt version termsHash verifiedAt signingRequestId payloadVersion}}}}`,
      variables: { r: grantId },
    }),
  });
  return res.json();
}
const statusOf = async (grantId: string) => {
  const r = await read(grantId);
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data.grant.signatureStatus;
};

/** The terms hash of the row as stored, the way the ceremony computes it. */
async function rowTermsHash(grantId: string): Promise<string> {
  const g = await db.grant.findUniqueOrThrow({ where: { id: grantId } });
  return grantTermsHash(grantTermsFromRow({
    appId: g.appId, userId: g.userId, agentId: g.agentId, workerId: g.workerId, granteeAppId: g.granteeAppId,
    action: g.action, values: g.values, startsAt: g.startsAt, expiresAt: g.expiresAt, maxUses: g.maxUses, reason: g.reason,
  }));
}

interface Signed { g: string; r: string; s: string; passkeyId: string; termsHash: string }

/**
 * A worker-held grant with one completed request and its record, made by `signer`'s own soft passkey over the REAL
 * payload of the record's pins. `pinHash` signs (validly) over a terms hash other than the row's; `activate` activates it
 * through the guard's arm (the signer becomes the issuer).
 */
async function signGrant(opts: { activate?: boolean; firstWindow?: boolean; pinHash?: string; signer?: string } = {}): Promise<Signed> {
  const signer = opts.signer ?? w.user2Id;
  const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
  const termsHash = opts.pinHash ?? await rowTermsHash(g);
  const r = newSigningRequestId();
  await exec(`INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
    VALUES ($1, $2, 1, $3, $4, $5, ${DB_NOW}, ${DB_NOW} + interval '1 hour')`, r, g, termsHash, GRANT_SIGNATURE_PAYLOAD_V1, w.userId);
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, signer, key, { rpId: RP, firstWindow: opts.firstWindow, label: 'Signer key' });
  const payload = grantSignaturePayloadBytes(GRANT_SIGNATURE_PAYLOAD_V1, { grantId: g, recordVersion: 1, termsHash, requestId: r });
  const a = key.assert({ payload, origin: ORIGIN, rpId: RP });
  const s = generateId();
  await exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
      holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
    VALUES ($1, $2, $3, $4, $5, 1, $6, 'worker', $7, $8, $9, $10, $11, $12)`,
  s, g, r, signer, passkeyId, termsHash, w.workerId, GRANT_SIGNATURE_PAYLOAD_V1, RP, a.authenticatorData, a.clientDataJson, a.signature);
  await exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
  if (opts.activate ?? true) {
    await exec(`UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`,
      g, signer, s);
  }
  return { g, r, s, passkeyId, termsHash };
}

/**
 * Revoke a passkey now, on the same millisecond rounding its registration was stored with. A revocation inside an open
 * first-passkey window cancels the window in the same write, as every revoke path does (chk_passkey_shape).
 */
const revoke = (passkeyId: string) => exec(`UPDATE passkey_credentials SET revoked_at = t.now,
    window_outcome = CASE WHEN window_ends_at > t.now AND window_ended_at IS NULL THEN 'cancelled' ELSE window_outcome END,
    window_ended_at = CASE WHEN window_ends_at > t.now AND window_ended_at IS NULL THEN t.now ELSE window_ended_at END
  FROM (SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS now) t WHERE id = $1`, passkeyId);

/** Alter a stored record the way only someone outside the platform could: the append-only guard is off for this one statement. */
async function forge(signatureId: string, set: string, ...params: unknown[]): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grant_signatures DISABLE TRIGGER USER');
    await tx.$executeRawUnsafe(`UPDATE grant_signatures SET ${set} WHERE id = $1`, signatureId, ...params);
    await tx.$executeRawUnsafe('ALTER TABLE grant_signatures ENABLE TRIGGER USER');
  });
}

describe('S1: every grant read shows its signature state, re-verified on read', () => {
  it('a grant with no signature reads no state, no signatures, no integrity problems', async () => {
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    expect(await statusOf(g)).toEqual({ state: null, signatures: [], integrityProblems: 0 });
  });

  it('a grant activated by a verifying signature reads CURRENT, with the signer, the passkey label and the pins', async () => {
    const { g, r, s, termsHash } = await signGrant();
    const res = await read(g);
    expect(res.errors).toBeUndefined();
    expect(res.data.grant).toMatchObject({ allows: true, issuerUserId: w.user2Id, verifiedBy: w.user2Id, signatureId: s });
    const handle = (await db.user.findUniqueOrThrow({ where: { id: w.user2Id } })).handle;
    const st = res.data.grant.signatureStatus;
    expect(st.state).toBe('CURRENT');
    expect(st.integrityProblems).toBe(0);
    expect(st.signatures).toHaveLength(1);
    expect(st.signatures[0]).toMatchObject({
      id: s, state: 'CURRENT', signer: { handle }, passkeyLabel: 'Signer key', passkeyRevokedAt: null,
      version: 1, termsHash, signingRequestId: r, payloadVersion: GRANT_SIGNATURE_PAYLOAD_V1,
    });
  });

  it('a forged record (its assertion bytes altered) reads as an integrity problem, never as a signature', async () => {
    const { g, s } = await signGrant();
    const [{ signature }] = await db.$queryRawUnsafe<Array<{ signature: Buffer }>>('SELECT signature FROM grant_signatures WHERE id = $1', s);
    const bad = Buffer.from(signature);
    bad[bad.length - 1] ^= 0x01;
    await forge(s, 'signature = $2', bad);
    expect(await statusOf(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('a record whose stored pins were altered (terms hash, version or request) no longer verifies: an integrity problem', async () => {
    for (const [set, value] of [['terms_hash = $2', 'b'.repeat(64)], ['version = $2', 2]] as const) {
      const { g, s } = await signGrant();
      await forge(s, set, value);
      clearSignatureVerifyCache();
      expect(await statusOf(g), set).toEqual({ state: null, signatures: [], integrityProblems: 1 });
    }
  });

  it('a verdict cached for a record is not reused once its pins change underneath it', async () => {
    const { g, s } = await signGrant();
    expect((await statusOf(g)).state).toBe('CURRENT');
    await forge(s, 'terms_hash = $2', 'c'.repeat(64));
    expect(await statusOf(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('a record that verifies over terms other than the row\'s reads EARLIER (not current)', async () => {
    const { g } = await signGrant({ activate: false, pinHash: 'd'.repeat(64) });
    const st = await statusOf(g);
    expect(st.integrityProblems).toBe(0);
    expect(st.state).toBe('EARLIER');
    expect(st.signatures.map((x: { state: string }) => x.state)).toEqual(['EARLIER']);
  });

  it('a record whose holder differs from the row\'s while its pins still match is inconsistent: an integrity problem', async () => {
    const { g, s } = await signGrant();
    await forge(s, 'holder_kind = $2, holder_id = $3', 'user', w.userId);
    expect(await statusOf(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('a first passkey still in its window reads PENDING; revoked inside the window, CANCELLED', async () => {
    const { g, passkeyId } = await signGrant({ activate: false, firstWindow: true });
    expect((await statusOf(g)).state).toBe('PENDING');
    await revoke(passkeyId);
    const st = await statusOf(g);
    expect(st.state).toBe('CANCELLED');
    expect(st.signatures[0].passkeyRevokedAt).not.toBeNull();
  });

  it('a passkey revoked after its signature, outside any window, keeps the signature CURRENT with the revocation shown', async () => {
    const { g, passkeyId } = await signGrant();
    await revoke(passkeyId);
    const st = await statusOf(g);
    expect(st.state).toBe('CURRENT');
    expect(st.signatures[0].passkeyRevokedAt).not.toBeNull();
  });

  it('a list page loads every row\'s status: each grant gets its own records only', async () => {
    const a = await signGrant();
    const b = await signGrant();
    const none = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    const res = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}`, 'x-hadron-session': sessionId },
      body: JSON.stringify({ query: '{grants{items{id signatureStatus{state integrityProblems signatures{id}}}}}' }),
    }).then((x) => x.json()) as any;
    expect(res.errors).toBeUndefined();
    const byId = new Map((res.data.grants.items as Array<{ id: string; signatureStatus: any }>).map((i) => [i.id, i.signatureStatus]));
    expect(byId.get(a.g)).toEqual({ state: 'CURRENT', integrityProblems: 0, signatures: [{ id: a.s }] });
    expect(byId.get(b.g)).toEqual({ state: 'CURRENT', integrityProblems: 0, signatures: [{ id: b.s }] });
    expect(byId.get(none)).toEqual({ state: null, integrityProblems: 0, signatures: [] });
  });
});

describe('S2 (cor:acl:140:08): erasing the signer', () => {
  it('leaves the grant active and its signature verifiable; the signer reads as a deleted user, with nothing of theirs echoed', async () => {
    const { g, s } = await signGrant();
    const before = await db.user.findUniqueOrThrow({ where: { id: w.user2Id } });
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    clearSignatureVerifyCache();
    const res = await read(g);
    expect(res.errors).toBeUndefined();
    // Anne LOCAL P2-F1 (#3811): verifiedBy is the signer's id too; erased, it reads null like issuerUserId.
    expect(res.data.grant).toMatchObject({ allows: true, issuerUserId: null, verifiedBy: null, signatureId: s });
    const st = res.data.grant.signatureStatus;
    expect(st.state).toBe('CURRENT');
    expect(st.integrityProblems).toBe(0);
    expect(st.signatures).toHaveLength(1);
    expect(st.signatures[0]).toMatchObject({ id: s, state: 'CURRENT', signer: null, passkeyLabel: 'Erased passkey' });
    const body = JSON.stringify(res);
    for (const leaked of [w.user2Id, before.handle, before.email].filter(Boolean) as string[]) expect(body).not.toContain(leaked);
  });
});

describe('C10 extended: the signing switch takes the read field with it', () => {
  afterEach(() => vi.unstubAllEnvs());
  const NEW_TYPES = ['GrantSignatureStatus', 'GrantSignature', 'GrantSignatureState'];

  it('switched off: Grant stays, but signatureStatus, its resolver and its types are absent', () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', undefined);
    const surface = deploymentSchema();
    const schema = buildSchema(surface.typeDefs);
    const grant = schema.getType('Grant') as { getFields(): Record<string, unknown> } | undefined;
    expect(grant).toBeDefined();
    expect(grant!.getFields()).toHaveProperty('allows');
    expect(grant!.getFields()).not.toHaveProperty('signatureStatus');
    const sdl = printSchema(schema);
    for (const name of NEW_TYPES) expect(sdl).not.toMatch(new RegExp(`\\b${name}\\b`));
    expect((surface.resolvers as unknown as Record<string, Record<string, unknown> | undefined>).Grant ?? {}).not.toHaveProperty('signatureStatus');
    for (const name of NEW_TYPES) expect(surface.resolvers).not.toHaveProperty(name);
  });

  it('switched on: the field and its types are present', () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    const surface = deploymentSchema();
    const schema = buildSchema(surface.typeDefs);
    expect((schema.getType('Grant') as { getFields(): Record<string, unknown> }).getFields()).toHaveProperty('signatureStatus');
    for (const name of NEW_TYPES) expect(schema.getType(name), name).toBeDefined();
    expect((surface.resolvers as unknown as Record<string, Record<string, unknown>>).Grant).toHaveProperty('signatureStatus');
  });
});
