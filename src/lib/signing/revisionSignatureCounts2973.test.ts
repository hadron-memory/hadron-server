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
 * (`hadron_signing_now()`, the clock `loadSignatureStatuses` already judges windows by; #3746's `hadron_passkey_now()`
 * is the REGISTRATION and lifecycle-stamp clock, so the window fixtures below write their stamps through it — the
 * guard refuses anything else).
 *
 * Eligibility (C1, Q-E) is judged at signing ONLY, and its durable record is the ceremony STAMP
 * (`ceremony_stamp`, HMAC under a retained registry key — gate holds 6749839869 / 6750325233, Anne's LOCAL P2, Rico
 * §10): a completed request pins node/revision/hash but no signer-bound authority fact, and a seed copies any static
 * column, so the seeded pair (no stamp — the pre-watermark shape) never counts, and a tampered or wrongly-keyed stamp
 * never counts. The stamp carries a DUAL grade (Xylon #92967): every ceremony signature records the writer grade, and
 * the manager grade — WHICH Agent/App the completion judged the signer to manage — only when they did; admission is
 * never narrowed, a writer-grade signature simply does not count for `compiled-boot-prompt`.
 *
 * The memory fence (Xylon 6750288978, exact counting parity over Vera 6750258496's stricter form): the stamp's memory
 * at signing must be the node's CURRENT memory, and the manager grade must name the current memory's Agent or App. A
 * cross-memory move ends counting (Rico §10 P2-1) and a move back restores it — a metadata-only revision captured in
 * the other memory never blocks the restore (no extra NOT_SIGNED refusal beyond the law), while the visible CURRENT
 * state (`loadSignatureStatuses`) is unaffected by a move.
 *
 * Every seed respects the DB guards (`prisma/signing-invariants.sql`, `prisma/passkey-invariants.sql`): requests are
 * inserted OPEN and end once through guarded UPDATEs, signature records are only ever INSERTed (an invalid record is
 * seeded by inserting corrupted signature bytes, not by mutating a row — the rows are append-only), and first-key
 * windows are registered through the #3746 clock seam so their end can arrive in test time.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { generateId } from '../id.js';
import { computeApprovalHash } from '../approvalHash.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from './payload.js';
import { clearSignatureVerifyCache } from './verify.js';
import { loadSignatureStatuses } from './status.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction, newSigningRequestId } from './requests.js';
import { revisionSignatureCounts, type SignatureRequirement } from './revisionSignatureCounts.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const REQ: SignatureRequirement = 'compiled-boot-prompt';
const WINDOW_MS = 72 * 3600 * 1000;

let signerId: string; // the org ADMIN: manages both fixture agents, so live signatures carry the manager grade
let writerId: string; // an org CONTRIBUTOR: a lawful writer of the memory who manages nothing
let outsiderId: string; // no relation to the org at all
let m1: string; // Agent A's system memory — where the node is born and signed
let m2: string; // Agent B's system memory — the cross-memory move's destination
let agentAId: string;
let agentBId: string;
let orgId: string;
let nodeId: string;
let key: SoftPasskey;
let outsiderKey: SoftPasskey;

const asUser = (userId: string) => ({ userId, appId: null, workerId: null, sessionId: null });
const writer = async () => true;

/** Edit the node's content (a real title/abstract/content change → a new revision that breaks coverage). The history
 * row is captured in the node's CURRENT memory (the real writer's shape: a snapshot records where it was taken). */
async function editContent(content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({
    data: { nodeId, memoryId: n.memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [] } as never,
  });
  await db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } });
}
/** A metadata-only edit: a new revision that leaves title, abstract and content unchanged. */
async function editMetaOnly() {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({
    data: { nodeId, memoryId: n.memoryId, loc: n.loc, name: n.name, abstract: n.abstract, content: n.content, revNo: n.revSeq, tags: [] } as never,
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
 * Sign the node's CURRENT revision through the real ceremony. The signer is the org ADMIN by default (the completion
 * judges them to manage the memory's agent → the manager grade); pass `as` to sign as the CONTRIBUTOR instead (a
 * lawful writer the ceremony admits — the writer grade, which does not count for `compiled-boot-prompt`). With
 * `closing`, signs with a first passkey whose window ends `msToEnd` from now, so the signature starts PENDING.
 */
async function signLive(node: string = nodeId, opts: { closingMs?: number; as?: 'admin' | 'contributor' } = {}) {
  const who = opts.as === 'contributor' ? writerId : signerId;
  key = softPasskey();
  const passkeyId = opts.closingMs != null
    ? await insertClosingFirstPasskey(who, key, opts.closingMs)
    : await insertSoftPasskey(db, who, key, { label: 'Signer key', rpId: RP });
  const memoryId = (await db.node.findUniqueOrThrow({ where: { id: node }, select: { memoryId: true } })).memoryId;
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, node, {
    memoryId, requester: asUser(who), mayWrite: writer,
  }));
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId, signerId: who, credentialId: key.credentialId,
    assertion: key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: node, approvalHash: req.approvalHash, requestId: req.id }),
      origin: ORIGIN, rpId: RP,
    }),
    mayWrite: writer,
  }));
  return { req, passkeyId };
}

