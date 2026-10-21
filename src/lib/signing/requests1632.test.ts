/**
 * #1632 / cor:dmo:130:02–:04 (S2b-1) — signing requests end to end against a
 * real database and a real (software) passkey: create, withdraw, decline,
 * complete with server-side verification, and the derived signature state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph, createDbWorkerAttribution } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { computeApprovalHash } from '../approvalHash.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V1 } from './payload.js';
import { SigningNotConfiguredError } from './config.js';
import { clearSignatureVerifyCache, signatureRecordVerifies } from './verify.js';
import { loadSignatureStatuses } from './status.js';
import {
  completeSigningRequestInTransaction, createSigningRequestInTransaction, declineSigningRequestInTransaction,
  effectiveRequestState, SigningRefusal, withdrawSigningRequestInTransaction, type SigningRequester,
} from './requests.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let requesterId: string;
let signerId: string;
let memoryId: string;
let nodeId: string;
let key: SoftPasskey;

const asUser = (userId: string, extra: Partial<SigningRequester> = {}): SigningRequester =>
  ({ userId, appId: null, workerId: null, sessionId: null, ...extra });
const writer = async () => true;
const notWriter = async () => false;

async function refusal(p: Promise<unknown>): Promise<SigningRefusal> {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(SigningRefusal);
  return e as SigningRefusal;
}

const create = (opts: Partial<Parameters<typeof createSigningRequestInTransaction>[2]> & { node?: string } = {}) =>
  db.$transaction((tx) => createSigningRequestInTransaction(tx, opts.node ?? nodeId, {
    memoryId, requester: asUser(requesterId), mayWrite: writer, ...opts,
  }));

function assertionFor(req: { nodeId: string; approvalHash: string }, over: Partial<Parameters<SoftPasskey['assert']>[0]> = {}) {
  const payload = signaturePayloadBytes(SIGNATURE_PAYLOAD_V1, { nodeId: req.nodeId, approvalHash: req.approvalHash });
  return key.assert({ payload, origin: ORIGIN, rpId: RP, ...over });
}

const complete = (req: { id: string; nodeId: string; approvalHash: string }, opts: {
  signer?: string; mayWrite?: (u: string, m: string) => Promise<boolean>; credentialId?: Buffer;
  assertion?: ReturnType<SoftPasskey['assert']>;
} = {}) => db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
  memoryId, signerId: opts.signer ?? signerId, credentialId: opts.credentialId ?? key.credentialId,
  assertion: opts.assertion ?? assertionFor(req), mayWrite: opts.mayWrite ?? writer,
}));

const status = async () => (await loadSignatureStatuses(db, [nodeId])).get(nodeId)!;

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.SIGNING_REQUEST_TTL_SECONDS;
  requesterId = (await db.user.create({ data: { githubId: 1632101, githubUsername: 'sig-requester', roles: [] } })).id;
  signerId = (await db.user.create({ data: { githubId: 1632102, githubUsername: 'sig-signer', roles: [] } })).id;
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'sig-org', graphName: 'sig' });
  memoryId = graph.id;
  nodeId = (await createDbNode(db, { loc: 'policies:retention', memoryId, name: 'Retention', content: 'Retention is 30 days.' })).id;
  key = softPasskey();
  await insertSoftPasskey(db, signerId, key, { label: 'YubiKey 5C' });
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
});

describe('requestNodeSignature: what a request pins (cor:dmo:130:03)', () => {
  it('opens on the current revision with the v1 approval hash and a 24h default lifetime', async () => {
    const req = await create();
    expect(req.state).toBe('open');
    expect(req.revision).toBe(1);
    expect(req.payloadVersion).toBe('hadron-signature-v1');
    expect(req.approvalHash).toBe(computeApprovalHash({ title: 'Retention', abstract: null, content: 'Retention is 30 days.' }));
    expect(req.requesterUserId).toBe(requesterId);
    expect(req.id).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits, base64url
    // created_at is stamped by the guard a moment after expires_at is computed,
    // so allow the statement's own runtime.
    const ttl = req.expiresAt.getTime() - req.createdAt.getTime();
    expect(Math.abs(ttl - 24 * 60 * 60 * 1000)).toBeLessThan(1000);
  });

  it('honours SIGNING_REQUEST_TTL_SECONDS', async () => {
    process.env.SIGNING_REQUEST_TTL_SECONDS = '600';
    const req = await create();
    expect(Math.abs(req.expiresAt.getTime() - req.createdAt.getTime() - 600_000)).toBeLessThan(1000);
  });

  it('pins a named signer, and refuses one that does not exist', async () => {
    expect((await create({ namedSignerId: signerId })).namedSignerId).toBe(signerId);
    expect((await refusal(create({ namedSignerId: 'no-such-user' }))).code).toBe('SIGNER_NOT_FOUND');
  });

  it('refuses a named signer who may not write the memory (SIGNER_NOT_A_WRITER, #1904) and writes nothing', async () => {
    const asked: Array<[string, string]> = [];
    const recordingNotWriter = async (u: string, m: string) => { asked.push([u, m]); return false; };
    const r = await refusal(create({ namedSignerId: signerId, mayWrite: recordingNotWriter }));
    expect(r.code).toBe('SIGNER_NOT_A_WRITER');
    // The shared policy is asked about the named signer in the node's memory, not the requester.
    expect(asked).toEqual([[signerId, memoryId]]);
    expect(await db.signingRequest.count()).toBe(0);
  });

  it('a missing signer is still SIGNER_NOT_FOUND, decided before the write check', async () => {
    let consulted = false;
    const r = await refusal(create({ namedSignerId: 'no-such-user', mayWrite: async () => { consulted = true; return false; } }));
    expect(r.code).toBe('SIGNER_NOT_FOUND');
    expect(consulted).toBe(false);
  });

  it('an unnamed request does not consult the write policy: any writer may sign later', async () => {
    let consulted = false;
    const req = await create({ mayWrite: async () => { consulted = true; return false; } });
    expect(req.state).toBe('open');
    expect(consulted).toBe(false);
  });

  it('records an App as the requester only when the App itself asks', async () => {
    await createDbWorkerAttribution(db, requesterId, 'w-1', 's-1');
    const app = await create({ requester: { userId: null, appId: 'app-1', workerId: 'w-1', sessionId: 's-1' } });
    expect(app.requesterAppId).toBe('app-1');
    const person = await create({ requester: { userId: requesterId, appId: 'app-1', workerId: null, sessionId: null } });
    expect(person.requesterUserId).toBe(requesterId);
    expect(person.requesterAppId).toBeNull();
  });

  // A comment (COMMENT_NOT_SIGNABLE) is pinned in the GraphQL tests, where the comment path exists.
  it('refuses a placeholder, a stale revision, an encrypted memory and a foreign memory', async () => {
    const placeholder = await db.node.create({ data: { memoryId, loc: 'p:1', name: 'p', ownerRepo: 'x', isPlaceholder: true } });
    expect((await refusal(create({ node: placeholder.id }))).code).toBe('NODE_IS_PLACEHOLDER');
    expect((await refusal(create({ expectedRevision: 7 }))).code).toBe('REVISION_MISMATCH');
    const other = (await createDbOrgAndGraph(db, { orgName: 'sig-org-2', graphName: 'other' })).graph;
    expect((await refusal(db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
      memoryId: other.id, requester: asUser(requesterId), mayWrite: writer })))).code).toBe('NODE_NOT_FOUND');
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    const enc = await refusal(create());
    expect(enc.code).toBe('ENCRYPTED_MEMORY_NOT_APPLICABLE');
  });
});

describe('withdraw: the requester account, from any session (#10024, #10397)', () => {
  const withdraw = (id: string, caller: { userId: string | null; appId: string | null }) =>
    db.$transaction((tx) => withdrawSigningRequestInTransaction(tx, id, { memoryId, caller }));

  it('the same user withdraws, whichever session or worker asks', async () => {
    await createDbWorkerAttribution(db, requesterId, 'w-a', 's-a');
    const req = await create({ requester: asUser(requesterId, { sessionId: 's-a', workerId: 'w-a' }) });
    const done = await withdraw(req.id, { userId: requesterId, appId: 'some-app' });
    expect(done.state).toBe('withdrawn');
    expect(done.endedAt).toBeInstanceOf(Date);
  });

  it('another user, or an App standing in for a user\'s request, may not', async () => {
    const req = await create();
    expect((await refusal(withdraw(req.id, { userId: signerId, appId: null }))).code).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect((await refusal(withdraw(req.id, { userId: null, appId: 'app-1' }))).code).toBe('SIGNING_REQUEST_NOT_REQUESTER');
  });

  it('an App request is withdrawn by that App, not by a person', async () => {
    const req = await create({ requester: { userId: null, appId: 'app-1', workerId: null, sessionId: null } });
    expect((await refusal(withdraw(req.id, { userId: requesterId, appId: null }))).code).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect((await withdraw(req.id, { userId: null, appId: 'app-1' })).state).toBe('withdrawn');
  });

  it('an ended request cannot be withdrawn; an expired one reports EXPIRED and is stored as expired at its deadline', async () => {
    const req = await create();
    await withdraw(req.id, { userId: requesterId, appId: null });
    const again = await refusal(withdraw(req.id, { userId: requesterId, appId: null }));
    expect(again.code).toBe('SIGNING_REQUEST_ENDED');
    expect(again.details.state).toBe('WITHDRAWN');

    process.env.SIGNING_REQUEST_TTL_SECONDS = '60';
    const late = await create();
    await db.$executeRaw`UPDATE signing_requests SET state = state WHERE id = ${late.id}`; // no-op, still open
    expect(effectiveRequestState(late, new Date(late.expiresAt.getTime() + 1))).toBe('expired');
  });

  it('an unknown id and a request on another memory\'s node look the same', async () => {
    expect((await refusal(withdraw('nope', { userId: requesterId, appId: null }))).code).toBe('SIGNING_REQUEST_NOT_FOUND');
    const req = await create();
    const other = (await createDbOrgAndGraph(db, { orgName: 'sig-org-3', graphName: 'o3' })).graph;
    expect((await refusal(db.$transaction((tx) => withdrawSigningRequestInTransaction(tx, req.id, {
      memoryId: other.id, caller: { userId: requesterId, appId: null } })))).code).toBe('SIGNING_REQUEST_NOT_FOUND');
  });
});

describe('complete: server-side verification, one record, one end (cor:dmo:130:02)', () => {
  it('records a verified signature and completes the request', async () => {
    const req = await create();
    const done = await complete(req);
    expect(done.state).toBe('completed');
    const records = await db.nodeSignature.findMany();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ signerId, revision: 1, approvalHash: req.approvalHash, signingRequestId: req.id, rpId: RP });
    const s = await status();
    expect(s.state).toBe('CURRENT');
    expect(s.signatures[0]).toMatchObject({ signerId, passkeyLabel: 'YubiKey 5C', revision: 1, state: 'CURRENT' });
    expect(s.integrityProblems).toBe(0);
  });

  it('refuses a second completion of the same request', async () => {
    const req = await create();
    await complete(req);
    expect((await refusal(complete(req))).code).toBe('SIGNING_REQUEST_ENDED');
    expect(await db.nodeSignature.count()).toBe(1);
  });

  it('refuses a wrong origin, no user verification, a wrong RP ID, a create-type assertion, and another payload', async () => {
    const req = await create();
    for (const over of [{ origin: 'https://portal.example.test' }, { uv: false }, { rpId: 'evil.test' }, { type: 'webauthn.create' }]) {
      expect((await refusal(complete(req, { assertion: assertionFor(req, over) }))).code).toBe('SIGNATURE_NOT_VERIFIED');
    }
    const foreign = assertionFor({ nodeId: 'another-node', approvalHash: req.approvalHash });
    expect((await refusal(complete(req, { assertion: foreign }))).code).toBe('SIGNATURE_NOT_VERIFIED');
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
  });

  it('refuses a passkey that is not the signer\'s, or is revoked', async () => {
    const req = await create();
    const theirs = softPasskey();
    await insertSoftPasskey(db, requesterId, theirs);
    expect((await refusal(complete(req, { credentialId: theirs.credentialId,
      assertion: theirs.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V1, req), origin: ORIGIN, rpId: RP }) }))).code)
      .toBe('SIGNATURE_NOT_VERIFIED');
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE owner_id = ${signerId}`;
    expect((await refusal(complete(req))).code).toBe('SIGNATURE_NOT_VERIFIED');
  });

  it('refuses the signer\'s own passkey enrolled under another RP ID, even with a valid assertion for this one (#1631 PR1b)', async () => {
    const req = await create();
    const moved = softPasskey();
    await insertSoftPasskey(db, signerId, moved, { rpId: 'old.example' });
    expect((await refusal(complete(req, { credentialId: moved.credentialId,
      assertion: moved.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V1, req), origin: ORIGIN, rpId: RP }) }))).code)
      .toBe('SIGNATURE_NOT_VERIFIED');
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
    // Control: the same request completes with the passkey enrolled under this RP ID.
    expect((await complete(req)).state).toBe('completed');
  });

  it('only a writer of the memory, and only the named signer, may sign', async () => {
    const req = await create();
    expect((await refusal(complete(req, { mayWrite: notWriter }))).code).toBe('SIGNER_NOT_ELIGIBLE');
    const named = await create({ namedSignerId: requesterId });
    expect((await refusal(complete(named))).code).toBe('SIGNER_NOT_ELIGIBLE');
  });

  it('a request staled by a content edit cannot complete', async () => {
    const req = await create();
    await db.node.update({ where: { id: nodeId }, data: { content: 'Retention is 90 days.' } });
    const r = await refusal(complete(req));
    expect(r.code).toBe('SIGNING_REQUEST_ENDED');
    expect(r.details.state).toBe('STALE');
  });

  it('fails loud, not open, when no ceremony origin is configured', async () => {
    delete process.env.SIGNING_CEREMONY_ORIGINS;
    const req = await create();
    await expect(complete(req)).rejects.toBeInstanceOf(SigningNotConfiguredError);
  });
});

describe('decline (cor:dmo:130:03)', () => {
  it('the eligible signer declines once; a non-writer may not', async () => {
    const req = await create();
    const decline = (mayWrite: typeof writer) => db.$transaction((tx) =>
      declineSigningRequestInTransaction(tx, req.id, { memoryId, signerId, mayWrite }));
    expect((await refusal(decline(notWriter))).code).toBe('SIGNER_NOT_ELIGIBLE');
    expect((await decline(writer)).state).toBe('declined');
    expect((await refusal(decline(writer))).code).toBe('SIGNING_REQUEST_ENDED');
  });
});

describe('signature state on read (cor:dmo:130:04)', () => {
  it('reads EARLIER after a content change, and stays EARLIER when the old text is restored (#9824)', async () => {
    await complete(await create());
    await db.node.update({ where: { id: nodeId }, data: { content: 'Retention is 90 days.' } });
    expect((await status()).signatures[0].state).toBe('EARLIER');
    await db.node.update({ where: { id: nodeId }, data: { content: 'Retention is 30 days.' } });
    expect((await status()).signatures[0].state).toBe('EARLIER');
  });

  it('stays CURRENT across a tag or property change (#10015)', async () => {
    await complete(await create());
    await db.node.update({ where: { id: nodeId }, data: { tags: ['policy'], properties: { a: 1 } } });
    expect((await status()).state).toBe('CURRENT');
  });

  it('stays valid after PASSKEY_RP_ID changes: a domain change never invalidates old signatures (#10469/#10470)', async () => {
    await complete(await create());
    expect((await db.nodeSignature.findFirstOrThrow()).rpId).toBe(RP);
    clearSignatureVerifyCache();
    process.env.PASSKEY_RP_ID = 'renamed.test';
    const s = await status();
    expect(s.state).toBe('CURRENT');
    expect(s.integrityProblems).toBe(0);
  });

  it('re-verification uses the record\'s RP ID: any other RP ID does not verify', async () => {
    await complete(await create());
    const r = await db.nodeSignature.findFirstOrThrow({ include: { passkey: true } });
    const record = { id: r.id, nodeId: r.nodeId, approvalHash: r.approvalHash, payloadVersion: r.payloadVersion, requestId: r.signingRequestId,
      authenticatorData: Buffer.from(r.authenticatorData), clientDataJson: Buffer.from(r.clientDataJson), signature: Buffer.from(r.signature) };
    const cred = { credentialId: Buffer.from(r.passkey.credentialId), publicKey: Buffer.from(r.passkey.publicKey), counter: 0n };
    clearSignatureVerifyCache();
    expect(await signatureRecordVerifies(record, cred, r.rpId)).toBe(true);
    expect(await signatureRecordVerifies(record, cred, 'other.test')).toBe(false);
  });

  it('a record that does not verify is an integrity problem, never a signature', async () => {
    const req = await create();
    const credential = await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: signerId } });
    const good = assertionFor(req);
    // A forged record inserted beneath the API: right RP hash, wrong signature bytes.
    await db.$executeRaw`INSERT INTO node_signatures
      (id, node_id, signing_request_id, signer_id, passkey_credential_id, revision, approval_hash, payload_version,
       rp_id, authenticator_data, client_data_json, signature)
      VALUES ('forged', ${nodeId}, ${req.id}, ${signerId}, ${credential.id}, 1, ${req.approvalHash}, 'hadron-signature-v1',
        ${RP}, ${good.authenticatorData}, ${good.clientDataJson}, ${Buffer.from('not-a-signature')})`;
    const s = await status();
    expect(s.signatures).toEqual([]);
    expect(s.integrityProblems).toBe(1);
    expect(s.state).toBeNull();
  });

  it('reads NOT_APPLICABLE with no records listed once the memory is encrypted', async () => {
    await complete(await create());
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    const s = await status();
    expect(s).toEqual({ state: 'NOT_APPLICABLE', signatures: [], integrityProblems: 0 });
  });

  it('a first passkey\'s signature reads PENDING while its window is open', async () => {
    key = softPasskey();
    await db.$executeRaw`TRUNCATE TABLE node_signatures, signing_requests, sign_ins, passkey_credentials CASCADE`;
    await insertSoftPasskey(db, signerId, key, { firstWindow: true });
    await complete(await create());
    expect((await status()).signatures[0].state).toBe('PENDING');
    expect((await status()).state).toBe('PENDING');
  });

  it('automatic pruning keeps the revision a signature was made on (cor:dmo:130:05, #9901)', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 1 } });
    await complete(await create());
    const { createNodeRevision } = await import('../nodeRevisionSnapshot.js');
    const snap = async (content: string) => {
      const live = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
      await createNodeRevision(db, { nodeId, memoryId, loc: live.loc, name: live.name, content: live.content, tags: [] });
      await db.node.update({ where: { id: nodeId }, data: { content } });
    };
    await snap('edit one');   // snapshots r1, the signed revision
    await snap('edit two');   // snapshots r2; the cap of 1 would prune r1
    await snap('edit three'); // snapshots r3; prunes r2, still keeps r1
    const kept = (await db.nodeRevision.findMany({ where: { nodeId }, select: { revNo: true } })).map((r) => r.revNo).sort();
    expect(kept).toEqual([1, 3]);
  });

  it('a node with no records has the empty status', async () => {
    expect(await status()).toEqual({ state: null, signatures: [], integrityProblems: 0 });
  });
});
