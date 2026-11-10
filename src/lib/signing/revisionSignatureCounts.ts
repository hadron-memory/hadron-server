/**
 * #2973 PR1 (cor:dmo:130:09, cor:agt:040:10 R35; Q-E per cor:dmo:130:09 r8) — does revision `revision` of node
 * `nodeId` carry a signature that COUNTS? The per-revision predicate the signed serve selection walks, and (PR3) the
 * include `signed` setting will share.
 *
 * Four legs, all of which must hold for SOME one `NodeSignature` row on the node:
 *
 * - **Coverage** (cor:dmo:130:09): the signature's revision ≤ N, and no revision in [its revision, N] changed the
 *   title, abstract or content — the signature's OWN revision included. This is judged from the REVISION HISTORY —
 *   each covered revision's snapshot (the live row while it is still the live revision's own witness) must still
 *   exist and hash to the signature's own approval hash — never from the live `content_changed_at` marker
 *   (`loadSignatureStatuses` judges that; a later edit must not turn an earlier signature into EARLIER for every
 *   revision). A missing witness fails CLOSED: a deleted snapshot is not evidence of "no change", so deleting the
 *   A→B step of an A→B→A history cannot revive coverage of the restored text. A restore is itself a change and never
 *   revives coverage (cor:dmo:130:04). Span witnesses may come from ANY memory (the #92963 ruling: a witness captured
 *   in another memory is complete-unchanged-HASH evidence, not a content change) — a hash is compared against a hash
 *   already in the serve's own data, so no text crosses memories.
 * - **State (C2)**: re-verified now, on the DB signing clock (`hadron_signing_now()`, the same clock
 *   `loadSignatureStatuses` judges windows by; #3746's `hadron_passkey_now()` is the registration and lifecycle-stamp
 *   clock). The verdict is `deriveSignatureState`'s window logic with "changed" judged per revision above, so: pending
 *   until its first-key window ends normally, cancelled / invalid / not-applicable (an encrypted memory) never, and a
 *   passkey revoked after signing — outside the first-key window — does not stop it counting (cor:dmo:130:04).
 * - **Signer eligibility (C1, Q-E): the ceremony stamp** — judged WHEN THE SIGNATURE WAS MADE, never re-checked now.
 *   The completed request (pins node/revision/hash) is necessary but not sufficient: a seeded row copies any static
 *   column, so the durable verdict is the `ceremony_stamp` HMAC under a retained registry key
 *   (`src/lib/signing/stampKeys.ts`), written only by the real completion after its locked authority checks. A stamp
 *   absent (the pre-watermark rows) or unverified — unknown key id, tampered columns — fails closed and never counts.
 *   A signer who has since left still counts (their stamp still verifies): Q-E keeps eligibility an at-signing fact.
 * - **Requirement + memory binding (the #92963 fence)**: for `compiled-boot-prompt` the stamp must carry the MANAGER
 *   grade — the completion judged the signer to manage an Agent or App, and the one it names must be the node's
 *   CURRENT memory's owner (cor:agt:040:18 via the shared `bootPromptOwnerOfMemory`) — and the memory at signing
 *   (the stamp's `stampMemoryId`, the durable capture-memory record: unprunable, HMAC-bound, impossible to seed) must
 *   be the node's current memory. A cross-memory move ends the old signature's counting (Rico §10 P2-1: the ceremony
 *   judged the OLD memory's managers; the requirement asks about the current one) and a move BACK restores it —
 *   EXACT counting parity (Xylon 6750288978): a snapshot captured in another memory is not itself a content change,
 *   so a metadata-only revision made elsewhere never blocks the restored count — no extra NOT_SIGNED refusal beyond
 *   the law (Vera 6750258496's named deviation is deliberately NOT built). The writer grade alone (a lawful writer
 *   who is not a manager) does not count for this requirement; PR3's include `signed` setting will ask for exactly
 *   that grade of the same stamp.
 *
 * **The interval law (why a WALK must not re-judge every candidate from scratch).** Of the four legs only COVERAGE
 * mentions the asked revision N, and coverage is an interval: per signature, the revisions it covers are exactly
 * [its own revision, `coveredThrough`] — every leg below coverage (request eligibility, stamp, fence) and the state
 * verdict are facts about the signature row and the node, the same for every N. So the whole predicate for every
 * revision of one node is ONE bounded set of reads (node, signatures, their requests, the span snapshots from the
 * lowest signed revision up, the owner, the clock, the stamp keys), after which each candidate costs an in-memory
 * interval test. Judging candidates one at a time instead — the shape this module had before #3801's serve adoption
 * made it a walk input — re-ran that whole set (the span read growing with the candidate's number) per candidate:
 * a node pushed past the serve's scan ceiling, a thousand approved-but-unsigned candidates over one pre-watermark
 * signature row, cost ~7 s on dev hardware in the author's local reproduction (reproven as a P2028 there — the live
 * requests' own cause stays unclassified in the QA record, which retained no server diagnostics; either way the
 * budget dependency is what the interval law removes). The walk therefore takes `lazyRevisionSignatureCounts`;
 * `revisionSignatureCounts` stays for the single-revision ask (PR3's include) and answers from the same loader.
 * No leg of the load can THROW on a malformed or planted row — the stamp key answers null, the tag check and the
 * record verification answer false, everything else is a fail-closed `continue` — so evaluating a signature that
 * sits above every candidate the walk will ask about cannot reject the walk: the lazy verdict equals the single
 * ask's at every revision at or below the node's head.
 *
 * The predicate NEVER reads the deployment's surface policy: `PASSKEY_SIGNING_ENABLED` is G2's term and belongs to the
 * serve (`servingAppRequiresSignature`), which composes it with the organisation's switch. It reads nothing but the
 * node, its memory, its revision history, its signature records with their passkeys, their signing requests, and the
 * stamp-key registry.
 */
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import { computeApprovalHash } from '../approvalHash.js';
import { bootPromptOwnerOfMemory } from '../bootPromptApproval.js';
import { deriveSignatureState } from './state.js';
import { signatureRecordVerifies } from './verify.js';
import { stampTagMatches, stampVerificationKey } from './stampKeys.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Which rule requires the signature. PR1 has one; PR3's include `signed` setting names its own. */
export type SignatureRequirement = 'compiled-boot-prompt';

