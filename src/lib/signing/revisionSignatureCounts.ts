/**
 * #2973 PR1 (cor:dmo:130:09, cor:agt:040:10 R35; Q-E per cor:dmo:130:09 r8) — does revision `revision` of node
 * `nodeId` carry a signature that COUNTS? The per-revision predicate the signed serve selection walks, and (PR3) the
 * include `signed` setting will share.
 *
 * Three legs, all of which must hold for SOME one `NodeSignature` row on the node:
 *
 * - **Coverage** (cor:dmo:130:09): the signature's revision ≤ N, and no revision in (its revision, N] changed the
 *   title, abstract or content. This is judged from the REVISION HISTORY — each span revision's snapshot must still
 *   exist and hash to the signature's own approval hash — never from the live `content_changed_at` marker
 *   (`loadSignatureStatuses` judges that; a later edit must not turn an earlier signature into EARLIER for every
 *   revision). A missing witness fails CLOSED: a deleted snapshot is not evidence of "no change", so deleting the
 *   A→B step of an A→B→A history cannot revive coverage of the restored text. A restore is itself a change and never
 *   revives coverage (cor:dmo:130:04).
 * - **State (C2)**: re-verified now, on the DB signing clock (`hadron_signing_now()`, the same clock
 *   `loadSignatureStatuses` judges windows by; #3746's `hadron_passkey_now()` is the registration and lifecycle-stamp
 *   clock). The verdict is `deriveSignatureState`'s window logic with "changed" judged per revision above, so: pending
 *   until its first-key window ends normally, cancelled / invalid / not-applicable (an encrypted memory) never, and a
 *   passkey revoked after signing — outside the first-key window — does not stop it counting (cor:dmo:130:04).
 * - **Signer eligibility (C1, Q-E)**: judged WHEN THE SIGNATURE WAS MADE, never re-checked now — a signer who has
 *   since left still counts, and re-deriving eligibility now is exactly what Q-E forbids. The ceremony's durable
 *   verdict, the request it completed, is the record read here: a completed request pinning this node, this revision
 *   and this hash. For a compiled boot prompt (and, in PR3, an include's `signed`) the ceremony's own at-signing
 *   write-access check (cor:dmo:130:02) IS the eligibility rule — in those memories the writers are the managers
 *   (cor:agt:040:18) — so no present-day re-derivation exists in this predicate at all.
 *
 * The predicate NEVER reads the deployment's surface policy: `PASSKEY_SIGNING_ENABLED` is G2's term and belongs to the
 * serve (`servingAppRequiresSignature`), which composes it with the organisation's switch. It reads nothing but the
 * node, its revision history, its signature records with their passkeys and their signing requests.
 */
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import { computeApprovalHash } from '../approvalHash.js';
import { deriveSignatureState } from './state.js';
import { signatureRecordVerifies } from './verify.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Which rule requires the signature. PR1 has one; PR3's include `signed` setting names its own. */
export type SignatureRequirement = 'compiled-boot-prompt';

interface SpanFields {
  name: string;
  abstract: string | null;
  content: string | null;
}

/**
 * True only when some signature on the node covers `revision`, re-verifies to a counting state now, and was made
 * through a request the ceremony completed (its durable at-signing verdict). Pure read; `db` may be a transaction
 * client. A node that no longer exists, or an encrypted memory, counts nothing (cor:dmo:120:00 mirror: no
 * hash-dependent work is done on an encrypted node's records at all).
 */
