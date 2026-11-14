/**
 * #3800 × #3649 slice D (gate call, Xabat 6760624390; Ralion §10 P2-2 at 5a124baa): `Grant.signatureStatus` reached through
 * `myGrants` must not hand a holder who is outside the App's Org the signer's handle/URN or passkey label/revocation. Through
 * `myGrants` the status is state + integrityProblems only (signatures []); `grant(ref:)` / `grants` are unchanged.
 */
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
import { markPersonAudience } from '../../../lib/grants/read.js';
import { grantSignaturePayloadBytes, GRANT_SIGNATURE_PAYLOAD_V1 } from '../../../lib/signing/grantPayload.js';
import { newSigningRequestId } from '../../../lib/signing/requests.js';
import { clearSignatureVerifyCache } from '../../../lib/signing/verify.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { grantFieldResolvers } from './resolvers.grant.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const RP = 'localhost';
const ORIGIN = 'http://localhost';
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

let http: Server;
let base: string;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await cleanDb(db); await dropTestActions(); });

let w: World;
let holderKey: string;
let signerHandle: string;

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  w = await seedWorld();
  // The holder (w.userId) is deliberately NOT a member of the App's Org; the signer (w.user2Id) is its admin.
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.user2Id, role: 'ADMIN' } });
  signerHandle = (await db.user.findUniqueOrThrow({ where: { id: w.user2Id } })).handle;
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: w.userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  holderKey = k;
});

/** A grant held by the PERSON `w.userId`, activated by the signer's verifying signature. */
async function signedPersonGrant(): Promise<string> {
  const g = await insertGrant(w, { user_id: w.userId, worker_id: null });
  const row = await db.grant.findUniqueOrThrow({ where: { id: g } });
  const termsHash = grantTermsHash(grantTermsFromRow({
    appId: row.appId, userId: row.userId, agentId: row.agentId, workerId: row.workerId, granteeAppId: row.granteeAppId,
    action: row.action, values: row.values, startsAt: row.startsAt, expiresAt: row.expiresAt, maxUses: row.maxUses, reason: row.reason,
  }));
  const r = newSigningRequestId();
  await exec(`INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
    VALUES ($1, $2, 1, $3, $4, $5, ${DB_NOW}, ${DB_NOW} + interval '1 hour')`, r, g, termsHash, GRANT_SIGNATURE_PAYLOAD_V1, w.user2Id);
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, w.user2Id, key, { rpId: RP, label: 'Signer personal YubiKey' });
  const payload = grantSignaturePayloadBytes(GRANT_SIGNATURE_PAYLOAD_V1, { grantId: g, recordVersion: 1, termsHash, requestId: r });
  const a = key.assert({ payload, origin: ORIGIN, rpId: RP });
  const s = generateId();
  await exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
      holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
    VALUES ($1, $2, $3, $4, $5, 1, $6, 'user', $7, $8, $9, $10, $11, $12)`,
  s, g, r, w.user2Id, passkeyId, termsHash, w.userId, GRANT_SIGNATURE_PAYLOAD_V1, RP, a.authenticatorData, a.clientDataJson, a.signature);
  await exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
  await exec(`UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`, g, w.user2Id, s);
  return g;
}

async function gql(query: string): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${holderKey}` },
    body: JSON.stringify({ query }),
  });
  return res.json();
}
const FULL = 'state integrityProblems signatures{id state signer{handle urn} passkeyLabel passkeyRevokedAt version termsHash verifiedAt signingRequestId payloadVersion}';
const WITHHELD = { state: 'CURRENT', integrityProblems: 0, signatures: [] };

describe('myGrants withholds the signer and the device from a holder outside the Org', () => {
  it('state and integrityProblems only; the signature list is empty, and nothing of the signer appears anywhere in the answer', async () => {
    await signedPersonGrant();
    const r = await gql(`{ myGrants { total items { allows verifiedBy signatureStatus { ${FULL} } } } }`);
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data.myGrants.total).toBe(1);
    expect(r.data.myGrants.items[0].signatureStatus).toEqual(WITHHELD);
    const text = JSON.stringify(r);
    expect(text).not.toContain(signerHandle);
    expect(text).not.toContain('YubiKey');
  });

  it('an alias and a nested fragment get the same answer', async () => {
    await signedPersonGrant();
    const r = await gql(`fragment S on Grant { signatureStatus { ${FULL} } }
      { mine: myGrants { items { ...S } } again: myGrants(limit: 5) { items { ... on Grant { st: signatureStatus { ${FULL} } } } } }`);
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data.mine.items[0].signatureStatus).toEqual(WITHHELD);
    expect(r.data.again.items[0].st).toEqual(WITHHELD);
    expect(JSON.stringify(r)).not.toContain(signerHandle);
  });
});

describe('the withhold follows the PARENT row, not the shared load (one request, one grant id, two audiences)', () => {
  it('a marked and an unmarked parent of the same grant, resolved in one tick, in either order, each get their own answer', async () => {
    const g = await signedPersonGrant();
    const ctx = { db } as unknown as Context;
    const field = grantFieldResolvers.Grant.signatureStatus;
    for (const order of ['marked-first', 'plain-first'] as const) {
      const marked = markPersonAudience({ id: g });
      const plain = { id: g };
      const calls = order === 'marked-first' ? [marked, plain] : [plain, marked];
      const out = await Promise.all(calls.map((p) => field(p, undefined, ctx)));
      const [m, p] = order === 'marked-first' ? out : [out[1], out[0]];
      expect(m, order).toEqual(WITHHELD);
      expect(p.signatures, order).toHaveLength(1);
      expect(p.signatures[0].signerId, order).toBe(w.user2Id);
    }
  });
});
