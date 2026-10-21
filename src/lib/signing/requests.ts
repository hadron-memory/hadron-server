/**
 * #1632 / cor:dmo:130:02–:03 — signing requests: create, withdraw, decline,
 * complete. The database guard (prisma/signing-invariants.sql) is the last
 * word on one end, pinned fields and DB-clock times; this module adds the
 * product checks a trigger cannot make (authorization is the caller's: who may
 * read the node, who may write its memory) and the typed refusals.
 *
 * Every transition runs inside the caller's transaction with the node row
 * locked first (the approval lock order), then the request row.
 */
import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/index.js';
import { COMMENT_NODE_TYPE } from '../comments/index.js';
import { computeApprovalHash } from '../approvalHash.js';
import { approvalFieldsOf } from '../nodeApproval.js';
import { ensureCurrentNodeRevisionInTransaction } from '../nodeRevisionSnapshot.js';
import { CURRENT_SIGNATURE_PAYLOAD_VERSION, signaturePayloadBytes } from './payload.js';
import { passkeyRpId, signingCeremonyOrigins, signingRequestTtlSeconds, SigningNotConfiguredError } from './config.js';
import { verifySigningAssertion, type AssertionParts } from './verify.js';

export type SigningRequestState = 'open' | 'completed' | 'declined' | 'expired' | 'stale' | 'withdrawn';

/** Why a signing call was refused. The resolver maps `code` to `extensions.code`. */
export class SigningRefusal extends Error {
  constructor(
    readonly code:
      | 'NODE_NOT_FOUND'
      | 'NODE_IS_PLACEHOLDER'
      | 'REVISION_MISMATCH'
      | 'COMMENT_NOT_SIGNABLE'
      | 'ENCRYPTED_MEMORY_NOT_APPLICABLE'
      | 'SIGNER_NOT_FOUND'
      | 'SIGNER_NOT_A_WRITER'
      | 'SIGNING_REQUEST_NOT_FOUND'
      | 'SIGNING_REQUEST_NOT_REQUESTER'
      | 'SIGNING_REQUEST_ENDED'
      | 'SIGNER_NOT_ELIGIBLE'
      | 'SIGNATURE_NOT_VERIFIED',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Who asked, as recorded on the request (cor:dmo:130:03: user or App, and session or worker). */
export interface SigningRequester {
  userId: string | null;
  /** Set only when the App itself is the principal (an App key), not a person's App selection. */
  appId: string | null;
  workerId: string | null;
  sessionId: string | null;
}

/** The requester ACCOUNT (#10397): the user when there is one, else the App. */
export function requesterAccount(r: { userId: string | null; appId: string | null }): string | null {
  if (r.userId) return `user:${r.userId}`;
  if (r.appId) return `app:${r.appId}`;
  return null;
}

/** 128 bits from the CSPRNG, base64url (plan SEC-8). */
export function newSigningRequestId(): string {
  return randomBytes(16).toString('base64url');
}

/** The state a request is in now: an open request past its deadline reads expired before anything stores it. */
export function effectiveRequestState(row: { state: string; expiresAt: Date }, now: Date): SigningRequestState {
  if (row.state === 'open' && now.getTime() >= row.expiresAt.getTime()) return 'expired';
  return row.state as SigningRequestState;
}

/** The DB clock, as the naive-UTC instant Prisma reads DateTime columns as. */
export async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
  return row.now;
}

async function lockedEncrypted(tx: Prisma.TransactionClient, memoryId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ is_encrypted: boolean }>>`
    SELECT is_encrypted FROM memories WHERE id = ${memoryId} FOR SHARE`;
  return row?.is_encrypted ?? false;
}

/**
 * Open a signing request on a node's current content (cor:dmo:130:03).
 * The caller has authorized the requester as a READER of `memoryId`.
 * `mayWrite` is the same signer policy completion and decline take
 * (`maySignInMemory`): a named signer who may not write the memory is refused
 * now, so no request is created that can never complete (#1904, Holger #11094).
 */
