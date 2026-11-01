/**
 * #1632 S2b-2 (hrn:node:hadronmemory.com:specs:cor:dmo:130:08, :02, :03; cor:aut:040:06) — the server-hosted signing
 * ceremony's logic, below the HTTP routes (`src/api/signingCeremonyRoutes.ts`).
 *
 * Two passkey assertions, two single-use DB ceremonies (never a JWT):
 *
 *  1. PROOF (`SIGN_PROOF`). `openProofCeremony` mints a ceremony for this browser whose challenge is bound to the
 *     request id AND the ceremony id, so a proof opened for one request proves nothing at another. The assertion
 *     over it (`proveForSigning`) names the viewer: the credential's OWNER, never the authenticator's userHandle.
 *     Only then does anything about the node leave the server, and only if the viewer may read it and, when the
 *     request names a signer, is that person. The proof ceremony is spent either way a success lands; a refusal
 *     rolls everything back, so nothing is half-spent.
 *  2. SIGN (`SIGN`). A proven, eligible viewer gets ONE signing ceremony, bound once to them (the ceremony binding
 *     CHECK) and to this request by its challenge: SHA-256 of the v3 payload bytes. A new proof in the same
 *     browser retires the earlier signing ceremony. `completeSigning` consumes it and completes the request in the
 *     SAME transaction, so every refusal rolls back the consume, the signature, the counter and the end state.
 *
 * Every refusal that could tell a stranger something is the one `CeremonyRefused`. Eligibility is rechecked at
 * completion and decline under the locks (writer of the memory, named signer, open, unencrypted, unchanged).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isMemoryReadableCached, requireMemoryWriteAccess } from '../../api/graphql/schema/resolvers.helpers.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { computeApprovalHash } from '../approvalHash.js';
import { approvalFieldsOf } from '../nodeApproval.js';
import { locateIncludeTags } from '../includes/parseIncludeTags.js';
import { consumeCeremony, decideCeremonyAssertion, verifyCeremonyAssertion } from '../passkeys/ceremony.js';
import type { AssertionParts } from './verify.js';
import { signatureChallenge, signaturePayloadBytes } from './payload.js';
import {
  completeSigningRequestInTransaction, declineSigningRequestInTransaction, effectiveRequestState, SigningRefusal,
} from './requests.js';
import { lineDiff, type DiffLine } from './lineDiff.js';

export const SIGN_PROOF_TTL_SECONDS = 300;
/** Long enough to read a long node before signing; the ceremony is single-use and bound, so a longer window adds no replay. */
export const SIGN_TTL_SECONDS = 600;

/** The one answer for anything a stranger must not be able to tell apart. */
export class CeremonyRefused extends Error {}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();
const sha256Hex = (b: Uint8Array | string) => sha256(b).toString('hex');

/** The proof challenge: bound to the request AND the ceremony id (no cross-request or cross-ceremony proof). */
export function proofChallenge(requestId: string, ceremonyId: string): Buffer {
  return sha256(`hadron-signing-proof\nrequest ${requestId}\nceremony ${ceremonyId}\n`);
}