interface WitnessFields {
  name: string;
  abstract: string | null;
  content: string | null;
}

/** One counting signature's reach: it counts at exactly the revisions in `[revision, coveredThrough]`. */
interface CountingSpan {
  revision: number;
  coveredThrough: number;
}

/**
 * Every counting signature of the node, as intervals — the one evaluation both exported predicates answer from. The
 * legs run in the order the per-candidate form ran them (request eligibility, stamp, fence, coverage, state), each
 * fail-closed `continue` unchanged; only coverage's shape moved: instead of a yes/no at one asked revision it walks
 * the witness run upward ONCE and records where it ends. `askCeiling` bounds both the signatures considered (one
 * above the asked revision cannot count there — today's `revision: { lte: revision }` filter) and the coverage walk
 * (the single-revision ask must not read beyond its own ask); `null` — a walk's factory — lets the interval run to
 * its natural end (a missing or differing witness, the live row's own number passed), reading the span to the
 * node's HEAD. That can exceed one per-candidate call read at the newest CANDIDATE when unapproved draft revisions
 * sit above it (their rows come along, content columns included) — but it is ONE read where the per-candidate form
 * paid one PER CANDIDATE, each as large, so the total stays far below it (Bob P3-1, BLIND delta at f22b3340). Pure
 * read; `db` may be a transaction client. A node that no longer exists, or an encrypted memory, counts nothing
 * (cor:dmo:120:00 mirror: no hash-dependent work is done on an encrypted node's records at all).
 */
