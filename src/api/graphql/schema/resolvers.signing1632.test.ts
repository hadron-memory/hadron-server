/**
 * #1632 (S2b-1) — the GraphQL surface of signing: who may request, withdraw
 * and read (cor:dmo:130:02/:03/:06), the batch-loaded signatureStatus, and the
 * refusals named in the contract note (issuecomment-6148958707).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { generateId } from '../../../lib/id.js';
import { signaturePayloadBytes } from '../../../lib/signing/payload.js';
import { completeSigningRequestInTransaction } from '../../../lib/signing/requests.js';
import { clearSignatureVerifyCache } from '../../../lib/signing/verify.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';
import { maySignInMemory } from './resolvers.signing.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let admin: { id: string };
let writer: { id: string };
let reader: { id: string };
let outsider: { id: string };
let memory: { id: string };

const as = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const N = (resolvers as unknown as { Node: Record<string, (n: any, a: unknown, c: Context) => Promise<any>> }).Node;
const R = (resolvers as unknown as { SigningRequest: Record<string, (r: any, a: unknown, c: Context) => any> }).SigningRequest;

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const node = (loc: string, content = `Body ${loc}`) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, content },
});
const request = (nodeRef: string, userId = reader.id, args: Record<string, unknown> = {}, extra: Partial<Context> = {}) =>
  M.requestNodeSignature(null, { nodeRef, ...args }, as(userId, extra));

async function signAs(req: { id: string; nodeId: string; approvalHash: string }, userId = writer.id) {
  const key = softPasskey();
  await insertSoftPasskey(db, userId, key, { label: 'Laptop' });
  const payload = signaturePayloadBytes('hadron-signature-v3', { nodeId: req.nodeId, approvalHash: req.approvalHash, requestId: req.id });
  return db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId: memory.id, signerId: userId, credentialId: key.credentialId,
    assertion: key.assert({ payload, origin: ORIGIN, rpId: RP }), mayWrite: maySignInMemory(db),
  }));
}

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Signing Org', urn: 'signing-1632.example' } });
  admin = await db.user.create({ data: { githubId: 163201, githubUsername: 'sg-admin', handle: 'sg-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 163202, githubUsername: 'sg-writer', handle: 'sg-writer', roles: [] } });
  reader = await db.user.create({ data: { githubId: 163203, githubUsername: 'sg-reader', handle: 'sg-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 163204, githubUsername: 'sg-outsider', handle: 'sg-outsider', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'policies' }, as(admin.id));
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
});

describe('requestNodeSignature (cor:dmo:130:03)', () => {
  it('any reader may ask; the request pins the current revision and records the requester', async () => {
    const n = await node('p:1');
    await db.session.create({ data: { id: 'sess-1', userId: reader.id } });
    const req = await request(n.id, reader.id, {}, { sessionId: 'sess-1' });
    expect(req).toMatchObject({ nodeId: n.id, revision: 1, state: 'open', requesterUserId: reader.id, requesterSessionId: 'sess-1' });
    expect(R.state(req, {}, as(reader.id))).toBe('OPEN');
    expect(R.requestedBy(req, {}, as(reader.id))).toEqual({ userId: reader.id, appId: null, workerId: null, sessionId: 'sess-1' });
  });

  it('a non-reader gets NODE_NOT_FOUND, the same as an unknown ref', async () => {
    const n = await node('p:2');
    expect(await codeOf(request(n.id, outsider.id))).toBe('NODE_NOT_FOUND');
    expect(await codeOf(request(generateId(), reader.id))).toBe('NODE_NOT_FOUND');
  });

  it('refuses a comment (COMMENT_NOT_SIGNABLE) and a stale revision', async () => {
    const n = await node('p:3');
    const c = await M.createComment(null, { targetRef: n.id, body: 'Looks off' }, as(writer.id));
    expect(await codeOf(request(c.id))).toBe('COMMENT_NOT_SIGNABLE');
    expect(await codeOf(request(n.id, reader.id, { expectedRevision: 9 }))).toBe('REVISION_MISMATCH');
  });

  it('refuses an encrypted memory with ENCRYPTED_MEMORY_NOT_APPLICABLE', async () => {
    const n = await node('p:4');
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(await codeOf(request(n.id, admin.id))).toBe('ENCRYPTED_MEMORY_NOT_APPLICABLE');
  });

  it('an impersonation session may not ask', async () => {
    const n = await node('p:5');
    const impersonation = { sessionId: 'imp', actorUserId: admin.id, orgId: 'x' } as unknown as Context['impersonation'];
    expect(await codeOf(request(n.id, reader.id, {}, { impersonation }))).toBe('FORBIDDEN');
  });

  it('names a signer, and refuses one that does not exist', async () => {
    const n = await node('p:6');
    expect((await request(n.id, reader.id, { signerRef: writer.id })).namedSignerId).toBe(writer.id);
    expect(await codeOf(request(n.id, reader.id, { signerRef: 'ghost' }))).toBe('SIGNER_NOT_FOUND');
  });

  it('refuses a named signer who may not write the memory with SIGNER_NOT_A_WRITER, writing nothing (#1904, cor:dmo:130:03 S17)', async () => {
    const n = await node('p:7');
    // A READER of the memory, and someone outside its org entirely.
    expect(await codeOf(request(n.id, writer.id, { signerRef: reader.id }))).toBe('SIGNER_NOT_A_WRITER');
    expect(await codeOf(request(n.id, reader.id, { signerRef: outsider.id }))).toBe('SIGNER_NOT_A_WRITER');
    expect(await db.signingRequest.count()).toBe(0);
    // Writers are accepted: a CONTRIBUTOR and an org ADMIN.
    expect((await request(n.id, reader.id, { signerRef: writer.id })).namedSignerId).toBe(writer.id);
    expect((await request(n.id, reader.id, { signerRef: admin.id })).namedSignerId).toBe(admin.id);
  });

  it('a named writer demoted after the request is still refused when they sign (the completion re-check is unchanged)', async () => {
    const n = await node('p:8');
    const req = await request(n.id, reader.id, { signerRef: writer.id });
    await db.orgMember.updateMany({ where: { userId: writer.id }, data: { role: 'READER' } });
    await expect(signAs(req, writer.id)).rejects.toMatchObject({ code: 'SIGNER_NOT_ELIGIBLE' });
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('open');
    expect(await db.nodeSignature.count()).toBe(0);
  });
});

describe('withdrawSigningRequest (#10024, #10397)', () => {
  it('the requester withdraws from another session; another reader may not; an outsider sees NOT_FOUND', async () => {
    const n = await node('w:1');
    await db.session.create({ data: { id: 'a', userId: reader.id } });
    const req = await request(n.id, reader.id, {}, { sessionId: 'a' });
    expect(await codeOf(M.withdrawSigningRequest(null, { id: req.id }, as(writer.id)))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect(await codeOf(M.withdrawSigningRequest(null, { id: req.id }, as(outsider.id)))).toBe('SIGNING_REQUEST_NOT_FOUND');
    const done = await M.withdrawSigningRequest(null, { id: req.id }, as(reader.id, { sessionId: 'b' }));
    expect(R.state(done, {}, as(reader.id))).toBe('WITHDRAWN');
    expect(await codeOf(M.withdrawSigningRequest(null, { id: req.id }, as(reader.id)))).toBe('SIGNING_REQUEST_ENDED');
  });
});

describe('reading requests and signatures (cor:dmo:130:06, #10019)', () => {
  it('signingRequest is null for an unknown id and for a non-reader', async () => {
    const n = await node('r:1');
    const req = await request(n.id);
    expect(await Q.signingRequest(null, { id: req.id }, as(writer.id))).toMatchObject({ id: req.id });
    expect(await Q.signingRequest(null, { id: req.id }, as(outsider.id))).toBeNull();
    expect(await Q.signingRequest(null, { id: 'nope' }, as(writer.id))).toBeNull();
  });

  it('an open request past its deadline reads EXPIRED, ending at the deadline', async () => {
    const n = await node('r:2');
    const req = await request(n.id);
    const past = { ...req, expiresAt: new Date(Date.now() - 1000) };
    expect(R.state(past, {}, as(reader.id))).toBe('EXPIRED');
    expect(R.endedAt(past, {}, as(reader.id))).toEqual(past.expiresAt);
  });

  it('a completed request carries its signature; Node.signatureStatus lists it CURRENT, with the label only', async () => {
    const n = await node('r:3');
    const req = await request(n.id);
    await signAs(req);
    const completed = await Q.signingRequest(null, { id: req.id }, as(reader.id));
    expect(R.state(completed, {}, as(reader.id))).toBe('COMPLETED');
    const sig = await R.signature(completed, {}, as(reader.id));
    expect(sig).toMatchObject({ signerId: writer.id, passkeyLabel: 'Laptop', revision: 1, state: 'CURRENT' });
    const status = await N.signatureStatus({ id: n.id }, {}, as(reader.id));
    expect(status.state).toBe('CURRENT');
    expect(Object.keys(status.signatures[0])).not.toContain('publicKey');
  });

  it('only a writer of the memory may sign: a reader is not eligible', async () => {
    expect(await maySignInMemory(db)(writer.id, memory.id)).toBe(true);
    expect(await maySignInMemory(db)(reader.id, memory.id)).toBe(false);
    expect(await maySignInMemory(db)(outsider.id, memory.id)).toBe(false);
  });

  it('signingRequests lists newest first and filters on the effective state', async () => {
    const n = await node('r:4');
    const a = await request(n.id);
    const b = await request(n.id);
    await M.withdrawSigningRequest(null, { id: a.id }, as(reader.id));
    const all = await N.signingRequests({ id: n.id }, {}, as(reader.id));
    expect(all.map((r: { id: string }) => r.id)).toEqual([b.id, a.id]);
    const withdrawn = await N.signingRequests({ id: n.id }, { state: 'WITHDRAWN' }, as(reader.id));
    expect(withdrawn.map((r: { id: string }) => r.id)).toEqual([a.id]);
  });

  it('a list page resolves signatureStatus for many nodes in one batched load', async () => {
    const nodes = await Promise.all(['b:1', 'b:2', 'b:3'].map((l) => node(l)));
    for (const n of nodes) await signAs(await request(n.id));
    clearSignatureVerifyCache();
    const spy = vi.spyOn(db.nodeSignature, 'findMany');
    const ctx = as(reader.id);
    const statuses = await Promise.all(nodes.map((n) => N.signatureStatus({ id: n.id }, {}, ctx)));
    expect(statuses.map((s) => s.state)).toEqual(['CURRENT', 'CURRENT', 'CURRENT']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