export async function revisionSignatureCounts(
  db: Db,
  nodeId: string,
  revision: number,
  requirement: SignatureRequirement,
): Promise<boolean> {
  switch (requirement) {
    case 'compiled-boot-prompt':
      // The ceremony's at-signing check is the whole eligibility rule (header, C1); the completed request below is
      // its durable verdict. There is deliberately no present-day eligibility re-derivation to branch on.
      break;
  }
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: { revSeq: true, name: true, abstract: true, content: true, memory: { select: { isEncrypted: true } } },
  });
  if (!node || node.memory.isEncrypted) return false;

  const signatures = await db.nodeSignature.findMany({
    where: { nodeId, revision: { lte: revision } },
    include: { passkey: { select: { credentialId: true, publicKey: true, revokedAt: true, windowEndsAt: true, windowEndedAt: true, windowOutcome: true } } },
  });
  if (signatures.length === 0) return false;

  // The ceremony's verdict for each signature's request, read once: a request the ceremony completed, pinning this
  // node at this revision and this hash. A request still open, or ended any other way (withdrawn, declined, expired,
  // stale), is not a completed signing — the signature seeded beside it does not count (C1).
  const requests = await db.signingRequest.findMany({
    where: { id: { in: [...new Set(signatures.map((s) => s.signingRequestId))] } },
    select: { id: true, state: true, nodeId: true, revision: true, approvalHash: true },
  });
  const requestOf = new Map(requests.map((r) => [r.id, r]));

  // The span evidence, read once for every revision any candidate signature must be judged over: the newest snapshot
  // at each number (by id, as every other revision read resolves duplicates), whichever memory captured it — only a
  // HASH is compared against a hash already in the serve's own data, so a snapshot captured in another memory is an
  // honest witness here without any text crossing memories.
  const lowestSigned = Math.min(...signatures.map((s) => s.revision));
  const snapshots = await db.nodeRevision.findMany({
    where: { nodeId, revNo: { gt: lowestSigned, lte: revision } },
    orderBy: { id: 'desc' },
    select: { revNo: true, name: true, abstract: true, content: true },
  });
  const spanFields = new Map<number, SpanFields>();
  for (const s of snapshots) {
    if (s.revNo != null && !spanFields.has(s.revNo)) spanFields.set(s.revNo, { name: s.name, abstract: s.abstract, content: s.content });
  }

  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;

  for (const sig of signatures) {
    // Eligibility (C1 / Q-E): the ceremony's durable verdict only, never a present-day re-derivation.
    const req = requestOf.get(sig.signingRequestId);
    if (!req || req.state !== 'completed' || req.nodeId !== nodeId || req.revision !== sig.revision || req.approvalHash !== sig.approvalHash) continue;

    // Coverage (cor:dmo:130:09): every revision in (sig.revision, revision] must still be witnessed by a snapshot that
    // hashes to the signed hash — a missing or differing witness fails this signature closed.
    let covered = true;
    for (let r = sig.revision + 1; r <= revision; r++) {
      // The live row is revision `revSeq`'s own witness while no snapshot holds its number (a snapshot at the number,
      // whichever memory captured it, is the pinned witness instead — the same resolution every revision read uses).
      const fields = spanFields.get(r) ?? (r === node.revSeq ? { name: node.name, abstract: node.abstract, content: node.content } : null);
      if (!fields || computeApprovalHash({ title: fields.name, abstract: fields.abstract, content: fields.content }) !== sig.approvalHash) {
        covered = false;
        break;
      }
    }
    if (!covered) continue;

    // State (C2): re-verified on the signing clock. `contentChangedAt` is deliberately null — change is judged per
    // revision above, never from the live marker.
    const valid = await signatureRecordVerifies(
      {
        id: sig.id, nodeId: sig.nodeId, approvalHash: sig.approvalHash, payloadVersion: sig.payloadVersion, requestId: sig.signingRequestId,
        authenticatorData: Buffer.from(sig.authenticatorData), clientDataJson: Buffer.from(sig.clientDataJson), signature: Buffer.from(sig.signature),
      },
      { credentialId: Buffer.from(sig.passkey.credentialId), publicKey: Buffer.from(sig.passkey.publicKey), counter: 0n },
      // The record's own RP ID, never the current config: a domain change must not invalidate signatures made
      // before it (#10470).
      sig.rpId,
    );
    const state = deriveSignatureState({
      verifiedAt: sig.verifiedAt, valid, passkey: sig.passkey, contentChangedAt: null, memoryEncrypted: false, now,
    });
    if (state === 'CURRENT') return true;
  }
  return false;
}