async function countingSignatureSpans(
  db: Db,
  nodeId: string,
  requirement: SignatureRequirement,
  askCeiling: number | null,
): Promise<CountingSpan[]> {
  // The requirement type has exactly one member today; this line stops compiling the moment a second joins, so the
  // grade rules are decided per member instead of silently inheriting this branch (Bob old-8, delta review of
  // 77c9fda85b: a one-case switch read like runtime dispatch but was only documentation). For
  // 'compiled-boot-prompt': the stamp's manager grade must name the CURRENT memory's Agent or App (the fence below);
  // the writer grade alone never satisfies it. There is still no present-day eligibility re-derivation — the owner
  // resolution below asks WHERE the node serves, never WHO the signer now is.
  const exhaustiveRequirement: 'compiled-boot-prompt' = requirement;
  void exhaustiveRequirement;
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: { revSeq: true, name: true, abstract: true, content: true, memoryId: true, memory: { select: { isEncrypted: true } } },
  });
  if (!node || node.memory.isEncrypted) return [];

  const all = await db.nodeSignature.findMany({
    where: { nodeId },
    include: { passkey: { select: { credentialId: true, publicKey: true, revokedAt: true, windowEndsAt: true, windowEndedAt: true, windowOutcome: true } } },
  });
  if (all.length === 0) return [];
  const signatures = askCeiling == null ? all : all.filter((s) => s.revision <= askCeiling);
  if (signatures.length === 0) return [];

  // The ceremony's verdict for each signature's request, read once: a request the ceremony completed, pinning this
  // node at this revision and this hash. A request still open, or ended any other way (withdrawn, declined, expired,
  // stale), is not a completed signing — necessary, not sufficient: the stamp below is the signer-bound verdict.
  const requests = await db.signingRequest.findMany({
    where: { id: { in: [...new Set(signatures.map((s) => s.signingRequestId))] } },
    select: { id: true, state: true, nodeId: true, revision: true, approvalHash: true },
  });
  const requestOf = new Map(requests.map((r) => [r.id, r]));

  // The requirement's owner ask, resolved once: the Agent or App the node's CURRENT memory serves (null in a memory
  // that is no Agent's system memory and no App's install memory — nothing can match, so nothing counts there).
  const currentOwner = requirement === 'compiled-boot-prompt' ? await bootPromptOwnerOfMemory(db, node.memoryId) : null;

  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;

  // One registry read (a query plus an AES-GCM unwrap) per DISTINCT key id this node's signatures
  // name, not one per signature (Bob item 6, delta review of deef730133): a node signed across a
  // generation change names two ids however many signatures it carries. The cache lives for this
  // call only — the registry is small and a rotation between calls must be seen afresh.
  const stampKeys = new Map<number, Buffer | null>();
  const stampKeyOf = async (keyId: number): Promise<Buffer | null> => {
    if (!stampKeys.has(keyId)) stampKeys.set(keyId, await stampVerificationKey(db, keyId));
    return stampKeys.get(keyId) ?? null;
  };

  // Phase 1 — ELIGIBILITY, judged before any witness is read (#3826): no input of these legs consumes a snapshot field,
  // so a signature the ceremony never made eligible costs no history read at all, and the witness read below starts at
  // the lowest signature that survives, not the lowest candidate. Same legs, same order, each fail-closed `continue`
  // unchanged: only WHEN the snapshots are read moved, never what counts.
  const eligible: typeof signatures = [];
  for (const sig of signatures) {
    // Eligibility (C1 / Q-E): the ceremony's durable verdict only, never a present-day re-derivation.
    const req = requestOf.get(sig.signingRequestId);
    if (!req || req.state !== 'completed' || req.nodeId !== nodeId || req.revision !== sig.revision || req.approvalHash !== sig.approvalHash) continue;

    // The stamp: present, and verifying under the retained key it names, over the row's own identity fields plus the
    // attested columns beside it (a tampered column breaks the tag; the rows are append-only, so this catches seeds).
    // Unknown or undecryptable key ids fail closed. Pre-watermark rows (all stamp columns NULL) fail closed here.
    if (sig.ceremonyStamp == null || sig.stampKeyId == null || sig.stampMemoryId == null) continue;
    const stampKey = await stampKeyOf(sig.stampKeyId);
    if (stampKey == null) continue;
    const stampInputOk = stampTagMatches(stampKey, {
      keyId: sig.stampKeyId,
      nodeId: sig.nodeId,
      signingRequestId: sig.signingRequestId,
      signerId: sig.signerId,
      credentialId: Buffer.from(sig.passkey.credentialId),
      revision: sig.revision,
      approvalHash: sig.approvalHash,
      memoryId: sig.stampMemoryId,
      ownerKind: sig.stampOwnerKind as 'AGENT' | 'APP' | null,
      ownerId: sig.stampOwnerId,
    }, Buffer.from(sig.ceremonyStamp));
    if (!stampInputOk) continue;

    // The #92963 fence, for `compiled-boot-prompt`: the memory at signing is the node's current memory, and the
    // manager grade names the memory's CURRENT Agent or App (the requirement's own owner, resolved above). A node in
    // a memory with no boot-prompt owner counts nothing for this requirement. The stamp's `stampMemoryId` carries the
    // capture-memory binding ALONE — durable and HMAC-bound, so a pruned history cannot weaken it and a metadata-only
    // revision captured in another memory cannot trip it (exact counting parity; no extra NOT_SIGNED refusal).
    if (requirement === 'compiled-boot-prompt') {
      if (sig.stampMemoryId !== node.memoryId) continue;
      if (currentOwner == null || sig.stampOwnerKind !== currentOwner.kind || sig.stampOwnerId !== currentOwner.id) continue;
    }

    eligible.push(sig);
  }
  if (eligible.length === 0) return [];

  // The span evidence, read once for every revision any ELIGIBLE signature must be judged over: the newest snapshot
  // at each number (by id, as every other revision read resolves duplicates), whichever memory captured it — only a
  // HASH is compared against a hash already in the serve's own data, so a snapshot captured in another memory is an
  // honest witness here without any text crossing memories (and, per the fence ruling above, without its capture
  // memory ever counting against the signature).
  // A loop, not Math.min(...spread): a node with more signatures than the engine's argument cap must not
  // RangeError the serve (Bob old-7, delta review of 77c9fda85b).
  let lowestSigned = Number.MAX_SAFE_INTEGER;
  for (const s of eligible) if (s.revision < lowestSigned) lowestSigned = s.revision;
  const snapshots = await db.nodeRevision.findMany({
    where: askCeiling == null
      ? { nodeId, revNo: { gte: lowestSigned } }
      : { nodeId, revNo: { gte: lowestSigned, lte: askCeiling } },
    orderBy: { id: 'desc' },
    select: { revNo: true, name: true, abstract: true, content: true },
  });
  const spanFields = new Map<number, WitnessFields>();
  for (const s of snapshots) {
    if (s.revNo != null && !spanFields.has(s.revNo)) spanFields.set(s.revNo, { name: s.name, abstract: s.abstract, content: s.content });
  }

  // Phase 2 — coverage and state, per eligible signature.
  const spans: CountingSpan[] = [];
  for (const sig of eligible) {
    // Coverage (cor:dmo:130:09), as the INTERVAL it is: walk the witness run upward from the signature's own revision
    // while every revision still hashes to the signed hash — a missing or differing witness ends the run — and record
    // where it ends. The signature's OWN revision is judged like the rest, NOT trusted on the ceremony's at-signing
    // attestation alone: that attested the text AS IT WAS THEN, while the witness row can be rewritten after the
    // fact. Under this PR's own tampering model (replica-mode writes) an attacker who rewrites snapshot N's content
    // together with the approval leg's hash would serve unsigned text as signed if the own revision's text were never
    // re-compared (Bob P2-D, BLIND delta at 804d44cc). The request eligibility check above (req.approvalHash ===
    // sig.approvalHash, stamp-HMAC-bound) still pins WHICH hash the ceremony attested; this loop re-proves the text
    // NOW matches it. The live row is revision `revSeq`'s own witness while no snapshot holds its number (a snapshot
    // at the number, whichever memory captured it, is the pinned witness instead — the same resolution every revision
    // read uses). `askCeiling` caps the walk only for the single-revision ask, so it never reads past its question.
    let coveredThrough = sig.revision - 1;
    for (let r = sig.revision; askCeiling == null || r <= askCeiling; r++) {
      const fields = spanFields.get(r) ?? (r === node.revSeq ? { name: node.name, abstract: node.abstract, content: node.content } : null);
      if (!fields || computeApprovalHash({ title: fields.name, abstract: fields.abstract, content: fields.content }) !== sig.approvalHash) break;
      coveredThrough = r;
    }
    if (coveredThrough < sig.revision) continue;

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
    if (state === 'CURRENT') spans.push({ revision: sig.revision, coveredThrough });
  }
  return spans;
}