export async function createSigningRequestInTransaction(
  tx: Prisma.TransactionClient,
  nodeId: string,
  opts: {
    memoryId: string;
    requester: SigningRequester;
    namedSignerId?: string | null;
    expectedRevision?: number | null;
    mayWrite: (userId: string, memoryId: string) => Promise<boolean>;
  },
) {
  const revision = await ensureCurrentNodeRevisionInTransaction(tx, nodeId, { expectedMemoryId: opts.memoryId });
  if (revision == null) throw new SigningRefusal('NODE_NOT_FOUND', 'Node not found');
  const node = await tx.node.findFirst({
    where: { id: nodeId, memoryId: opts.memoryId, deletedAt: null },
    select: { id: true, name: true, abstract: true, content: true, revSeq: true, nodeType: true, isPlaceholder: true },
  });
  if (!node) throw new SigningRefusal('NODE_NOT_FOUND', 'Node not found');
  // #9837 / cor:dmo:120:00: never on an encrypted memory, and decided under a
  // lock on the memory row, so an encryptMemory cannot slip in between.
  if (await lockedEncrypted(tx, opts.memoryId)) {
    throw new SigningRefusal('ENCRYPTED_MEMORY_NOT_APPLICABLE', 'Signing is not applicable to encrypted memories.', { memoryId: opts.memoryId });
  }
  // #10031: a comment is never signed. Refused before the revision check, so
  // the answer does not depend on which revision was named.
  if (node.nodeType === COMMENT_NODE_TYPE) {
    throw new SigningRefusal('COMMENT_NOT_SIGNABLE', 'A comment is feedback; it is never signed.');
  }
  if (opts.expectedRevision != null && opts.expectedRevision !== node.revSeq) {
    throw new SigningRefusal('REVISION_MISMATCH',
      `Revision ${opts.expectedRevision} is no longer current; the node is at revision ${node.revSeq}.`,
      { expected: opts.expectedRevision, current: node.revSeq });
  }
  if (node.isPlaceholder) throw new SigningRefusal('NODE_IS_PLACEHOLDER', 'A reserved placeholder has nothing to sign yet.');
  if (opts.namedSignerId) {
    const signer = await tx.user.findFirst({ where: { id: opts.namedSignerId }, select: { id: true } });
    if (!signer) throw new SigningRefusal('SIGNER_NOT_FOUND', 'The named signer was not found.');
    // Checked again at completion and decline (requireSigner): write access can change in between.
    if (!(await opts.mayWrite(signer.id, opts.memoryId))) {
      throw new SigningRefusal('SIGNER_NOT_A_WRITER', 'The named signer cannot currently write this node\'s memory, so they cannot sign it.');
    }
  }
  const id = newSigningRequestId();
  const ttl = signingRequestTtlSeconds();
  await tx.$executeRaw`INSERT INTO signing_requests
    (id, node_id, revision, approval_hash, payload_version, named_signer_id,
     requester_user_id, requester_app_id, requester_worker_id, requester_session_id, expires_at)
    VALUES (${id}, ${node.id}, ${node.revSeq}, ${computeApprovalHash(approvalFieldsOf(node, null))},
      ${CURRENT_SIGNATURE_PAYLOAD_VERSION}, ${opts.namedSignerId ?? null},
      ${opts.requester.userId}, ${opts.requester.userId ? null : opts.requester.appId},
      ${opts.requester.workerId}, ${opts.requester.sessionId},
      hadron_signing_now() + make_interval(secs => ${ttl}))`;
  return tx.signingRequest.findUniqueOrThrow({ where: { id } });
}

/**
 * Lock the request's node, then the request, and store an expiry that has
 * already happened, so every transition below starts from the true state.
 * A request on a node outside `memoryId` (moved, or a mismatched caller) is
 * NOT_FOUND, the same as an unknown id.
 */
