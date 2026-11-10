/**
 * #3827 (child A of #3824; cor:dmo:120:05, cor:dmo:130:04 / :06, cor:acl:140:07 / :08, cor:aut:040:05): a signature
 * record's signer must be its passkey's owner, re-checked on every read, on BOTH signing read paths.
 *
 * Writes already bind the two (the append-only guards admit an INSERT only with the signer's own unrevoked passkey and
 * refuse every UPDATE), and a passkey's owner never changes. Re-verification on read exists for records changed in
 * storage, outside the platform's write path (the trigger-disabled tamper model). Before #3827 neither read path compared
 * the record's `signer_id` with its passkey's `owner_id`, so a record whose signer alone was changed still verified and
 * was listed, credited to someone who never signed.
 *
 * Red on main: the two signer-flip pins. Controls (green before and after): a corrupt assertion is still an integrity
 * problem; an ordinary UPDATE of `signer_id` is still refused; an erased signer's record still reads valid; a merged
 * source's revoked-passkey signature still reads valid (merge rewrites neither signer nor passkey owner).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { DB_NOW, dropTestActions, insertGrant, seedWorld, type World } from '../grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { deleteUserAccount } from '../../controller/operations/deleteUser.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { grantSignaturePayloadBytes, GRANT_SIGNATURE_PAYLOAD_V1 } from './grantPayload.js';
import { loadGrantSignatureStatuses } from './grantStatus.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from './payload.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction, newSigningRequestId } from './requests.js';
import { loadSignatureStatuses } from './status.js';
import { clearSignatureVerifyCache } from './verify.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

/** Change a stored record the way only someone outside the platform could: the table's user triggers are off for this one statement. */
async function forge(table: 'grant_signatures' | 'node_signatures', id: string, set: string, ...params: unknown[]): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await tx.$executeRawUnsafe(`UPDATE ${table} SET ${set} WHERE id = $1`, id, ...params);
    await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  });
}

/** Flip one byte of a stored assertion signature (the corrupt-assertion control). */
async function corrupt(table: 'grant_signatures' | 'node_signatures', id: string): Promise<void> {
  const [{ signature }] = await db.$queryRawUnsafe<Array<{ signature: Buffer }>>(`SELECT signature FROM ${table} WHERE id = $1`, id);
  const bad = Buffer.from(signature);
  bad[bad.length - 1] ^= 0x01;
  await forge(table, id, 'signature = $2', bad);
}

