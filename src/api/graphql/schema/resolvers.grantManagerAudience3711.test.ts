/**
 * #3711 (V56, §10's mixed-audience pin): `Grant.signatureStatus` is projected for each parent row's OWN audience. A manager's
 * `appGrants` shows the signature list (signer handle/URN, passkey label); the same person's `myGrants` of the SAME grant, in the
 * SAME request and in either order, does not; and the shared per-tick status load can neither widen nor narrow the other.
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
import { markManagerAudience, markPersonAudience } from '../../../lib/grants/read.js';
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
  // The holder (w.userId) MANAGES the App (org admin), so it reads the same grant as a manager and as a person; the signer is w.user2Id.
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.userId, role: 'ADMIN' } });
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

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${holderKey}` },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const FULL = 'state integrityProblems signatures{id state signer{handle urn} passkeyLabel version termsHash}';
const WITHHELD = { state: 'CURRENT', integrityProblems: 0, signatures: [] };

describe('one request, one grant, two audiences', () => {
  it('the manager\'s list shows the signer and the device; myGrants withholds them; in either order, aliased', async () => {
    const g = await signedPersonGrant();
    for (const query of [
      `query($a:String!){ m: appGrants(appRef:$a){ items{ id signatureStatus{ ${FULL} } } } mine: myGrants{ items{ id signatureStatus{ ${FULL} } } } }`,
      `query($a:String!){ mine: myGrants{ items{ id signatureStatus{ ${FULL} } } } m: appGrants(appRef:$a){ items{ id signatureStatus{ ${FULL} } } } }`,
    ]) {
      const r = await gql(query, { a: w.appId });
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
      const m = r.data.m.items.find((i: any) => i.id === g).signatureStatus;
      const mine = r.data.mine.items.find((i: any) => i.id === g).signatureStatus;
      expect(m.state).toBe('CURRENT');
      expect(m.signatures).toHaveLength(1);
      expect(m.signatures[0]).toMatchObject({ passkeyLabel: 'Signer personal YubiKey', signer: { handle: signerHandle } });
      expect(mine).toEqual(WITHHELD);
    }
  });

  it('a manager-marked and a person-marked parent of the same grant, resolved in one tick, in either order, each get their own answer', async () => {
    const g = await signedPersonGrant();
    const ctx = { db } as unknown as Context;
    const field = grantFieldResolvers.Grant.signatureStatus;
    for (const order of ['manager-first', 'person-first'] as const) {
      const manager = markManagerAudience({ id: g });
      const person = markPersonAudience({ id: g });
      const calls = order === 'manager-first' ? [manager, person] : [person, manager];
      const out = await Promise.all(calls.map((p) => field(p, undefined, ctx)));
      const [m, p] = order === 'manager-first' ? out : [out[1], out[0]];
      expect(m.signatures, order).toHaveLength(1);
      expect(m.signatures[0].signerId, order).toBe(w.user2Id);
      expect(p, order).toEqual(WITHHELD);
    }
  });
});

describe('Dorian F1 / Riana P2-2: a requester who no longer manages the App is not shown the signer list when it withdraws an ended signed grant', () => {
  it('signed, activated, revoked by the (then) manager; the manager demoted; the same person withdraws (first end stands): signatures withheld', async () => {
    const g = await signedPersonGrant();
    await db.$executeRaw`UPDATE grants SET requested_by_user_id = ${w.userId} WHERE id = ${g}`;
    const revoke = await gql(`mutation($r:ID!){revokeGrant(ref:$r){id revokedAt}}`, { r: g });
    expect(revoke.errors, JSON.stringify(revoke.errors)).toBeUndefined();
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: w.userId } }, data: { role: 'CONTRIBUTOR' } });
    const r = await gql(`mutation($r:ID!){withdrawGrant(ref:$r){id revokedByUserId signatureStatus{ ${FULL} }}}`, { r: g });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data.withdrawGrant.revokedByUserId).toBeNull();
    expect(r.data.withdrawGrant.signatureStatus).toEqual(WITHHELD);
    expect(JSON.stringify(r)).not.toContain(signerHandle);
    expect(JSON.stringify(r)).not.toContain('YubiKey');
  });
});
