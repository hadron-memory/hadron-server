/**
 * #2973 PR1 (cor:dmo:130:09, cor:agt:040:10 R35) — `revisionSignatureCounts`: the per-revision signature predicate the
 * signed serve selection and (PR3) the include `signed` setting share.
 *
 * Coverage is judged from the REVISION HISTORY, never from the live `content_changed_at` marker: every revision in
 * (the signature's revision, N] must still be witnessed by its snapshot and hash to the signed approval hash, so a
 * pruned or deliberately deleted snapshot inside the span fails CLOSED (a missing "no change" is not a "no change" —
 * deleting the A→B step of an A→B→A history must not revive coverage of the restored text).
 *
 * State (C2) re-verifies and reuses `deriveSignatureState`'s window logic with the DB signing clock
 * (`hadron_signing_now()`, the clock `loadSignatureStatuses` already judges windows by; #3746's
 * `hadron_passkey_now()` is the REGISTRATION and lifecycle-stamp clock, so the window fixtures below write their
 * stamps through it — the guard refuses anything else). Eligibility (C1, Q-E) is judged at signing through the
 * ceremony's own durable record — the completed signing request — and is never re-checked now, so a signer who has
 * since left still counts.
 *
 * Every seed respects the DB guards (`prisma/signing-invariants.sql`, `prisma/passkey-invariants.sql`): requests are
 * inserted OPEN and end once through guarded UPDATEs, signature records are only ever INSERTed (an invalid record is
 * seeded by inserting corrupted signature bytes, not by mutating a row — the rows are append-only), and first-key
 * windows are registered through the #3746 clock seam so their end can arrive in test time.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { generateId } from '../id.js';
import { computeApprovalHash } from '../approvalHash.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from './payload.js';
import { clearSignatureVerifyCache } from './verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction, newSigningRequestId } from './requests.js';
import { revisionSignatureCounts, type SignatureRequirement } from './revisionSignatureCounts.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const REQ: SignatureRequirement = 'compiled-boot-prompt';
const WINDOW_MS = 72 * 3600 * 1000;

let signerId: string;
let outsiderId: string;
let memoryId: string;
let nodeId: string;
let key: SoftPasskey;
let outsiderKey: SoftPasskey;

const asUser = (userId: string) => ({ userId, appId: null, workerId: null, sessionId: null });
const writer = async () => true;

/** Edit the node's content (a real title/abstract/content change → a new revision that breaks coverage). */
async function editContent(content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({
    data: { nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [] } as never,
  });
  await db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } });
}
/** A metadata-only edit: a new revision that leaves title, abstract and content unchanged. */
async function editMetaOnly() {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({
    data: { nodeId, memoryId, loc: n.loc, name: n.name, abstract: n.abstract, content: n.content, revNo: n.revSeq, tags: [] } as never,
  });
  await db.node.update({ where: { id: nodeId }, data: { revSeq: n.revSeq + 1, description: `meta ${n.revSeq + 1}` } });
}

/** A first passkey whose 72-hour window ends `msToEnd` from now, registered through the guard's own clock (#3746 seam). */
async function insertClosingFirstPasskey(ownerId: string, k: SoftPasskey, msToEnd: number): Promise<string> {
  const id = generateId();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.hadron_passkey_clock_offset() RETURNS interval LANGUAGE sql STABLE
      AS $$ SELECT interval '${-(WINDOW_MS - msToEnd)} milliseconds' $$`);
    await tx.$executeRaw`INSERT INTO passkey_credentials
      (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports,
       backup_eligible, backed_up, registration_method, window_ends_at)
      VALUES (${id}, ${ownerId}, ${k.credentialId}, ${k.cosePublicKey}, -7, ${Buffer.alloc(32, 7)}, ${RP}, 'Closing',
        public.hadron_passkey_now(), 0, ARRAY['internal'], false, false, 'github', public.hadron_passkey_now() + interval '72 hours')`;
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.hadron_passkey_clock_offset() RETURNS interval LANGUAGE sql STABLE
      AS $$ SELECT interval '0' $$`);
  });
  return id;
}