/**
 * Seed a signature pair DIRECTLY, bypassing the ceremony (the only way a row the ceremony never wrote can exist: the
 * ceremony's own completion writes the stamp atomically with every signature it records — the watermark). The request
 * is inserted OPEN (a request begins open) and may then end once, guarded: 'withdrawn' is a person's end; 'completed'
 * is the DB shape only the ceremony's own completion path can produce in production (the guard requires the signature
 * row, which is inserted first). `corrupt` flips a byte of the signature BEFORE the insert — the rows are append-only,
 * so an invalid record can only be seeded, never made by mutating one. The seeded rows carry NO stamp: the
 * pre-watermark (legacy NULL) shape, which never counts.
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

const counts = (revision: number, memoryNode: string = nodeId) => revisionSignatureCounts(db, memoryNode, revision, REQ);

/**
 * Seed a FORGERY of a ceremony-made signature: a fresh request (open), a FRESH assertion by the signer's own passkey
 * over that request's pinned payload (so the validity and state legs pass honestly — the pin isolates the stamp leg),
 * and stamp columns copied from the original ceremony row — verbatim, or overridden with the attacker's claimed
 * facts. The one thing the forger can never supply is a tag minted by the ceremony over the CLAIMED facts; the tag
 * copied along is the original's, binding the ORIGINAL facts. The guard is honored the same way {@link seedDirect}
 * honors it: the row is INSERTed while its request is open, then the request ends 'completed' once.
 *
 * `assertingCredentialId` is not a claim but honesty plumbing: which of the signer's GENUINE credentials the fresh
 * assertion is made with and the row names. Without it the row names the first credential by id — an arbitrary pick
 * once the signer holds several (ids are random), which would fail the validity leg for a reason that is not the pin.
 */