async function lockRequest(tx: Prisma.TransactionClient, requestId: string, memoryId: string) {
  const peek = await tx.signingRequest.findUnique({ where: { id: requestId }, select: { nodeId: true } });
  if (!peek) throw new SigningRefusal('SIGNING_REQUEST_NOT_FOUND', 'Signing request not found');
  const [node] = await tx.$queryRaw<Array<{ id: string; memory_id: string }>>`
    SELECT id, memory_id FROM nodes WHERE id = ${peek.nodeId} FOR UPDATE`;
  if (!node || node.memory_id !== memoryId) throw new SigningRefusal('SIGNING_REQUEST_NOT_FOUND', 'Signing request not found');
  await tx.$queryRaw`SELECT id FROM signing_requests WHERE id = ${requestId} FOR UPDATE`;
  await tx.$executeRaw`UPDATE signing_requests SET state = 'expired'
    WHERE id = ${requestId} AND state = 'open' AND expires_at <= hadron_signing_now()`;
  return tx.signingRequest.findUniqueOrThrow({ where: { id: requestId } });
}

function requireOpen(row: { state: string }) {
  if (row.state !== 'open') {
    throw new SigningRefusal('SIGNING_REQUEST_ENDED', `This signing request has ended (${row.state}).`, { state: row.state.toUpperCase() });
  }
}

/** End a request by DB-clock UPDATE; the guard refuses any second end. */
async function endRequest(tx: Prisma.TransactionClient, requestId: string, state: Exclude<SigningRequestState, 'open' | 'expired'>) {
  const n = await tx.$executeRaw`UPDATE signing_requests SET state = ${state} WHERE id = ${requestId} AND state = 'open'`;
  if (n !== 1) throw new SigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.');
  return tx.signingRequest.findUniqueOrThrow({ where: { id: requestId } });
}

/**
 * Withdraw (#10024, #10397): only the requester ACCOUNT, from any of its
 * sessions or workers. The caller has authorized `caller` as a reader of the
 * node's memory.
 */
export async function withdrawSigningRequestInTransaction(
  tx: Prisma.TransactionClient,
  requestId: string,
  opts: { memoryId: string; caller: { userId: string | null; appId: string | null } },
) {
  const row = await lockRequest(tx, requestId, opts.memoryId);
  const mine = requesterAccount(opts.caller);
  const theirs = requesterAccount({ userId: row.requesterUserId, appId: row.requesterAppId });
  if (!mine || mine !== theirs) {
    throw new SigningRefusal('SIGNING_REQUEST_NOT_REQUESTER', 'Only the account that requested this signature may withdraw it.');
  }
  requireOpen(row);
  return endRequest(tx, requestId, 'withdrawn');
}

/**
 * The checks shared by decline and complete: the request is open, the person
 * is the named signer (if one is named), and they may sign the node (a writer
 * of its memory, decided by the caller's `mayWrite` under the locks).
 */
async function requireSigner(
  tx: Prisma.TransactionClient,
  requestId: string,
  opts: { memoryId: string; signerId: string; mayWrite: (userId: string, memoryId: string) => Promise<boolean> },
) {
  const row = await lockRequest(tx, requestId, opts.memoryId);
  requireOpen(row);
  if (row.namedSignerId && row.namedSignerId !== opts.signerId) {
    throw new SigningRefusal('SIGNER_NOT_ELIGIBLE', 'Only the named signer may act on this request.');
  }
  if (!(await opts.mayWrite(opts.signerId, opts.memoryId))) {
    throw new SigningRefusal('SIGNER_NOT_ELIGIBLE', 'Only a writer of the node\'s memory may sign it.');
  }
  return row;
}

/** Decline (cor:dmo:130:03, #9928 item 3): the eligible signer turns the request down. Reached by S2b-2's page. */
export async function declineSigningRequestInTransaction(
  tx: Prisma.TransactionClient,
  requestId: string,
  opts: { memoryId: string; signerId: string; mayWrite: (userId: string, memoryId: string) => Promise<boolean> },
) {
  await requireSigner(tx, requestId, opts);
  return endRequest(tx, requestId, 'declined');
}

