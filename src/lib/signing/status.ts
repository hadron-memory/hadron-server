/**
 * #1632 / cor:dmo:130:04/:06 — the signatureStatus projection for a batch of
 * nodes: one query for the records (with their passkeys), one for the nodes'
 * marker and memory encryption, every record re-verified (cached). The caller
 * has already authorized the reader for each node; this reads nothing else.
 */
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import { signatureRecordVerifies } from './verify.js';
import { compareSignaturesForDisplay, deriveSignatureState, rollUpSignatureState, type SignatureState } from './state.js';

export interface SignatureView {
  id: string;
  signerId: string;
  passkeyLabel: string;
  passkeyRevokedAt: Date | null;
  revision: number;
  verifiedAt: Date;
  signingRequestId: string;
  payloadVersion: string;
  state: SignatureState;
}

export interface NodeSignatureStatusView {
  state: SignatureState | null;
  signatures: SignatureView[];
  integrityProblems: number;
}

const EMPTY: NodeSignatureStatusView = { state: null, signatures: [], integrityProblems: 0 };

type Db = PrismaClient | Prisma.TransactionClient;

/** The status of each node in `nodeIds`; a node with no records gets the empty status. */
export async function loadSignatureStatuses(db: Db, nodeIds: string[]): Promise<Map<string, NodeSignatureStatusView>> {
  const out = new Map<string, NodeSignatureStatusView>();
  const ids = [...new Set(nodeIds)];
  if (ids.length === 0) return out;
  const nodes = await db.node.findMany({
    where: { id: { in: ids } },
    select: { id: true, contentChangedAt: true, memory: { select: { isEncrypted: true } } },
  });
  const nodeOf = new Map(nodes.map((n) => [n.id, n]));
  for (const id of ids) out.set(id, EMPTY);
  const records = await db.nodeSignature.findMany({
    where: { nodeId: { in: ids } },
    include: { passkey: { select: { credentialId: true, publicKey: true, label: true, revokedAt: true, windowEndsAt: true, windowEndedAt: true, windowOutcome: true } } },
  });
  if (records.length === 0) {
    // An encrypted node with no records still reads not applicable.
    for (const n of nodes) if (n.memory.isEncrypted) out.set(n.id, { ...EMPTY, state: 'NOT_APPLICABLE' });
    return out;
  }
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
  const byNode = new Map<string, { views: SignatureView[]; problems: number }>();
  for (const r of records) {
    const node = nodeOf.get(r.nodeId);
    if (!node) continue;
    const encrypted = node.memory.isEncrypted;
    // An encrypted node's records are not verified or returned (cor:dmo:120:00
    // mirror; #1632 contract note gap 3a): no hash-dependent work on them.
    const valid = encrypted ? true : await signatureRecordVerifies(
      { id: r.id, nodeId: r.nodeId, approvalHash: r.approvalHash, payloadVersion: r.payloadVersion, requestId: r.signingRequestId,
        authenticatorData: Buffer.from(r.authenticatorData), clientDataJson: Buffer.from(r.clientDataJson), signature: Buffer.from(r.signature) },
      { credentialId: Buffer.from(r.passkey.credentialId), publicKey: Buffer.from(r.passkey.publicKey), counter: 0n },
      // The record's own RP ID, never the current config: a domain change
      // must not invalidate signatures made before it (#10470).
      r.rpId,
    );
    const state = deriveSignatureState({
      verifiedAt: r.verifiedAt, valid, passkey: r.passkey, contentChangedAt: node.contentChangedAt, memoryEncrypted: encrypted, now,
    });
    const entry = byNode.get(r.nodeId) ?? { views: [], problems: 0 };
    if (state === 'INVALID') entry.problems += 1;
    else if (state !== 'NOT_APPLICABLE') {
      entry.views.push({
        id: r.id, signerId: r.signerId, passkeyLabel: r.passkey.label, passkeyRevokedAt: r.passkey.revokedAt,
        revision: r.revision, verifiedAt: r.verifiedAt, signingRequestId: r.signingRequestId, payloadVersion: r.payloadVersion, state,
      });
    }
    byNode.set(r.nodeId, entry);
  }
  for (const n of nodes) {
    const encrypted = n.memory.isEncrypted;
    const entry = byNode.get(n.id);
    if (!entry && !encrypted) continue;
    const views = (entry?.views ?? []).sort(compareSignaturesForDisplay);
    out.set(n.id, {
      state: rollUpSignatureState(views.map((v) => v.state), encrypted),
      signatures: encrypted ? [] : views,
      integrityProblems: encrypted ? 0 : entry?.problems ?? 0,
    });
  }
  return out;
}