/** Open a proof ceremony for the browser. Reads nothing about the request: the same answer for every id. */
export async function openProofCeremony(
  db: PrismaClient,
  input: { requestId: string; browserNonceHash: string },
): Promise<{ ceremonyId: string; challenge: string }> {
  const ceremonyId = randomBytes(32).toString('base64url');
  const challenge = proofChallenge(input.requestId, ceremonyId);
  await db.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at)
    VALUES (${ceremonyId}, 'SIGN_PROOF', ${input.browserNonceHash}, ${sha256Hex(challenge)},
            (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${SIGN_PROOF_TTL_SECONDS}))`;
  return { ceremonyId, challenge: challenge.toString('base64url') };
}

interface CredentialRow {
  id: string; owner_id: string; credential_id: Buffer; public_key: Buffer; counter: bigint;
  revoked_at: Date | null; enrollment_rp_id: string;
}

async function loadCredential(db: PrismaClient | Prisma.TransactionClient, credentialId: Buffer): Promise<CredentialRow | null> {
  const [row] = await db.$queryRaw<CredentialRow[]>`SELECT id, owner_id, credential_id, public_key, counter, revoked_at, enrollment_rp_id
    FROM passkey_credentials WHERE credential_id = ${credentialId}`;
  return row ?? null;
}

/** A context for the shared access gates, run on the transaction's own client (never a second pool connection). */
async function gateContext(tx: Prisma.TransactionClient, userId: string): Promise<Context | null> {
  const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, roles: true } });
  return user ? ({ db: tx, userId: user.id, roles: user.roles } as unknown as Context) : null;
}

/** Whether `userId` may write `memoryId` (the signer policy, `maySignInMemory`), asked on `tx`. */
const mayWriteIn = (tx: Prisma.TransactionClient) => async (userId: string, memoryId: string): Promise<boolean> => {
  try {
    await requireMemoryWriteAccess({ db: tx, userId, roles: [] } as unknown as Context, memoryId);
    return true;
  } catch {
    return false;
  }
};

export interface CeremonyView {
  node: { title: string; abstract: string | null; contentSegments: Array<{ text: string; include: boolean }> };
  revision: number;
  requester: { name: string; via: string | null };
  expiresAt: string;
  namedSigner: boolean;
  previous: null | { revision: number; kept: false } | { revision: number; kept: true; diff: { title: DiffLine[]; abstract: DiffLine[]; content: DiffLine[] } };
}

export type ProofResult =
  | { outcome: 'open'; view: CeremonyView; canSign: boolean }
  | { outcome: 'ended'; state: string };

/** The content as a list of segments, each include tag its own flagged segment: tags are shown, never expanded. */
function contentSegments(content: string | null): Array<{ text: string; include: boolean }> {
  if (!content) return [];
  let tags: Array<{ index: number; raw: string }> = [];
  try { tags = locateIncludeTags(content); } catch { tags = []; }
  const out: Array<{ text: string; include: boolean }> = [];
  let at = 0;
  for (const t of tags) {
    if (t.index > at) out.push({ text: content.slice(at, t.index), include: false });
    out.push({ text: t.raw, include: true });
    at = t.index + t.raw.length;
  }
  if (at < content.length) out.push({ text: content.slice(at), include: false });
  return out;
}

async function previousSigned(
  tx: Prisma.TransactionClient, nodeId: string, memoryId: string, requestId: string,
  now: { name: string; abstract: string | null; content: string | null },
): Promise<CeremonyView['previous']> {
  const last = await tx.nodeSignature.findFirst({
    where: { nodeId, NOT: { signingRequestId: requestId } },
    orderBy: [{ verifiedAt: 'desc' }, { id: 'desc' }], select: { revision: true },
  });
  if (!last) return null;
  const rev = await tx.nodeRevision.findFirst({
    where: { nodeId, revNo: last.revision, OR: [{ memoryId: null }, { memoryId }] },
    select: { name: true, abstract: true, content: true },
  });
  // The text was deliberately deleted (history cleared), or lived in a memory this reader may not see.
  if (!rev) return { revision: last.revision, kept: false };
  return {
    revision: last.revision, kept: true,
    diff: { title: lineDiff(rev.name, now.name), abstract: lineDiff(rev.abstract, now.abstract), content: lineDiff(rev.content, now.content) },
  };
}

async function requesterOf(tx: Prisma.TransactionClient, r: { requesterUserId: string | null; requesterAppId: string | null; requesterWorkerId: string | null }) {
  const [user, app, worker] = await Promise.all([
    r.requesterUserId ? tx.user.findUnique({ where: { id: r.requesterUserId }, select: { handle: true } }) : null,
    r.requesterAppId ? tx.app.findUnique({ where: { id: r.requesterAppId }, select: { name: true } }) : null,
    r.requesterWorkerId ? tx.worker.findUnique({ where: { id: r.requesterWorkerId }, select: { name: true } }) : null,
  ]);
  return { name: user?.handle ?? app?.name ?? 'someone', via: worker?.name ?? null };
}

/**
 * The proof step. Verifies the assertion over the request-bound proof challenge OUTSIDE any transaction, then in one
 * transaction: anchors the user, spends the proof ceremony, rechecks read access and the named-signer match, and
 * only then builds the projection and (when the viewer may sign) mints the one signing ceremony. Anything that fails
 * throws `CeremonyRefused` and rolls back, so a refusal spends nothing and moves no counter.
 */
export async function proveForSigning(db: PrismaClient, a: {
  requestId: string; ceremonyId: string; browserNonceHash: string;
  credentialId: Buffer; assertion: AssertionParts; rpId: string; origins: string[];
}): Promise<ProofResult> {
  const cred = await loadCredential(db, a.credentialId);
  if (!cred || cred.revoked_at !== null || cred.enrollment_rp_id !== a.rpId) throw new CeremonyRefused();
  let verified;
  try {
    verified = await verifyCeremonyAssertion({
      assertion: a.assertion,
      credential: { passkeyId: cred.id, ownerId: cred.owner_id, credentialId: cred.credential_id, publicKey: cred.public_key, counter: cred.counter },
      expectedChallenge: proofChallenge(a.requestId, a.ceremonyId), rpId: a.rpId, origins: a.origins,
    });
  } catch { throw new CeremonyRefused(); }

  try {
    return await db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: cred.owner_id }], 'exclusive');
      const ctx = await gateContext(tx, cred.owner_id);
      if (!ctx) throw new CeremonyRefused();
      const decided = await decideCeremonyAssertion(tx, { ceremonyId: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'SIGN_PROOF', verified: verified.snapshot });
      if (!decided || decided.ownerId !== cred.owner_id) throw new CeremonyRefused();

      const row = await tx.signingRequest.findUnique({ where: { id: a.requestId }, include: { node: { select: { memoryId: true, deletedAt: true } } } });
      if (!row || row.node.deletedAt) throw new CeremonyRefused();
      const memoryId = row.node.memoryId;
      // Read access, then the named-signer match: both before any content, both the same refusal as an unknown id.
      if (!(await isMemoryReadableCached(ctx, memoryId))) throw new CeremonyRefused();
      if (row.namedSignerId && row.namedSignerId !== cred.owner_id) throw new CeremonyRefused();

      const state = effectiveRequestState(row, new Date((await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`)[0].now));
      if (state !== 'open') return { outcome: 'ended' as const, state: state.toUpperCase() };

      const node = await tx.node.findFirst({ where: { id: row.nodeId, memoryId, deletedAt: null }, select: { name: true, abstract: true, content: true } });
      const encrypted = await tx.memory.findUnique({ where: { id: memoryId }, select: { isEncrypted: true } });
      if (!node || encrypted?.isEncrypted) return { outcome: 'ended' as const, state: 'STALE' };
      // The text shown is the text hashed. A change would already have staled the request; this is the belt to that brace.
      if (computeApprovalHash(approvalFieldsOf(node, null)) !== row.approvalHash) return { outcome: 'ended' as const, state: 'STALE' };

      const view: CeremonyView = {
        node: { title: node.name, abstract: node.abstract, contentSegments: contentSegments(node.content) },
        revision: row.revision,
        requester: await requesterOf(tx, row),
        expiresAt: row.expiresAt.toISOString(),
        namedSigner: row.namedSignerId !== null,
        previous: await previousSigned(tx, row.nodeId, memoryId, row.id, node),
      };
      const canSign = await mayWriteIn(tx)(cred.owner_id, memoryId);
      if (!canSign) return { outcome: 'open' as const, view, canSign: false };

      // ONE live signing ceremony per browser: a newer proof retires the earlier one. `/challenge` only reads it back.
      await tx.$executeRaw`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE purpose = 'SIGN' AND browser_nonce_hash = ${a.browserNonceHash} AND consumed_at IS NULL`;
      const challenge = signatureChallenge(signaturePayloadBytes(row.payloadVersion, { nodeId: row.nodeId, approvalHash: row.approvalHash, requestId: row.id }));
      await tx.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at, user_id, kind)
        VALUES (${randomBytes(32).toString('base64url')}, 'SIGN', ${a.browserNonceHash}, ${sha256Hex(challenge)},
                (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${SIGN_TTL_SECONDS}), ${cred.owner_id}, 'sign')`;
      return { outcome: 'open' as const, view, canSign: true };
    });
  } catch (e) {
    if (e instanceof CeremonyRefused) throw e;
    if (e instanceof SigningRefusal) throw new CeremonyRefused();
    throw e;
  }
}

/**
 * `/challenge`: the signing challenge of the ONE live signing ceremony this proof minted, read back and never
 * minted again. It answers only for the browser that holds it and only while the ceremony's challenge still names THIS
 * request; anything else is the one refusal. Nothing here proves or changes anything.
 */
export async function currentSigningChallenge(db: PrismaClient, a: { requestId: string; browserNonceHash: string; rpId: string }): Promise<{
  ceremonyId: string; challenge: string; rpId: string; allowCredentials: string[];
}> {
  const row = await db.signingRequest.findUnique({ where: { id: a.requestId } });
  if (!row) throw new CeremonyRefused();
  let challenge: Buffer;
  try { challenge = signatureChallenge(signaturePayloadBytes(row.payloadVersion, { nodeId: row.nodeId, approvalHash: row.approvalHash, requestId: row.id })); }
  catch { throw new CeremonyRefused(); }
  const [cer] = await db.$queryRaw<Array<{ id: string; user_id: string | null }>>`
    SELECT id, user_id FROM passkey_ceremonies
     WHERE purpose = 'SIGN' AND browser_nonce_hash = ${a.browserNonceHash} AND challenge_hash = ${sha256Hex(challenge)}
       AND consumed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
     ORDER BY created_at DESC LIMIT 1`;
  if (!cer?.user_id) throw new CeremonyRefused();
  const creds = await db.$queryRaw<Array<{ credential_id: Buffer }>>`SELECT credential_id FROM passkey_credentials
    WHERE owner_id = ${cer.user_id} AND revoked_at IS NULL AND enrollment_rp_id = ${a.rpId}`;
  return { ceremonyId: cer.id, challenge: challenge.toString('base64url'), rpId: a.rpId, allowCredentials: creds.map((c) => Buffer.from(c.credential_id).toString('base64url')) };
}

/** Lock and check a SIGN ceremony for this request and browser, spend it, and return who it was bound to. */
async function spendSigningCeremony(
  tx: Prisma.TransactionClient, a: { requestId: string; ceremonyId: string; browserNonceHash: string },
): Promise<{ signerId: string; memoryId: string }> {
  const row = await tx.signingRequest.findUnique({ where: { id: a.requestId }, include: { node: { select: { memoryId: true } } } });
  if (!row) throw new CeremonyRefused();
  const [cer] = await tx.$queryRaw<Array<{ user_id: string | null; challenge_hash: string | null }>>`
    SELECT user_id, challenge_hash FROM passkey_ceremonies
     WHERE id = ${a.ceremonyId} AND purpose = 'SIGN' FOR UPDATE`;
  if (!cer?.user_id) throw new CeremonyRefused();
  let expected: string;
  try {
    expected = sha256Hex(signatureChallenge(signaturePayloadBytes(row.payloadVersion, { nodeId: row.nodeId, approvalHash: row.approvalHash, requestId: row.id })));
  } catch { throw new CeremonyRefused(); }
  // Bound to THIS request by its challenge: a signing ceremony opened for another request never matches.
  if (cer.challenge_hash !== expected) throw new CeremonyRefused();
  if (!(await consumeCeremony(tx, { id: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'SIGN' }))) throw new CeremonyRefused();
  return { signerId: cer.user_id, memoryId: row.node.memoryId };
}

/**
 * Complete: the signing assertion, in the SAME transaction as the ceremony's consume (a refusal rolls back the
 * consume, the signature, the counter and the end state). A ceremony problem is `CeremonyRefused`; everything the
 * completion itself refuses stays a typed `SigningRefusal` for the route to map.
 */
export async function completeSigning(db: PrismaClient, a: {
  requestId: string; ceremonyId: string; browserNonceHash: string; credentialId: Buffer; assertion: AssertionParts;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const { signerId, memoryId } = await spendSigningCeremony(tx, a);
    await completeSigningRequestInTransaction(tx, a.requestId, {
      memoryId, signerId, credentialId: a.credentialId, assertion: a.assertion, mayWrite: mayWriteIn(tx),
    });
  });
}

/** Decline: the proven signer's own signing ceremony turns the request down. */
export async function declineSigning(db: PrismaClient, a: { requestId: string; ceremonyId: string; browserNonceHash: string }): Promise<void> {
  await db.$transaction(async (tx) => {
    const { signerId, memoryId } = await spendSigningCeremony(tx, a);
    await declineSigningRequestInTransaction(tx, a.requestId, { memoryId, signerId, mayWrite: mayWriteIn(tx) });
  });
}