async function seedStampForgery(node: string, orig: { ceremonyStamp: Uint8Array | null; stampKeyId: number | null; stampMemoryId: string | null; stampOwnerKind: string | null; stampOwnerId: string | null },
  passkey: SoftPasskey,
  claimed: { stampMemoryId?: string; stampOwnerKind?: string; stampOwnerId?: string; stampKeyId?: number; assertingCredentialId?: string } = {}) {
  const n = await db.node.findUniqueOrThrow({ where: { id: node } });
  const approvalHash = computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });
  const requestId = newSigningRequestId();
  await db.signingRequest.create({ data: {
    id: requestId, nodeId: node, revision: n.revSeq, approvalHash, payloadVersion: SIGNATURE_PAYLOAD_V3,
    requesterUserId: signerId, expiresAt: new Date(Date.now() + 3600_000), state: 'open',
  } });
  const credential = claimed.assertingCredentialId != null
    ? await db.passkeyCredential.findUniqueOrThrow({ where: { id: claimed.assertingCredentialId } })
    : await db.passkeyCredential.findFirstOrThrow({ where: { owner: { id: signerId } }, orderBy: { id: 'asc' } });
  const assertion = passkey.assert({
    payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: node, approvalHash, requestId }),
    origin: ORIGIN, rpId: RP,
  });
  await db.nodeSignature.create({ data: {
    id: generateId(), nodeId: node, signingRequestId: requestId, signerId: signerId, passkeyCredentialId: credential.id,
    revision: n.revSeq, approvalHash, payloadVersion: SIGNATURE_PAYLOAD_V3, rpId: RP,
    authenticatorData: new Uint8Array(assertion.authenticatorData), clientDataJson: new Uint8Array(assertion.clientDataJson),
    signature: new Uint8Array(assertion.signature),
    ceremonyStamp: orig.ceremonyStamp != null ? new Uint8Array(orig.ceremonyStamp) : null,
    stampKeyId: claimed.stampKeyId ?? orig.stampKeyId,
    stampMemoryId: claimed.stampMemoryId ?? orig.stampMemoryId,
    stampOwnerKind: claimed.stampOwnerKind ?? orig.stampOwnerKind,
    stampOwnerId: claimed.stampOwnerId ?? orig.stampOwnerId,
  } });
  await db.$executeRaw`UPDATE signing_requests SET state = 'completed' WHERE id = ${requestId}`;
  return requestId;
}

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED; // the predicate itself never reads the surface policy (G2 is the serve's term)
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'r2973-org', urn: 'r2973-org' } })).id;
  signerId = (await db.user.create({ data: { githubId: 29731, githubUsername: 'r2973-signer', roles: [] } })).id;
  writerId = (await db.user.create({ data: { githubId: 29733, githubUsername: 'r2973-writer', roles: [] } })).id;
  outsiderId = (await db.user.create({ data: { githubId: 29732, githubUsername: 'r2973-outsider', roles: [] } })).id;
  outsiderKey = softPasskey();
  await db.orgMember.create({ data: { organizationId: orgId, userId: signerId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: writerId, role: 'CONTRIBUTOR' } });
  // Two agents of the one org, each with its own system memory: the fence's M1 and M2 (the signer manages both).
  m1 = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sysA', urn: 'r2973-org:sysa', organizationId: orgId } })).id;
  m2 = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sysB', urn: 'r2973-org:sysb', organizationId: orgId } })).id;
  agentAId = (await db.agent.create({ data: { id: generateId(), name: 'Alpha', urn: 'r2973-org:alpha', organizationId: orgId, systemMemoryId: m1 } })).id;
  agentBId = (await db.agent.create({ data: { id: generateId(), name: 'Beta', urn: 'r2973-org:beta', organizationId: orgId, systemMemoryId: m2 } })).id;
  nodeId = (await createDbNode(db, { loc: 'r2973:prompt', memoryId: m1, name: 'Prompt', content: 'v1' })).id;
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

  it('a signature made at a LATER revision never covers an earlier one, even one holding the same text (M07)', async () => {
    // The restore case mirrored: signing the restored text at revision 3 does not reach back to revision 1 — coverage
    // runs from the signature's own revision forward only (a walk without the revision ≤ N filter would count it).
    await editContent('v2'); // revision 2
    await editContent('v1'); // revision 3 restores revision 1's text
    await signLive(); // signs revision 3, whose text equals revision 1's
    expect(await counts(3)).toBe(true);
    expect(await counts(1)).toBe(false);
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

  it('a snapshot number has ONE witness — duplicates cannot exist, so the pinned witness is unique by construction (M20)', async () => {
    await signLive(); // revision 1 holds 'v1'
    await editContent('v2'); // revision 2; snapshot@1 = 'v1'
    await editContent('v1'); // revision 3; snapshot@2 = 'v2' → the span witness at 2 breaks coverage
    expect(await counts(3)).toBe(false);
    // The duplicate the walk's newest-by-id resolution would have to arbitrate is refused by the database itself
    // (unique (node_id, rev_no)): there is never a second, disagreeing witness at one number to mis-order.
    const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    await expect(db.nodeRevision.create({
      data: { nodeId, memoryId: m1, loc: n.loc, name: n.name, content: 'v1', revNo: 2, tags: [] } as never,
    })).rejects.toThrow(/Unique constraint/);
    expect(await counts(3)).toBe(false);
  });

  it('should the constraint ever be bypassed, the walk arbitrates duplicate witnesses NEWEST-by-id, fail closed (Rico §10 P3-2 / M20)', async () => {
    await signLive(); // revision 1 holds 'v1'
    await editMetaOnly(); // revision 2; snapshot@1 = 'v1', none at 2 — the live row witnesses 2 for now
    expect(await counts(2)).toBe(true);
    const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    // Two witnesses at revNo 2, planted the only way they can exist (the unique constraint dropped for the
    // planting, this clone's schema to bend, then restored): an HONEST one over the signed text, then — 3ms
    // apart, so the UUIDv7 id order is strict — a DISAGREEING newer one. The walk's newest-by-id resolution
    // (the convention every revision read uses) must take the NEWER: a later planted witness fails closed, and
    // ordering oldest-first would silently count on the stale one (the surviving M20 mutant).
    await db.$executeRawUnsafe(`DROP INDEX node_revisions_node_rev_no_uniq`);
    const plant = (content: string) => db.nodeRevision.create({
      data: { nodeId, memoryId: m1, loc: n.loc, name: n.name, abstract: n.abstract, content, revNo: 2, tags: [] } as never,
    });
    try {
      await plant(n.content!); // honest: identical fields → hashes to the signed approval hash
      expect(await counts(2)).toBe(true); // the honest duplicate carries coverage, exactly as the live row did
      await new Promise((r) => setTimeout(r, 3));
      await plant('planted later duplicate'); // newer id, disagreeing content
      expect(await counts(2)).toBe(false); // newest-by-id wins → the span witness no longer hashes to the signed text
    } finally {
      await db.nodeRevision.deleteMany({ where: { nodeId, revNo: 2 } });
      await db.$executeRawUnsafe(`CREATE UNIQUE INDEX node_revisions_node_rev_no_uniq ON node_revisions (node_id, rev_no)`);
    }
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
    await db.memory.update({ where: { id: m1 }, data: { isEncrypted: true } });
    expect(await counts(1)).toBe(false);
  });

  it('a passkey revoked after signing, outside the first-key window, still counts', async () => {
    const { passkeyId } = await signLive(); // not a first credential: no window at all
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_wall_now() WHERE id = ${passkeyId}`;
    expect(await counts(1)).toBe(true);
  });
});

describe('#2973 signer eligibility (C1 / Q-E, cor:dmo:130:09 — judged at signing, never re-checked)', () => {
  it('a signer who was eligible when the signature was made still counts after they lose eligibility', async () => {
    await signLive();
    // The signer stops being eligible entirely (removed from the org; they could not write the memory now). Q-E: the
    // stamp is the at-signing fact, and it still verifies — present-day authority is never re-derived.
    await db.orgMember.deleteMany({ where: { organizationId: orgId, userId: signerId } });
    expect(await counts(1)).toBe(true);
  });

  it('a signature seeded directly by someone the ceremony would have refused does not count', async () => {
    // The outsider could never write this memory: `requireSigner` would refuse them. The seeded pair carries a REAL
    // assertion over the right payload — but no stamp, and no stamp means no at-signing authority fact at all.
    await seedDirect(nodeId, outsiderId, outsiderKey); // request left open: never the ceremony's verdict
    expect(await counts(1)).toBe(false);
  });

  it('a request that ended without completing (withdrawn) is not the ceremony\'s verdict either', async () => {
    await seedDirect(nodeId, outsiderId, outsiderKey, { end: 'withdrawn' });
    expect(await counts(1)).toBe(false);
  });

  it('a completed request alone is not the verdict: a seeded row without the ceremony\'s stamp never counts (the watermark, fail closed)', async () => {
    // Anne's C1, pinned red at d4b8c28a: the DB shape only the ceremony's completion can produce (a 'completed'
    // request over a real assertion, pinned to this node at this revision and hash) is NECESSARY but not SUFFICIENT —
    // a row-seeding attacker copies any static column, so the signer-bound verdict is the stamp, and this row has
    // none. The pre-watermark (legacy NULL) rows fail closed exactly the same way.
    await seedDirect(nodeId, outsiderId, outsiderKey, { end: 'completed' });
    expect(await counts(1)).toBe(false);
  });

  it('the writer grade alone does not count for compiled-boot-prompt: a lawful signature by a non-manager writer', async () => {
    // Admission is never narrowed (cor:dmo:130:02; Xylon #92967): the ceremony completes the CONTRIBUTOR's signature —
    // a real, lawful row. Its stamp carries the writer grade only, so it does not satisfy the boot prompt requirement.
    const { req } = await signLive(nodeId, { as: 'contributor' });
    expect((await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } })).state).toBe('completed');
    const row = await db.nodeSignature.findFirstOrThrow({ where: { signingRequestId: req.id } });
    expect(row.ceremonyStamp).not.toBeNull(); // stamped — writer grade
    expect(row.stampOwnerKind).toBeNull();
    expect(await counts(1)).toBe(false);
    // The same memory signed by the ADMIN (manager grade) counts: the grades differ, the admission does not.
    await signLive();
    expect(await counts(1)).toBe(true);
  });
});

describe('#2973 the stamp (the durable at-signing verdict — Rico §10 conditions)', () => {
  it('a registry row planted from another tokenCrypto use is unusable: the stamp never verifies under it', async () => {
    await signLive();
    expect(await counts(1)).toBe(true);
    // A chosen-plaintext ciphertext (a BYOK key, MCP headers — anything minted through the AAD-less encryptToken) is
    // copied into the registry row the stamp names: the GCM tag fails under the stamp-key AAD, the key is unusable,
    // and the signature stops counting (fail closed; Rico #92969 §1).
    const [{ id }] = await db.stampSigningKey.findMany({ orderBy: { id: 'asc' } });
    const { encryptToken } = await import('../tokenCrypto.js');
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptToken('attacker-chosen-plaintext')} WHERE id = ${id}`;
    expect(await counts(1)).toBe(false);
  });

  it('a registry row wrapped for ANOTHER key id is unusable (the AAD binds purpose and id)', async () => {
    await signLive();
    const [{ id }] = await db.stampSigningKey.findMany({ orderBy: { id: 'asc' } });
    const { encryptBytesAad } = await import('../tokenCrypto.js');
    // Even genuinely 32 random bytes, wrapped as key 2's row and planted into key 1's row, fail key 1's AAD.
    const wrappedAsTwo = encryptBytesAad(Buffer.alloc(32, 9), `hadron:stamp-key:v1:${(id as number) + 1}`);
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${wrappedAsTwo} WHERE id = ${id}`;
    expect(await counts(1)).toBe(false);
  });

  it('a stamp naming a different key than the one that made it never verifies', async () => {
    await signLive(); // stamps under key 1
    const olderKey = key; // the gen-1 passkey, captured before the next signLive reassigns the module binding
    await db.$executeRaw`UPDATE stamp_signing_keys SET retired_at = public.hadron_signing_now() WHERE retired_at IS NULL`;
    await signLive(); // the next generation: key 2
    const keys = await db.stampSigningKey.findMany({ orderBy: { id: 'asc' } });
    expect(keys.length).toBe(2); // one row per generation: the retired key stays retained for verification
    // The copy's every column is honest, but the tag was minted under key 1 while the row names key 2 — exactly the
    // predicate's stamp leg: stampTagMatches(key2, {keyId: 2, …}, tagMadeUnderKey1) is false both ways round.
    const older = await db.nodeSignature.findFirstOrThrow({ where: { stampKeyId: keys[0]!.id }, include: { passkey: true } });
    const newer = await db.nodeSignature.findFirstOrThrow({ where: { stampKeyId: keys[1]!.id }, include: { passkey: true } });
    const { stampVerificationKey, stampTagMatches } = await import('./stampKeys.js');
    const k1 = await stampVerificationKey(db, keys[0]!.id);
    const k2 = await stampVerificationKey(db, keys[1]!.id);
    const tagInputOf = (sig: typeof older, keyId: number) => ({
      keyId, nodeId: sig.nodeId, signingRequestId: sig.signingRequestId, signerId: sig.signerId,
      credentialId: Buffer.from(sig.passkey?.credentialId ?? new Uint8Array(0)),
      revision: sig.revision, approvalHash: sig.approvalHash, memoryId: sig.stampMemoryId!,
      ownerKind: sig.stampOwnerKind as 'AGENT' | 'APP' | null, ownerId: sig.stampOwnerId,
    });
    const olderTag = Buffer.from(older.ceremonyStamp!);
    expect(stampTagMatches(k2!, tagInputOf(older, keys[1]!.id), olderTag)).toBe(false); // key 2 over key 1's tag
    expect(stampTagMatches(k1!, tagInputOf(older, keys[1]!.id), olderTag)).toBe(false); // key 1, mismatched keyId input
    expect(stampTagMatches(k2!, tagInputOf(newer, keys[1]!.id), Buffer.from(newer.ceremonyStamp!))).toBe(true); // control
    // And the row-level leg the name promises (Bob N6): a seeded row — honest request, honest fresh assertion by the
    // signer's own gen-1 credential — whose stamp column NAMES key 2 while carrying key 1's tag. The rows are
    // append-only, so a mis-keyed stamp can only ever exist as a seed like this; the predicate verifies under the key
    // the row NAMES, so the forgery fails closed through counts, not just under the unit helper above.
    const twinId = (await createDbNode(db, { loc: 'r2973:twin3', memoryId: m1, name: 'Prompt', content: 'v1' })).id;
    await seedStampForgery(twinId, older, olderKey, { stampKeyId: keys[1]!.id, assertingCredentialId: older.passkeyCredentialId });
    expect(await revisionSignatureCounts(db, twinId, 1, REQ)).toBe(false); // the mis-keyed stamp never counts
    // And both honest rows still count end to end.
    expect(await counts(1)).toBe(true);
  });

  it('a stamp transplanted to another node never counts: the tag binds the row it was made for', async () => {
    await signLive(); // revision 1, in M1
    // A second node with IDENTICAL content in the same memory: its approval hash equals the signed one. The forgery
    // is honest everywhere a seed can be — a fresh open request, a fresh VALID assertion by the signer's own passkey —
    // so the validity and state legs pass and the pin isolates the stamp leg: the transplanted tag was minted over
    // the ORIGINAL row's facts, not the twin's.
    const twinId = (await createDbNode(db, { loc: 'r2973:twin', memoryId: m1, name: 'Prompt', content: 'v1' })).id;
    const orig = await db.nodeSignature.findFirstOrThrow({ where: { nodeId } });
    await seedStampForgery(twinId, orig, key);
    expect(await revisionSignatureCounts(db, twinId, 1, REQ)).toBe(false); // the transplant never counts
    expect(await counts(1)).toBe(true); // the original still does — its tag binds it there
  });

  it('a tampered stamp column never counts: the tag binds the attested facts to the row', async () => {
    await signLive();
    const orig = await db.nodeSignature.findFirstOrThrow({ where: { nodeId } });
    expect(orig.stampOwnerId).toBe(agentAId); // the ceremony judged agent A (M1's agent)
    // The transplant pin above covers a wrong nodeId; here the tamper is a wrong judged OWNER — the same honest
    // forgery with only stampOwnerId claimed as agent B. The tag still binds the columns the ceremony attested
    // (agent A), so the predicate's stamp leg rejects the altered facts (a seed cannot mint a tag for them).
    const twinId = (await createDbNode(db, { loc: 'r2973:twin2', memoryId: m1, name: 'Prompt', content: 'v1' })).id;
    await seedStampForgery(twinId, orig, key, { stampOwnerId: agentBId });
    expect(await revisionSignatureCounts(db, twinId, 1, REQ)).toBe(false);
    expect(await counts(1)).toBe(true);
  });

  it('the half owner pair (kind NULL, id named) is a shape the database refuses: no NULL CHECK verdict passes (Anne D2)', async () => {
    // The truth-table hole, red at 77c9fda8: with stamp_owner_kind NULL and stamp_owner_id non-NULL, the CHECK's
    // owner disjunction evaluated SQL NULL, and a CHECK accepts NULL — so the manager-pair shape inserted. The
    // predicate would never count it (the fence compares kind), but the row shape is a lie the table now rejects:
    // the whole CHECK expression is required to BE true (IS TRUE), closing every NULL-verdict shape at once.
    const { passkeyId } = await signLive(nodeId, { as: 'contributor' }); // writer grade: stamp trio set, kind/id both NULL
    const orig = await db.nodeSignature.findFirstOrThrow({ where: { nodeId } });
    expect(orig.stampOwnerKind).toBeNull();
    expect(orig.stampOwnerId).toBeNull();
    const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const approvalHash = computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });
    const requestId = newSigningRequestId();
    await db.signingRequest.create({ data: {
      id: requestId, nodeId, revision: n.revSeq, approvalHash, payloadVersion: SIGNATURE_PAYLOAD_V3,
      requesterUserId: signerId, expiresAt: new Date(Date.now() + 3600_000), state: 'open',
    } });
    const assertion = key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId, approvalHash, requestId }),
      origin: ORIGIN, rpId: RP,
    });
    // The insert satisfies the append-only guard honestly (an open request, the pinned payload, the writer's own
    // passkey) and is refused by the CHECK alone: kind NULL, id named — the half owner pair.
    await expect(db.$executeRaw`INSERT INTO node_signatures
      (id, node_id, signing_request_id, signer_id, passkey_credential_id, revision, approval_hash, payload_version, rp_id,
       authenticator_data, client_data_json, signature, ceremony_stamp, stamp_key_id, stamp_memory_id, stamp_owner_kind, stamp_owner_id)
      VALUES (${generateId()}, ${nodeId}, ${requestId}, ${writerId}, ${passkeyId}, ${n.revSeq}, ${approvalHash}, ${SIGNATURE_PAYLOAD_V3}, ${RP},
       ${Buffer.from(assertion.authenticatorData)}, ${Buffer.from(assertion.clientDataJson)}, ${Buffer.from(assertion.signature)},
       ${Buffer.from(orig.ceremonyStamp!)}, ${orig.stampKeyId}, ${orig.stampMemoryId}, NULL, 'someone')`)
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
  });

  it('rotating the encryption root re-wraps the registry and stamps keep counting; the rollback does too', async () => {
    await signLive();
    expect(await counts(1)).toBe(true);
    const { rewrapStampSigningKeys } = await import('./stampKeys.js');
    const before = (await db.stampSigningKey.findMany({ orderBy: { id: 'asc' } }))[0]!.keyMaterial;
    const rootA = process.env.HADRON_ENCRYPTION_KEY!;
    const rootB = 'b'.repeat(64);
    await rewrapStampSigningKeys(db, rootA, rootB);
    const after = (await db.stampSigningKey.findMany({ orderBy: { id: 'asc' } }))[0]!.keyMaterial;
    expect(after).not.toBe(before); // re-wrapped under the new root, not left behind
    process.env.HADRON_ENCRYPTION_KEY = rootB;
    try {
      expect(await counts(1)).toBe(true); // verification keys are retained: rotation never stops a signature counting
      await rewrapStampSigningKeys(db, rootB, rootA); // the rollback is the inverse call
    } finally {
      process.env.HADRON_ENCRYPTION_KEY = rootA;
    }
    expect(await counts(1)).toBe(true);
  });
});

describe('#2973 the memory fence (Xylon 6750288978 — exact counting parity)', () => {
  it('a signature made in M1 does not count after a cross-memory move to M2 (Rico §10 P2-1)', async () => {
    await signLive(); // in M1, judged against agent A's managers
    await db.node.update({ where: { id: nodeId }, data: { memoryId: m2 } });
    // M2 is agent B's system memory: the requirement now asks about B's managers, and nobody judged the signer
    // against them. The serve in M2 refuses NOT_SIGNED — it never serves on M1's authority.
    expect(await counts(1)).toBe(false);
  });

  it('M1 → M2 → metadata-only revision → back to M1 counts again (a witness captured in M2 is not a content change)', async () => {
    await signLive(); // revision 1, in M1
    expect(await counts(1)).toBe(true);
    await db.node.update({ where: { id: nodeId }, data: { memoryId: m2 } });
    expect(await counts(1)).toBe(false); // does not count in M2
    await editMetaOnly(); // revision 2, made in M2 — its history row is captured THERE
    await db.node.update({ where: { id: nodeId }, data: { memoryId: m1 } });
    // Back in M1 the requirement matches the stamp again (memory and judged agent), and the M2-captured witness is
    // complete unchanged-HASH evidence, not a content change: exact parity with the law, no extra NOT_SIGNED refusal.
    expect(await counts(2)).toBe(true);
    expect(await counts(1)).toBe(true);
  });

  it('a real content change in M2 still ends coverage forever, even after the move back and a restore', async () => {
    await signLive(); // revision 1, in M1
    await db.node.update({ where: { id: nodeId }, data: { memoryId: m2 } });
    await editContent('v2'); // revision 2, in M2 — a real change
    await editContent('v1'); // revision 3 restores the signed text
    await db.node.update({ where: { id: nodeId }, data: { memoryId: m1 } });
    expect(await counts(3)).toBe(false); // a restore never revives coverage (cor:dmo:130:04)
    expect(await counts(1)).toBe(true); // the revision it covered at signing stays signed
  });

  it('a cross-memory move never touches the visible signature state: CURRENT stays CURRENT (cor:dmo:130:04/:05)', async () => {
    await signLive();
    const before = (await loadSignatureStatuses(db, [nodeId])).get(nodeId)!;
    expect(before.state).toBe('CURRENT');
    await db.node.update({ where: { id: nodeId }, data: { memoryId: m2 } });
    const after = (await loadSignatureStatuses(db, [nodeId])).get(nodeId)!;
    expect(after.state).toBe('CURRENT'); // the fence changes counting, never the record's own state or visibility
    expect(after.signatures.length).toBe(1);
  });
});

describe('#2973 the same-owner move (two install memories of one App — Rico §10 P3-3)', () => {
  // Two install memories of ONE App share the stamp's judged owner (APP, X), so a move between them leaves the
  // memory fence (stampMemoryId vs the node's current memory) as the ONLY guard — the place a same-owner move
  // could slip through if the fence or the tag's memory binding were dropped. The four pins fold Rico's executed
  // probes (receipt 6753263603): the fence alone refuses the moved signature (kills mutant R1, fence `continue`
  // removed), the tag's own memory binding refuses the rewritten row (kills K1, memoryId dropped from the
  // canonical stamp input), and the in-place upgrade of a writer-grade stamp is the escalation the stamp exists
  // to stop. P3 by Rico's ruling: the managers of both installs are the same set, so PR1 gains no authority.
  async function twoInstalls() {
    const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'X', urn: 'r2973-org:appx' } });
    const i1 = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i1', urn: 'r2973-org:i1', organizationId: orgId, appId: app.id, installOfAgentId: agentAId, isInstallMemory: true } })).id;
    const i2 = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i2', urn: 'r2973-org:i2', organizationId: orgId, appId: app.id, installOfAgentId: agentBId, isInstallMemory: true } })).id;
    await db.node.update({ where: { id: nodeId }, data: { memoryId: i1 } });
    return { app, i1, i2 };
  }
  it('signed in I1 (manager of App X) counts in I1', async () => {
    const { app } = await twoInstalls();
    await signLive();
    const row = await db.nodeSignature.findFirstOrThrow({ where: { nodeId } });
    expect(row.stampOwnerKind).toBe('APP');
    expect(row.stampOwnerId).toBe(app.id);
    expect(await revisionSignatureCounts(db, nodeId, row.revision, REQ)).toBe(true);
  });
  it('moved I1 → I2 (same App owner) does not count — the fence alone refuses it', async () => {
    const { i2 } = await twoInstalls();
    await signLive();
    const row = await db.nodeSignature.findFirstOrThrow({ where: { nodeId } });
    await db.node.update({ where: { id: nodeId }, data: { memoryId: i2 } });
    expect(await revisionSignatureCounts(db, nodeId, row.revision, REQ)).toBe(false);
  });
  it('moved I1 → I2 and stamp_memory_id rewritten to I2 (triggers off) does not count — the tag binds the memory', async () => {
    const { i2 } = await twoInstalls();
    await signLive();
    const row = await db.nodeSignature.findFirstOrThrow({ where: { nodeId } });
    await db.node.update({ where: { id: nodeId }, data: { memoryId: i2 } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE node_signatures SET stamp_memory_id = ${i2} WHERE id = ${row.id}`;
    });
    expect((await db.nodeSignature.findUniqueOrThrow({ where: { id: row.id } })).stampMemoryId).toBe(i2);
    expect(await revisionSignatureCounts(db, nodeId, row.revision, REQ)).toBe(false);
  });
  it('a writer-only stamp upgraded in place to the current owner (triggers off) does not count', async () => {
    const { req } = await signLive(nodeId, { as: 'contributor' });
    const row = await db.nodeSignature.findFirstOrThrow({ where: { signingRequestId: req.id } });
    expect(row.stampOwnerKind).toBeNull();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE node_signatures SET stamp_owner_kind = 'AGENT', stamp_owner_id = ${agentAId} WHERE id = ${row.id}`;
    });
    expect(await revisionSignatureCounts(db, nodeId, row.revision, REQ)).toBe(false);
  });
});