/**
 * Complete (cor:dmo:130:02/:03): verify the signer's assertion over the
 * request's pinned payload and record the signature, in one transaction.
 * Reached only by S2b-2's ceremony page; no GraphQL or MCP call takes an
 * assertion (130:02 S2). The node's live content must still hash to the pinned
 * hash (a change would already have staled it; this is the belt to that
 * brace), the credential must be the signer's own and unrevoked, and the
 * person proven by the passkey must be the signer.
 */
export async function completeSigningRequestInTransaction(
  tx: Prisma.TransactionClient,
  requestId: string,
  opts: {
    memoryId: string;
    signerId: string;
    credentialId: Buffer;
    assertion: AssertionParts;
    mayWrite: (userId: string, memoryId: string) => Promise<boolean>;
  },
) {
  const row = await requireSigner(tx, requestId, opts);
  if (await lockedEncrypted(tx, opts.memoryId)) {
    throw new SigningRefusal('ENCRYPTED_MEMORY_NOT_APPLICABLE', 'Signing is not applicable to encrypted memories.', { memoryId: opts.memoryId });
  }
  const node = await tx.node.findFirst({
    where: { id: row.nodeId, memoryId: opts.memoryId },
    select: { name: true, abstract: true, content: true },
  });
  if (!node || computeApprovalHash(approvalFieldsOf(node, null)) !== row.approvalHash) {
    throw new SigningRefusal('SIGNING_REQUEST_ENDED', 'The node changed since this signature was requested.', { state: 'STALE' });
  }
  const [credential] = await tx.$queryRaw<Array<{ id: string; owner_id: string; credential_id: Buffer; public_key: Buffer; counter: bigint; revoked_at: Date | null; enrollment_rp_id: string }>>`
    SELECT id, owner_id, credential_id, public_key, counter, revoked_at, enrollment_rp_id FROM passkey_credentials
     WHERE credential_id = ${opts.credentialId} FOR UPDATE`;
  const rpId = passkeyRpId();
  // SEC-6: the credential's owner is the person signing; never the userHandle. A credential
  // enrolled under another RP ID never counts here (#1631 PR1b, Eden #10470; cor:aut:040:06).
  if (!credential || credential.owner_id !== opts.signerId || credential.revoked_at !== null || credential.enrollment_rp_id !== rpId) {
    throw new SigningRefusal('SIGNATURE_NOT_VERIFIED', 'The signature did not verify.');
  }
  const payload = signaturePayloadBytes(row.payloadVersion, { nodeId: row.nodeId, approvalHash: row.approvalHash, requestId: row.id });
  let newCounter: number;
  try {
    ({ newCounter } = await verifySigningAssertion({
      assertion: opts.assertion,
      credential: { credentialId: credential.credential_id, publicKey: credential.public_key, counter: credential.counter },
      payload,
      rpId,
      origins: signingCeremonyOrigins(),
    }));
  } catch (e) {
    if (e instanceof SigningNotConfiguredError) throw e;
    throw new SigningRefusal('SIGNATURE_NOT_VERIFIED', 'The signature did not verify.');
  }
  await tx.nodeSignature.create({
    data: {
      nodeId: row.nodeId,
      signingRequestId: row.id,
      signerId: opts.signerId,
      passkeyCredentialId: credential.id,
      revision: row.revision,
      approvalHash: row.approvalHash,
      payloadVersion: row.payloadVersion,
      rpId,
      authenticatorData: new Uint8Array(opts.assertion.authenticatorData),
      clientDataJson: new Uint8Array(opts.assertion.clientDataJson),
      signature: new Uint8Array(opts.assertion.signature),
    },
  });
  await tx.$executeRaw`UPDATE passkey_credentials
     SET last_used_at = GREATEST(COALESCE(last_used_at, registered_at), (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)),
         counter = GREATEST(counter, ${BigInt(newCounter)})
   WHERE id = ${credential.id}`;
  return endRequest(tx, requestId, 'completed');
}
