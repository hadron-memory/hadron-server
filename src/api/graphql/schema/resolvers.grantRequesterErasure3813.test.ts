import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
      query: `query($r:ID!){grant(ref:$r){id allows requestedByUserId reason issuerUserId verifiedBy signatureId signatureStatus{state integrityProblems
        signatures{id state signer{handle urn} passkeyLabel passkeyRevokedAt version termsHash verifiedAt signingRequestId payloadVersion}}}}`,
      variables: { r: grantId },
    }),
  });
  return res.json();
}

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
async function signGrant(opts: { activate?: boolean; firstWindow?: boolean; pinHash?: string; signer?: string; requester?: string } = {}): Promise<Signed> {
  const signer = opts.signer ?? w.user2Id;
  const g = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: opts.requester ?? null });
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


async function readBoth(g: string) {
  const one = await read(g);
  expect(one.errors, JSON.stringify(one.errors)).toBeUndefined();
  const list = await fetch(`${base}/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}`, 'x-hadron-session': sessionId },
    body: JSON.stringify({ query: '{grants{items{id allows requestedByUserId reason issuerUserId verifiedBy signatureId signatureStatus{state integrityProblems}}}}' }),
  }).then(r => r.json()) as any;
  expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
  return [one.data.grant, list.data.grants.items.find((x: {id: string}) => x.id === g)];
}

// Ruling 0265 / cor:acl:140:08: requester links die in the erasure transaction;
// requester identity is not part of the signed terms. Holder and reader stay live.
describe('#3813 requester erasure', () => {
  it('nulls a distinct requester in storage and both public reads without changing the signed grant', async () => {
    const requester = await db.user.create({data: {handle: `requester-${generateId()}`}});
    const {g, s} = await signGrant({requester: requester.id});
    for (const row of await readBoth(g)) expect(row).toMatchObject({requestedByUserId: requester.id, issuerUserId: w.user2Id, verifiedBy: w.user2Id, allows: true, reason: 'because', signatureStatus: {state: 'CURRENT', integrityProblems: 0}});
    const before = await db.grant.findUniqueOrThrow({where: {id: g}});
    const signatures = await db.grantSignature.findMany({where: {grantId: g}});
    await deleteUserAccount(db, {targetUserId: requester.id, actorUserId: requester.id});
    clearSignatureVerifyCache();
    const after = await db.grant.findUniqueOrThrow({where: {id: g}});
    for (const row of await readBoth(g)) expect(row.requestedByUserId).toBeNull();
    expect(after.requestedByUserId).toBeNull();
    expect({...after, requestedByUserId: before.requestedByUserId, updatedAt: before.updatedAt}).toEqual(before);
    expect(await db.grantSignature.findMany({where: {grantId: g}})).toEqual(signatures);
    for (const row of await readBoth(g)) expect(row).toMatchObject({requestedByUserId: null, issuerUserId: w.user2Id, verifiedBy: w.user2Id, signatureId: s, allows: true, reason: 'because', signatureStatus: {state: 'CURRENT', integrityProblems: 0}});
  });
});

describe('#3813 non-target and guard controls', () => {
  it('keeps a live requester through signer-only erasure, including both public reads', async () => {
    const {g} = await signGrant({requester: w.userId});
    await deleteUserAccount(db, {targetUserId: w.user2Id, actorUserId: w.user2Id});
    clearSignatureVerifyCache();
    expect((await db.grant.findUniqueOrThrow({where:{id:g}})).requestedByUserId).toBe(w.userId);
    for (const row of await readBoth(g)) expect(row).toMatchObject({requestedByUserId: w.userId, issuerUserId: null, verifiedBy: null, allows: true, signatureStatus: {state: 'CURRENT', integrityProblems: 0}});
  });
  it('clears both requester and issuer when the erased requester is also the signer', async () => {
    const {g} = await signGrant({requester: w.user2Id});
    await deleteUserAccount(db, {targetUserId: w.user2Id, actorUserId: w.user2Id});
    clearSignatureVerifyCache();
    expect((await db.grant.findUniqueOrThrow({where:{id:g}})).requestedByUserId).toBeNull();
    for (const row of await readBoth(g)) expect(row).toMatchObject({requestedByUserId: null, issuerUserId: null, verifiedBy: null, allows: true, reason: 'because', signatureStatus: {state: 'CURRENT', integrityProblems: 0}});
  });
  it('refuses clearing a live requester and unrecorded reassignment', async () => {
    const g = await insertGrant(w, {user_id: null, worker_id: w.workerId, requested_by_user_id: w.user2Id});
    await expect(exec('UPDATE grants SET requested_by_user_id = NULL WHERE id = $1', g)).rejects.toThrow('grants are append-only');
    await expect(exec('UPDATE grants SET requested_by_user_id = $2 WHERE id = $1', g, w.userId)).rejects.toThrow('grants are append-only');
    expect((await db.grant.findUniqueOrThrow({where:{id:g}})).requestedByUserId).toBe(w.user2Id);
  });
  it('allows only null after erasure, with every other sealed field still guarded', async () => {
    const g = await insertGrant(w, {user_id: null, worker_id: w.workerId, requested_by_user_id: w.user2Id});
    await db.user.update({where:{id:w.user2Id}, data:{deletedAt:new Date()}});
    await expect(exec("UPDATE grants SET requested_by_user_id = NULL, reason = 'changed' WHERE id = $1", g)).rejects.toThrow('grants are append-only');
    await expect(exec('UPDATE grants SET requested_by_user_id = $2 WHERE id = $1', g, w.userId)).rejects.toThrow('grants are append-only');
    await exec('UPDATE grants SET requested_by_user_id = NULL WHERE id = $1', g);
    expect(await db.grant.findUniqueOrThrow({where:{id:g}})).toMatchObject({requestedByUserId:null, reason:'because'});
  });
});