function spanCovers(spans: CountingSpan[], revision: number): boolean {
  for (const s of spans) if (s.revision <= revision && revision <= s.coveredThrough) return true;
  return false;
}

/**
 * True only when some signature on the node covers `revision`, re-verifies to a counting state now, was made
 * through a request the ceremony completed AND carries that ceremony's stamp for `requirement` — the durable
 * at-signing verdict. The single-revision ask (PR3's include `signed` setting); a walk over many candidates of one
 * node takes `lazyRevisionSignatureCounts` instead, which answers every candidate from one set of reads. Pure read;
 * `db` may be a transaction client. A node that no longer exists, or an encrypted memory, counts nothing
 * (cor:dmo:120:00 mirror: no hash-dependent work is done on an encrypted node's records at all).
 */
export async function revisionSignatureCounts(
  db: Db,
  nodeId: string,
  revision: number,
  requirement: SignatureRequirement,
): Promise<boolean> {
  const spans = await countingSignatureSpans(db, nodeId, requirement, revision);
  return spanCovers(spans, revision);
}

/**
 * The same predicate for a WALK that will ask about MANY revisions of one node (the signed serve selection, #3801's
 * continued batches): one lazy evaluation — the reads happen on the first ask, never when no candidate turns out
 * approved enough to ask — and every candidate after that is an in-memory interval test, so a node pushed past the
 * serve's scan ceiling costs one span read, not one per candidate (the interval law in the module doc). The lazy
 * value lives for this ONE predicate: nothing is cached across serves, and a failed load is not kept (the next ask
 * retries — which is meaningful OUTSIDE a transaction; inside one a failed query has already aborted it and the
 * error simply propagates, Bob P3-5, BLIND delta at f22b3340). The spans and the signing clock are captured ONCE,
 * at the first ask: a signature row, a passkey or the registry changing between the walk's batches is seen by the
 * NEXT resolve, not the one in flight — the same race class the per-candidate form had between one candidate and
 * the next, and the only lock the serve holds is the node row's share lock (Bob Q2, delta review of 77c9fda85b);
 * no new window is opened, the old one is widened by at most one request. The verdict equals
 * `revisionSignatureCounts` at every revision at or below the node's head, where the walk's candidates live.
 */
export function lazyRevisionSignatureCounts(
  db: Db,
  nodeId: string,
  requirement: SignatureRequirement,
): (revision: number) => Promise<boolean> {
  let spans: Promise<CountingSpan[]> | null = null;
  return async (revision: number) => {
    if (spans == null) {
      const loading = countingSignatureSpans(db, nodeId, requirement, null);
      loading.catch(() => { if (spans === loading) spans = null; });
      spans = loading;
    }
    return spanCovers(await spans, revision);
  };
}