/** Revoke a passkey now, outside any first-passkey window. */
const revoke = (passkeyId: string) =>
  exec(`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = $1`, passkeyId);

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('grant read path (Grant.signatureStatus, grantStatus.ts)', () => {
  let w: World;
  beforeEach(async () => { w = await seedWorld(); });

  /** A worker-held grant with one completed request and its record, made by user2's own soft passkey over the real payload. */
  async function signGrant(opts: { pinHash?: string; signerId?: string } = {}): Promise<{ g: string; s: string; passkeyId: string }> {
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    const row = await db.grant.findUniqueOrThrow({ where: { id: g } });
    const termsHash = opts.pinHash ?? grantTermsHash(grantTermsFromRow({
      appId: row.appId, userId: row.userId, agentId: row.agentId, workerId: row.workerId, granteeAppId: row.granteeAppId,
      action: row.action, values: row.values, startsAt: row.startsAt, expiresAt: row.expiresAt, maxUses: row.maxUses, reason: row.reason,
    }));
    const r = newSigningRequestId();
    await exec(`INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
      VALUES ($1, $2, 1, $3, $4, $5, ${DB_NOW}, ${DB_NOW} + interval '1 hour')`, r, g, termsHash, GRANT_SIGNATURE_PAYLOAD_V1, w.userId);
    const key = softPasskey();
    const passkeyId = await insertSoftPasskey(db, w.user2Id, key, { rpId: RP, label: 'Signer key' });
    const a = key.assert({
      payload: grantSignaturePayloadBytes(GRANT_SIGNATURE_PAYLOAD_V1, { grantId: g, recordVersion: 1, termsHash, requestId: r }),
      origin: ORIGIN, rpId: RP,
    });
    const s = `gs-${g}`;
    await exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
        holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
      VALUES ($1, $2, $3, $4, $5, 1, $6, 'worker', $7, $8, $9, $10, $11, $12)`,
    s, g, r, opts.signerId ?? w.user2Id, passkeyId, termsHash, w.workerId, GRANT_SIGNATURE_PAYLOAD_V1, RP, a.authenticatorData, a.clientDataJson, a.signature);
    await exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
    return { g, s, passkeyId };
  }
  const status = async (g: string) => (await loadGrantSignatureStatuses(db, [g])).get(g)!;

  it('baseline: a verifying record reads CURRENT, credited to its signer', async () => {
    const { g, s } = await signGrant();
    const st = await status(g);
    expect(st).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
    expect(st.signatures.map((x) => [x.id, x.signerId])).toEqual([[s, w.user2Id]]);
  });

  it('RED: a record whose signer_id alone was changed is an integrity problem, never credited to the other user', async () => {
    const { g, s } = await signGrant();
    await forge('grant_signatures', s, 'signer_id = $2', w.userId);
    expect(await status(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('RED: the binding is checked on every read, not cached with an earlier verdict for the record', async () => {
    const { g, s } = await signGrant();
    expect((await status(g)).state).toBe('CURRENT');
    await forge('grant_signatures', s, 'signer_id = $2', w.userId);
    expect(await status(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  /** A superseded record: it verifies over terms other than the row's (grants are append-only), so it reads EARLIER, not CURRENT. */
  const signSuperseded = () => signGrant({ pinHash: 'd'.repeat(64) });

  it('control: a superseded record that is otherwise intact reads EARLIER, credited to its signer', async () => {
    const { g, s } = await signSuperseded();
    const st = await status(g);
    expect(st).toMatchObject({ state: 'EARLIER', integrityProblems: 0 });
    expect(st.signatures.map((x) => [x.id, x.signerId])).toEqual([[s, w.user2Id]]);
  });

  it('a superseded record whose signer_id alone was changed is an integrity problem, never listed as EARLIER', async () => {
    const { g, s } = await signSuperseded();
    await forge('grant_signatures', s, 'signer_id = $2', w.userId);
    expect(await status(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('control: a corrupt assertion is still an integrity problem', async () => {
    const { g, s } = await signGrant();
    await corrupt('grant_signatures', s);
    expect(await status(g)).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('control: an INSERT naming a signer who does not own the passkey is refused by the write guard', async () => {
    await expect(signGrant({ signerId: w.userId })).rejects.toThrow(/signer's own unrevoked passkey/);
  });

  it('control: an ordinary UPDATE of signer_id is refused by the append-only guard', async () => {
    const { s } = await signGrant();
    await expect(exec('UPDATE grant_signatures SET signer_id = $2 WHERE id = $1', s, w.userId)).rejects.toThrow(/append-only/);
  });

  it('control: an erased signer\'s record still reads valid (the passkey keeps its owner)', async () => {
    const { g, s } = await signGrant();
    await deleteUserAccount(db, { targetUserId: w.user2Id, actorUserId: w.user2Id });
    clearSignatureVerifyCache();
    const st = await status(g);
    expect(st).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
    expect(st.signatures.map((x) => x.id)).toEqual([s]);
  });

  it('control: a merged source\'s revoked-passkey signature still reads valid (merge moves neither signer nor owner)', async () => {
    const { g, s, passkeyId } = await signGrant();
    await revoke(passkeyId);
    await mergeUsers(db, { sourceUserId: w.user2Id, targetUserId: w.userId });
    clearSignatureVerifyCache();
    const st = await status(g);
    expect(st).toMatchObject({ integrityProblems: 0 });
    expect(st.signatures.map((x) => [x.id, x.signerId])).toEqual([[s, w.user2Id]]);
  });
});

describe('node read path (Node.signatureStatus, status.ts)', () => {
  let signerId: string;
  let otherId: string;
  let memoryId: string;
  let nodeId: string;
  let key: SoftPasskey;
  let passkeyId: string;

  beforeEach(async () => {
    otherId = (await db.user.create({ data: { githubId: 3827101, githubUsername: 'binding-other', roles: [] } })).id;
    signerId = (await db.user.create({ data: { githubId: 3827102, githubUsername: 'binding-signer', roles: [] } })).id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'binding-org', graphName: 'binding' });
    memoryId = graph.id;
    nodeId = (await createDbNode(db, { loc: 'policies:retention', memoryId, name: 'Retention', content: 'Retention is 30 days.' })).id;
    key = softPasskey();
    passkeyId = await insertSoftPasskey(db, signerId, key, { label: 'YubiKey 5C' });
  });

  /** One completed request and its record, through the real completion path. */
  async function signNode(as: string = signerId): Promise<string> {
    const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
      memoryId, requester: { userId: otherId, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
    }));
    const assertion = key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: req.nodeId, approvalHash: req.approvalHash, requestId: req.id }),
      origin: ORIGIN, rpId: RP,
    });
    await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
      memoryId, signerId: as, credentialId: key.credentialId, assertion, mayWrite: async () => true,
    }));
    return (await db.nodeSignature.findFirstOrThrow({ where: { signingRequestId: req.id } })).id;
  }
  const status = async () => (await loadSignatureStatuses(db, [nodeId])).get(nodeId)!;

  it('baseline: a verifying record reads CURRENT, credited to its signer', async () => {
    const s = await signNode();
    const st = await status();
    expect(st).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
    expect(st.signatures.map((x) => [x.id, x.signerId])).toEqual([[s, signerId]]);
  });

  it('RED: a record whose signer_id alone was changed is an integrity problem, never credited to the other user', async () => {
    const s = await signNode();
    await forge('node_signatures', s, 'signer_id = $2', otherId);
    expect(await status()).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('RED: the binding is checked on every read, not cached with an earlier verdict for the record', async () => {
    const s = await signNode();
    expect((await status()).state).toBe('CURRENT');
    await forge('node_signatures', s, 'signer_id = $2', otherId);
    expect(await status()).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  /** Supersede the record: the node's content changes after it was signed (EARLIER, not CURRENT). */
  const supersede = () => db.node.update({ where: { id: nodeId }, data: { content: 'Retention is 90 days.' } });

  it('control: a superseded record that is otherwise intact reads EARLIER, credited to its signer', async () => {
    const s = await signNode();
    await supersede();
    const st = await status();
    expect(st).toMatchObject({ state: 'EARLIER', integrityProblems: 0 });
    expect(st.signatures.map((x) => [x.id, x.signerId])).toEqual([[s, signerId]]);
  });

  it('a superseded record whose signer_id alone was changed is an integrity problem, never listed as EARLIER', async () => {
    const s = await signNode();
    await supersede();
    await forge('node_signatures', s, 'signer_id = $2', otherId);
    expect(await status()).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('control: a corrupt assertion is still an integrity problem', async () => {
    const s = await signNode();
    await corrupt('node_signatures', s);
    expect(await status()).toEqual({ state: null, signatures: [], integrityProblems: 1 });
  });

  it('control: completing through the real write path as a user who does not own the passkey is refused, and no record is written', async () => {
    await expect(signNode(otherId)).rejects.toThrow(/did not verify/);
    expect(await db.nodeSignature.count({ where: { nodeId } })).toBe(0);
  });

  it('control: an ordinary UPDATE of signer_id is refused by the append-only guard', async () => {
    const s = await signNode();
    await expect(exec('UPDATE node_signatures SET signer_id = $2 WHERE id = $1', s, otherId)).rejects.toThrow(/append-only/);
  });

  it('control: an erased signer\'s record still reads valid (the passkey keeps its owner)', async () => {
    const s = await signNode();
    await deleteUserAccount(db, { targetUserId: signerId, actorUserId: signerId });
    clearSignatureVerifyCache();
    const st = await status();
    expect(st).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
    expect(st.signatures.map((x) => x.id)).toEqual([s]);
  });

  it('control: a merged source\'s revoked-passkey signature still reads valid (merge moves neither signer nor owner)', async () => {
    const s = await signNode();
    await revoke(passkeyId);
    await mergeUsers(db, { sourceUserId: signerId, targetUserId: otherId });
    clearSignatureVerifyCache();
    const st = await status();
    expect(st).toMatchObject({ integrityProblems: 0 });
    expect(st.signatures.map((x) => [x.id, x.signerId])).toEqual([[s, signerId]]);
  });
});
