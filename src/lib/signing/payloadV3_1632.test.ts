/**
 * #1632 S2b-2 (cor:dmo:130:01, R80, R81 / cor:dmo:130:03 S19) — the v3 signature payload, v3-only verification,
 * and the deploy-time end of requests still open with a v1 pin.
 *
 * The expected bytes come from the DRAFT conformance fixture (draft PR #2104, `signaturePayload.v3.fixture.draft.json`),
 * generated with Python hashlib. Every expectation below is also recomputed here without the builder under test
 * (a literal string template and Node's SHA-256), so a wrong builder cannot agree with itself.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import {
  CURRENT_SIGNATURE_PAYLOAD_VERSION, SIGNATURE_PAYLOAD_V3, signatureChallenge, signaturePayloadBytes,
  UnsupportedSignaturePayloadError,
} from './payload.js';
import { clearSignatureVerifyCache, signatureRecordVerifies } from './verify.js';
import { createSigningRequestInTransaction, newSigningRequestId } from './requests.js';

interface V3Case {
  name: string; nodeId: string; approvalHash: string; requestId: string;
  payloadUtf8: string; canonical: string; challengeHex: string; challengeBase64url: string;
}
const fixture = JSON.parse(readFileSync('src/lib/signaturePayload.v3.fixture.draft.json', 'utf8')) as { cases: V3Case[] };

describe('v3 payload bytes match the draft conformance fixture byte for byte (R80)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const bytes = signaturePayloadBytes('hadron-signature-v3', { nodeId: c.nodeId, approvalHash: c.approvalHash, requestId: c.requestId });
      // Independent of the builder: the spec's three lines plus the request line, LF after each, no CR.
      const literal = `hadron-signature-v3\nnode ${c.nodeId}\napproval-hash ${c.approvalHash}\nrequest ${c.requestId}\n`;
      expect(bytes.toString('utf8')).toBe(literal);
      expect(bytes.toString('utf8')).toBe(c.payloadUtf8);
      expect(bytes.toString('base64')).toBe(c.canonical);
      expect(createHash('sha256').update(literal, 'utf8').digest('hex')).toBe(c.challengeHex);
      expect(signatureChallenge(bytes).toString('hex')).toBe(c.challengeHex);
      expect(signatureChallenge(bytes).toString('base64url')).toBe(c.challengeBase64url);
    });
  }

  it('binds the request: two requests on one node, or one request id on two nodes, never share a challenge', () => {
    const by = Object.fromEntries(fixture.cases.map((c) => [c.name, c.challengeHex]));
    expect(new Set(Object.values(by)).size).toBe(fixture.cases.length);
  });

  it('is the current version, and the only one a server builds', () => {
    expect(CURRENT_SIGNATURE_PAYLOAD_VERSION).toBe(SIGNATURE_PAYLOAD_V3);
    const ok = { nodeId: 'n', approvalHash: 'a'.repeat(64), requestId: 'AAAAAAAAAAAAAAAAAAAAAA' };
    // R80: v1 is no longer produced anywhere, v2 stays retired.
    expect(() => signaturePayloadBytes('hadron-signature-v1', ok)).toThrow(UnsupportedSignaturePayloadError);
    expect(() => signaturePayloadBytes('hadron-signature-v2', ok)).toThrow(UnsupportedSignaturePayloadError);
    expect(() => signaturePayloadBytes('hadron-signature-v3', ok)).not.toThrow();
  });

  it('refuses a v3 payload with no usable request line, never guessing one', () => {
    const base = { nodeId: 'n', approvalHash: 'a'.repeat(64) };
    for (const requestId of [undefined, '', 'short', 'A'.repeat(23), 'AAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAA\n', 'AAAAAAAAAAAAAAAAAAAA A', 'AAAAAAAAAAAAAAAAAAAA+/']) {
      // The refusal is about the request line, not about the version being unsupported.
      expect(() => signaturePayloadBytes('hadron-signature-v3', { ...base, requestId })).toThrow(/request id/);
    }
    expect(() => signaturePayloadBytes('hadron-signature-v3', { ...base, requestId: 'AAAAAAAAAAAAAAAAAAAAAA' })).not.toThrow();
  });

  it('keeps refusing a malformed node id or approval hash', () => {
    const ok = { nodeId: 'n', approvalHash: 'a'.repeat(64), requestId: 'AAAAAAAAAAAAAAAAAAAAAA' };
    expect(() => signaturePayloadBytes('hadron-signature-v3', ok)).not.toThrow();
    expect(() => signaturePayloadBytes('hadron-signature-v3', { ...ok, approvalHash: 'A'.repeat(64) })).toThrow(/approval hash/);
    expect(() => signaturePayloadBytes('hadron-signature-v3', { ...ok, nodeId: 'a\nb' })).toThrow(/node id/);
  });

  it('every id the server mints is a legal request line', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(() => signaturePayloadBytes('hadron-signature-v3', { nodeId: 'n', approvalHash: 'a'.repeat(64), requestId: newSigningRequestId() })).not.toThrow();
    }
  });
});

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

describe('the verifier accepts v3 only, and new requests pin v3 (R80, R81)', () => {
  let signerId: string;
  let memoryId: string;
  let nodeId: string;
  let key: SoftPasskey;

  beforeEach(async () => {
    await cleanDb(db);
    clearSignatureVerifyCache();
    process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
    process.env.PASSKEY_RP_ID = RP;
    signerId = (await db.user.create({ data: { githubId: 1632201, githubUsername: 'v3-signer', roles: [] } })).id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'v3-org', graphName: 'v3' });
    memoryId = graph.id;
    nodeId = (await createDbNode(db, { loc: 'policies:v3', memoryId, name: 'V3', content: 'Body.' })).id;
    key = softPasskey();
    await insertSoftPasskey(db, signerId, key, { label: 'key' });
  });
  afterEach(() => {
    delete process.env.SIGNING_CEREMONY_ORIGINS;
    delete process.env.PASSKEY_RP_ID;
  });

  it('a new request pins hadron-signature-v3', async () => {
    const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
      memoryId, requester: { userId: signerId, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
    }));
    expect(req.payloadVersion).toBe('hadron-signature-v3');
  });

  it('re-verification: a v3 record verifies, and a v1 record over its own v1 bytes does NOT (no v1 fallback)', async () => {
    const approvalHash = 'b'.repeat(64);
    const requestId = newSigningRequestId();
    const cred = await db.passkeyCredential.findFirstOrThrow({ where: { ownerId: signerId } });
    const credential = { credentialId: Buffer.from(cred.credentialId), publicKey: Buffer.from(cred.publicKey), counter: 0n };
    const record = (version: string, payload: Buffer, id: string) => {
      const a = key.assert({ payload, origin: ORIGIN, rpId: RP });
      return { id, nodeId, approvalHash, requestId, payloadVersion: version,
        authenticatorData: a.authenticatorData, clientDataJson: a.clientDataJson, signature: a.signature };
    };
    const v3 = Buffer.from(`hadron-signature-v3\nnode ${nodeId}\napproval-hash ${approvalHash}\nrequest ${requestId}\n`, 'utf8');
    const v1 = Buffer.from(`hadron-signature-v1\nnode ${nodeId}\napproval-hash ${approvalHash}\n`, 'utf8');
    expect(await signatureRecordVerifies(record('hadron-signature-v3', v3, 'r-v3'), credential, RP)).toBe(true);
    // A genuine v1 assertion over genuine v1 bytes: valid cryptography, refused by version.
    expect(await signatureRecordVerifies(record('hadron-signature-v1', v1, 'r-v1'), credential, RP)).toBe(false);
  });
});

describe('R81 / cor:dmo:130:03 S19: requests still open with a v1 pin end stale at the v3 deploy', () => {
  const MIGRATION = 'prisma/migrations/20261101130000_signing_v3_stale_open_v1/migration.sql';
  let userId: string;
  let nodeId: string;

  async function insertRequest(id: string, version: string, state = 'open', ttl = '1 hour') {
    await db.$executeRawUnsafe(
      `INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, requester_user_id, expires_at)
       VALUES ($1, $2, 1, $3, $4, $5, (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) + interval '${ttl}')`,
      id, nodeId, 'c'.repeat(64), version, userId);
    if (state !== 'open') await db.$executeRawUnsafe(`UPDATE signing_requests SET state = $2 WHERE id = $1`, id, state);
  }
  const stateOf = async (id: string) => (await db.signingRequest.findUniqueOrThrow({ where: { id } }));

  beforeEach(async () => {
    await cleanDb(db);
    userId = (await db.user.create({ data: { githubId: 1632301, githubUsername: 'v3-mig', roles: [] } })).id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'mig-org', graphName: 'mig' });
    nodeId = (await createDbNode(db, { loc: 'policies:mig', memoryId: graph.id, name: 'M', content: 'x' })).id;
  });

  it('stales every open v1 request, keeps it as an ended record, and leaves v3, ended and other rows alone', async () => {
    await insertRequest('openv1aaaaaaaaaaaaaaaaaa', 'hadron-signature-v1');
    await insertRequest('openv3bbbbbbbbbbbbbbbbbb', 'hadron-signature-v3');
    await insertRequest('wdrawv1ccccccccccccccc', 'hadron-signature-v1', 'withdrawn');
    await insertRequest('declv1dddddddddddddddd', 'hadron-signature-v1', 'declined');
    await db.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
    const staled = await stateOf('openv1aaaaaaaaaaaaaaaaaa');
    expect(staled.state).toBe('stale');
    expect(staled.endedAt).not.toBeNull();
    expect(staled.payloadVersion).toBe('hadron-signature-v1');
    expect((await stateOf('openv3bbbbbbbbbbbbbbbbbb')).state).toBe('open');
    expect((await stateOf('wdrawv1ccccccccccccccc')).state).toBe('withdrawn');
    expect((await stateOf('declv1dddddddddddddddd')).state).toBe('declined');
  });

  it('is safe to run twice (a deploy can be retried)', async () => {
    await insertRequest('openv1eeeeeeeeeeeeeeeeee', 'hadron-signature-v1');
    await db.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
    const first = await stateOf('openv1eeeeeeeeeeeeeeeeee');
    await db.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
    const second = await stateOf('openv1eeeeeeeeeeeeeeeeee');
    expect(second.state).toBe('stale');
    expect(second.endedAt).toEqual(first.endedAt);
  });

  it('records how many it ended in the deploy output', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/hadron-signature-v1/);
  });
});