/** Wait until the database clock has passed the passkey's window end (the platform clock the window is judged by). */
async function pastWindowEnd(passkeyId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [{ past }] = await db.$queryRaw<Array<{ past: boolean }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') > window_ends_at AS past
      FROM passkey_credentials WHERE id = ${passkeyId}`;
    if (past) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('window never ended');
}

/**
 * Sign the node's CURRENT revision through the real ceremony (the signer was eligible when it was made). With
 * `closing`, signs with a first passkey whose window ends `msToEnd` from now, so the signature starts PENDING.
 */
async function signLive(node: string = nodeId, opts: { closingMs?: number } = {}) {
  key = softPasskey();
  const passkeyId = opts.closingMs != null
    ? await insertClosingFirstPasskey(signerId, key, opts.closingMs)
    : await insertSoftPasskey(db, signerId, key, { label: 'Signer key', rpId: RP });
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, node, {
    memoryId, requester: asUser(signerId), mayWrite: writer,
  }));
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId, signerId, credentialId: key.credentialId,
    assertion: key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: node, approvalHash: req.approvalHash, requestId: req.id }),
      origin: ORIGIN, rpId: RP,
    }),
    mayWrite: writer,
  }));
  return { req, passkeyId };
}

/**
 * Seed a signature pair DIRECTLY, bypassing the ceremony's `requireSigner` eligibility gate (the only way an
 * ineligible-at-signing signer can get a row: the ceremony prevents it). The request is inserted OPEN (a request
 * begins open) and may then end once, guarded: 'withdrawn' is a person's end; 'completed' is the DB shape only the
 * ceremony's own completion path can produce in production (the guard requires the signature row, which is inserted
 * first). `corrupt` flips a byte of the signature BEFORE the insert — the rows are append-only, so an invalid record
 * can only be seeded, never made by mutating one.
 */
async function seedDirect(node: string, signer: string, signerKey: SoftPasskey, opts: { end?: 'withdrawn' | 'completed'; corrupt?: boolean } = {}) {
  const n = await db.node.findUniqueOrThrow({ where: { id: node } });
  const approvalHash = computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });
  const requestId = newSigningRequestId(); // the payload builder refuses any other id shape
  const passkeyId = await insertSoftPasskey(db, signer, signerKey, { label: 'Seeded key', rpId: RP });
  await db.signingRequest.create({ data: {
    id: requestId, nodeId: node, revision: n.revSeq, approvalHash, payloadVersion: SIGNATURE_PAYLOAD_V3,
    requesterUserId: signerId, expiresAt: new Date(Date.now() + 3600_000), state: 'open',
  } });
  const assertion = signerKey.assert({
    payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: node, approvalHash, requestId }),
    origin: ORIGIN, rpId: RP,
  });
  const signature = opts.corrupt
    ? Buffer.from([...assertion.signature.slice(0, 10), assertion.signature[10]! ^ 0xff, ...assertion.signature.slice(11)])
    : assertion.signature;
  await db.nodeSignature.create({ data: {
    id: generateId(), nodeId: node, signingRequestId: requestId, signerId: signer, passkeyCredentialId: passkeyId,
    revision: n.revSeq, approvalHash, payloadVersion: SIGNATURE_PAYLOAD_V3, rpId: RP,
    authenticatorData: new Uint8Array(assertion.authenticatorData), clientDataJson: new Uint8Array(assertion.clientDataJson),
    signature: new Uint8Array(signature),
  } });
  if (opts.end) {
    await db.$executeRaw`UPDATE signing_requests SET state = ${opts.end} WHERE id = ${requestId}`;
  }
  return requestId;
}

const counts = (revision: number) => revisionSignatureCounts(db, nodeId, revision, REQ);

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED; // the predicate itself never reads the surface policy (G2 is the serve's term)
  signerId = (await db.user.create({ data: { githubId: 29731, githubUsername: 'r2973-signer', roles: [] } })).id;
  outsiderId = (await db.user.create({ data: { githubId: 29732, githubUsername: 'r2973-outsider', roles: [] } })).id;
  outsiderKey = softPasskey();
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'r2973-org', graphName: 'r2973' });
  memoryId = graph.id;
  nodeId = (await createDbNode(db, { loc: 'r2973:prompt', memoryId, name: 'Prompt', content: 'v1' })).id;
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
});

describe('#2973 coverage (cor:dmo:130:09 — from the revision history, never the live marker)', () => {
  it('counts at its own revision, and over a later revision that left title, abstract and content unchanged', async () => {
    await signLive(); // revision 1
    await editMetaOnly(); // revision 2: metadata-only
    expect(await counts(1)).toBe(true);
    expect(await counts(2)).toBe(true);
  });

  it('does not count after a change to the content, while the revisions it covered stay signed', async () => {
    await signLive(); // revision 1
    await editContent('v2'); // revision 2 changed the hashed fields
    expect(await counts(2)).toBe(false);
    expect(await counts(1)).toBe(true); // the revisions it covered stay signed
  });

  it('a restore does not revive coverage (A → B → A)', async () => {
    await signLive(); // revision 1 holds 'v1'
    await editContent('v2'); // revision 2
    await editContent('v1'); // revision 3 restores the signed text
    expect(await counts(3)).toBe(false);
  });

  it('judges change per revision, not from the live content_changed_at marker', async () => {
    await signLive(); // revision 1
    await editMetaOnly(); // revision 2 (covered)
    await editContent('v3'); // revision 3 stamps content_changed_at ≥ verifiedAt on the live row
    // Revision 2 is still covered by the revision-1 signature even though the LIVE marker has moved past it.
    expect(await counts(2)).toBe(true);
  });

  it('fails closed when a revision in the span has no snapshot left, while the span-free revisions stay signed', async () => {
    await signLive(); // revision 1
    await editMetaOnly(); // revision 2
    await editContent('v3'); // revision 3
    // Deliberate history deletion (allowed; not governed by the pruning exemptions) removes the span's evidence.
    await db.nodeRevision.deleteMany({ where: { nodeId, revNo: 2 } });
    // Revision 2's own fields are the deleted snapshot: there is no longer any witness that it left the signed text
    // unchanged, so trusting its absence would let deleting the A→B step of an A→B→A history revive coverage.
    expect(await counts(3)).toBe(false);
    expect(await counts(2)).toBe(false);
    expect(await counts(1)).toBe(true); // its own revision needs no span evidence at all
  });
});

describe('#2973 state (C2, cor:dmo:130:04 — re-verified, on the DB signing clock)', () => {
  it('a pending signature does not count while its first-key window is open, and counts once the window ended normally', async () => {
    const { passkeyId } = await signLive(nodeId, { closingMs: 2500 });
    expect(await counts(1)).toBe(false); // PENDING: the window is open on the platform clock
    // The window ends normally (ran out): the guard accepts the stamp only once the platform clock has really
    // passed window_ends_at, and only on the passkey clock (hadron_passkey_wall_now).
    await pastWindowEnd(passkeyId);
    await db.$executeRaw`UPDATE passkey_credentials
       SET window_ended_at = public.hadron_passkey_wall_now(), window_outcome = 'ran-out' WHERE id = ${passkeyId}`;
    expect(await counts(1)).toBe(true);
  }, 20_000);

  it('a cancelled signature never counts', async () => {
    const { passkeyId } = await signLive(nodeId, { closingMs: 20_000 });
    // Cancelled inside the window: revoked and closed together, before window_ends_at (chk_passkey_shape).
    await db.$executeRaw`UPDATE passkey_credentials
       SET revoked_at = public.hadron_passkey_wall_now(), window_ended_at = public.hadron_passkey_wall_now(), window_outcome = 'cancelled'
       WHERE id = ${passkeyId}`;
    expect(await counts(1)).toBe(false);
  });

  it('an invalid record never counts (reported as an integrity problem, never a signature)', async () => {
    // Seeded with corrupted signature bytes by an eligible signer over a completed request: the validity leg alone
    // fails. (The rows are append-only, so seeding is the only way an invalid one exists.)
    await seedDirect(nodeId, signerId, softPasskey(), { end: 'completed', corrupt: true });
    expect(await counts(1)).toBe(false);
  });

  it('a signature on a node in an encrypted memory does not count (not applicable)', async () => {
    await signLive();
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    expect(await counts(1)).toBe(false);
  });

  it('a passkey revoked after signing, outside the first-key window, still counts', async () => {
    const { passkeyId } = await signLive(); // not a first credential: no window at all
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_wall_now() WHERE id = ${passkeyId}`;
    expect(await counts(1)).toBe(true);
  });
});

