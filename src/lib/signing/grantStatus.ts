/**
 * #3649 slice D (cor:acl:140:07, cor:acl:140:08; the cor:dmo:130:04 / :06 node rules mirrored for grants): the
 * signatureStatus projection for a batch of grants. One query for the grant rows, one for their signature records (with
 * their passkeys), one database clock read; every record re-verified on read (cached per exact record and pins). The
 * caller has already authorized the reader for each grant (`grant(ref:)` / `grants`); this reads nothing else.
 *
 * A record's state:
 * - INVALID (counted in integrityProblems, never listed) when its stored assertion does not verify against its passkey's
 *   stored public key over the payload rebuilt from the record's OWN pins, or when the record is inconsistent with its
 *   row: its pins match the row's version and terms hash but it names another holder (the terms hash covers the holder,
 *   so only an altered record can do that).
 * - otherwise the node rules (`deriveSignatureState`): PENDING / CANCELLED by the first passkey's window, and EARLIER
 *   (not current) instead of CURRENT when the record's version or terms hash no longer matches the row.
 *
 * No grant state label (pending, active, expired, ...) is derived here: the lifecycle cases cor:acl:140:03 leaves open
 * stay unnamed (gate selection 3). `Grant.allows` is the live allow/deny.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { GrantTermsError, grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { compareSignaturesForDisplay, deriveSignatureState, rollUpSignatureState } from './state.js';
import { grantSignatureRecordVerifies } from './verify.js';

/** The states a grant signature can read in: the node states that apply to a grant (no encrypted memory). */
export type GrantSignatureState = 'CURRENT' | 'EARLIER' | 'PENDING' | 'CANCELLED';

export interface GrantSignatureView {
  id: string;
  /** Sealed: resolved to a live person's handle for display, never echoed (cor:acl:140:08). */
  signerId: string;
  passkeyLabel: string;
  passkeyRevokedAt: Date | null;
  version: number;
  termsHash: string;
  verifiedAt: Date;
  signingRequestId: string;
  payloadVersion: string;
  state: GrantSignatureState;
}

export interface GrantSignatureStatusView {
  state: GrantSignatureState | null;
  signatures: GrantSignatureView[];
  integrityProblems: number;
}

const EMPTY: GrantSignatureStatusView = { state: null, signatures: [], integrityProblems: 0 };

type Db = PrismaClient | Prisma.TransactionClient;

type HolderKind = 'user' | 'agent' | 'worker' | 'app';

interface GrantPins { version: number; termsHash: string | null; holder: { kind: HolderKind; id: string } | null }

/** The row's version, its terms hash (null when the terms cannot be written as hadron-grant-terms-v1) and its holder. */
function pinsOf(g: {
  appId: string; userId: string | null; agentId: string | null; workerId: string | null; granteeAppId: string | null;
  action: string; values: unknown; startsAt: Date | null; expiresAt: Date | null; maxUses: number | null; reason: string; version: number;
}): GrantPins {
  try {
    const terms = grantTermsFromRow(g);
    return { version: g.version, termsHash: grantTermsHash(terms), holder: terms.holder };
  } catch (e) {
    if (e instanceof GrantTermsError) return { version: g.version, termsHash: null, holder: null };
    throw e;
  }
}

/** The status of each grant in `grantIds`; a grant with no records gets the empty status. */
export async function loadGrantSignatureStatuses(db: Db, grantIds: string[]): Promise<Map<string, GrantSignatureStatusView>> {
  const out = new Map<string, GrantSignatureStatusView>();
  const ids = [...new Set(grantIds)];
  for (const id of ids) out.set(id, EMPTY);
  if (ids.length === 0) return out;
  const records = await db.grantSignature.findMany({
    where: { grantId: { in: ids } },
    include: { passkey: { select: { credentialId: true, publicKey: true, label: true, revokedAt: true, windowEndsAt: true, windowEndedAt: true, windowOutcome: true } } },
  });
  if (records.length === 0) return out;
  const rows = await db.grant.findMany({
    where: { id: { in: [...new Set(records.map((r) => r.grantId))] } },
    select: {
      id: true, appId: true, userId: true, agentId: true, workerId: true, granteeAppId: true, action: true, values: true,
      startsAt: true, expiresAt: true, maxUses: true, reason: true, version: true,
    },
  });
  const pinsByGrant = new Map(rows.map((g) => [g.id, pinsOf(g)]));
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
  const byGrant = new Map<string, { views: GrantSignatureView[]; problems: number }>();
  for (const r of records) {
    const row = pinsByGrant.get(r.grantId);
    if (!row) continue;
    const verifies = await grantSignatureRecordVerifies(
      { id: r.id, payloadVersion: r.payloadVersion, grantId: r.grantId, recordVersion: r.version, termsHash: r.termsHash, requestId: r.signingRequestId,
        authenticatorData: Buffer.from(r.authenticatorData), clientDataJson: Buffer.from(r.clientDataJson), signature: Buffer.from(r.signature) },
      { credentialId: Buffer.from(r.passkey.credentialId), publicKey: Buffer.from(r.passkey.publicKey), counter: 0n },
      // The record's own RP ID, never the current config (#10470 mirror).
      r.rpId,
    );
    const current = r.version === row.version && row.termsHash !== null && r.termsHash === row.termsHash;
    const consistent = !current || (row.holder !== null && r.holderKind === row.holder.kind && r.holderId === row.holder.id);
    const state = deriveSignatureState({
      verifiedAt: r.verifiedAt, valid: verifies && consistent, passkey: r.passkey,
      // A record no longer matching the row reads as a content change at its own time: EARLIER, never CURRENT.
      contentChangedAt: current ? null : r.verifiedAt,
      memoryEncrypted: false, now,
    });
    const entry = byGrant.get(r.grantId) ?? { views: [], problems: 0 };
    if (state === 'INVALID') entry.problems += 1;
    else if (state === 'CURRENT' || state === 'EARLIER' || state === 'PENDING' || state === 'CANCELLED') {
      entry.views.push({
        id: r.id, signerId: r.signerId, passkeyLabel: r.passkey.label, passkeyRevokedAt: r.passkey.revokedAt, version: r.version,
        termsHash: r.termsHash, verifiedAt: r.verifiedAt, signingRequestId: r.signingRequestId, payloadVersion: r.payloadVersion, state,
      });
    }
    byGrant.set(r.grantId, entry);
  }
  for (const [grantId, entry] of byGrant) {
    const views = entry.views.sort(compareSignaturesForDisplay);
    out.set(grantId, {
      state: rollUpSignatureState(views.map((v) => v.state), false) as GrantSignatureState | null,
      signatures: views,
      integrityProblems: entry.problems,
    });
  }
  return out;
}