describe('#2973 signer eligibility (C1 / Q-E, cor:dmo:130:09 r8 — judged at signing, never re-checked)', () => {
  it('a signer who was eligible when the signature was made still counts after they lose eligibility', async () => {
    await signLive();
    // The signer stops being eligible entirely (soft-deleted; they could not write the memory now).
    await db.user.update({ where: { id: signerId }, data: { deletedAt: new Date() } });
    expect(await counts(1)).toBe(true);
  });

  it('a signature seeded directly by someone the ceremony would have refused does not count', async () => {
    // The outsider could never write this memory: `requireSigner` would refuse them, so their request can never read
    // 'completed'. The seeded pair carries a REAL assertion over the right payload — only the ceremony's durable
    // verdict (the completed request, pinned to this node at this hash) is missing.
    await seedDirect(nodeId, outsiderId, outsiderKey); // request left open: never the ceremony's verdict
    expect(await counts(1)).toBe(false);
  });

  it('a request that ended without completing (withdrawn) is not the ceremony\'s verdict either', async () => {
    await seedDirect(nodeId, outsiderId, outsiderKey, { end: 'withdrawn' });
    expect(await counts(1)).toBe(false);
  });

  it('trusts the completed request as the at-signing verdict: it never re-checks eligibility now (the trust boundary)', async () => {
    // A request the DB guard accepts as 'completed' over an outsider's signature is unreachable in production — only
    // the ceremony completes requests, and it checks the signer may write. The predicate deliberately does NOT
    // re-derive eligibility (Q-E: re-checking now would strip signatures from every signer who has since left), so
    // this row counts: the durable record IS the verdict. This pin documents that boundary, not a bug.
    await seedDirect(nodeId, outsiderId, outsiderKey, { end: 'completed' });
    expect(await counts(1)).toBe(true);
  });
});
