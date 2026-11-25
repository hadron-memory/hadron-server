/**
 * #5001 slice 3 (hrn:node:hadronmemory.com:specs:cor:acl:140:07, :09, :04; ruling 0255 item 19; ruling 0257): the SELECTION signing
 * ceremony's logic, below the HTTP routes (`src/api/grantSelectionSigningCeremonyRoutes.ts`). It mirrors the one-grant ceremony
 * (`grantCeremony.ts`) with its own purposes, its own proof prefix and its own cookie path, so no ceremony stands in for another.
 *
 *  1. PROOF (`GRANT_SELECTION_SIGN_PROOF`), bound to the selection id and the ceremony id. The assertion names the viewer. For EACH item
 *     the issuer gate is run first (cor:acl:140:04): the prover learns of an item only if they may issue it. A prover who may issue
 *     none, and an unknown id, get the one `CeremonyRefused` (the proof is spent either way: no counter oracle, #4546). Items the
 *     prover may not issue never appear, not even as a count.
 *  2. SIGN (`GRANT_SELECTION_SIGN`). The signing challenge is SHA-256 of the selection payload (cor:acl:140:09) over the items the
 *     prover was OFFERED: those they may issue, whose summary they can read, still open. The offered set is not stored: the browser
 *     names it (`grantIds`) and the server rebuilds the bytes from the items' own pins and checks the hash against the ceremony's
 *     bound challenge, so a different set is a different hash and is refused.
 *     `completeGrantSelectionSigning` judges everything under its locks; then, in ONE transaction, spends the ceremony, verifies the
 *     assertion once, records the one touch record, and for each item that still passes (alone) records its signature, completes its
 *     request and activates its grant. A failing item does not stop the others and is reported in its typed code.
 *
 * LOCK ORDER at completion (all locks before the ONE clock read): the authority anchors (App, org, owner; shared); the secret rows of
 * every `secret.reveal` item in ascending secret id, then the held workers FOR SHARE in ascending id; the App row; the ceremony; the
 * signer's org membership FOR SHARE; every offered item's GRANT FOR UPDATE in ASCENDING grant id, each its own statement (so a race pin
 * can pause between them); the selection; every offered item's request in ascending grant id; the signer's credential. Every other
 * writer that ends an item takes the grant rows first (ascending) and then the request or the selection, so no order cycles.
 */
import { randomBytes } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../auth/authorityAnchors.js';
import { consumeCeremony, decideCeremonyAssertion, verifyCeremonyAssertion } from '../passkeys/ceremony.js';
import { lockSecretRow } from '../secrets/appSecrets.js';
import { requireProtectedSecretHolder } from '../secrets/protection.js';
import { autoDeleteLimitRefusal } from '../secrets/autoDelete.js';
import { emitEntityUrnV2 } from '../urnEmit.js';
import type { AssertionParts } from './verify.js';
import { verifySigningAssertion } from './verify.js';
import { signatureChallenge } from './payload.js';
import { passkeyRpId, signingCeremonyOrigins, SigningNotConfiguredError } from './config.js';
import { effectiveRequestState } from './requests.js';
import { GrantSigningRefusal } from './grantRequests.js';
import * as grantLocks from './grantActivationLocks.js';
import { CeremonyRefused } from './signingCeremony.js';
import {
  GRANT_SELECTION_CAP, grantSelectionPayloadBytes, sortedSelectionItems, type GrantSelectionItem,
} from './grantSelectionPayload.js';
import {
  GRANT_SIGN_PROOF_TTL_SECONDS, GRANT_SIGN_TTL_SECONDS, ensureSecretReadClient, grantEnded, holderName, holderOf, loadCredential, mayIssue,
  personContext, readGrant, reasonAuthorOf, requesterOf, sha256, sha256Hex, summaryFor, type CredentialRow, type GrantRow,
} from './grantCeremony.js';

export { CeremonyRefused };

/** The proof challenge: its own prefix (never the one-grant proof's), bound to the selection AND the ceremony id. */
export function selectionProofChallenge(selectionId: string, ceremonyId: string): Buffer {
  return sha256(`hadron-grant-selection-signing-proof\nselection ${selectionId}\nceremony ${ceremonyId}\n`);
}

/** What happened to one OFFERED item at completion. `ACTIVATED` is the only success; each other code leaves its grant pending. */
export type SelectionItemOutcome =
  | 'ACTIVATED' | 'STALE' | 'EXPIRED' | 'SIGNER_NOT_ELIGIBLE'
  | 'SECRET_AUTO_DELETE_NEEDS_LIMIT' | 'SECRET_PROTECTED_TWO_PERSON_REQUIRED';

interface ItemRow { id: string; grantId: string; version: number; termsHash: string; payloadVersion: string; state: string; expiresAt: Date }

/** The signed bytes' challenge over `items` (the selection's own pins), or a throw for a pin the payload cannot hold. */
function selectionSigningChallenge(selectionId: string, payloadVersion: string, items: readonly ItemRow[]): Buffer {
  const list: GrantSelectionItem[] = items.map((i) => ({ grantId: i.grantId, recordVersion: i.version, termsHash: i.termsHash }));
  return signatureChallenge(grantSelectionPayloadBytes(payloadVersion, { selectionId, items: list }));
}

/** The grant ids a browser names, as a clean ascending list, or null when they are not a plausible offered set. */
function offeredIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > GRANT_SELECTION_CAP) return null;
  const ids = new Set<string>();
  for (const x of v) {
    if (typeof x !== 'string' || x.length === 0 || x.length > 64 || !/^[A-Za-z0-9_-]+$/.test(x) || ids.has(x)) return null;
    ids.add(x);
  }
  return sortedSelectionItems([...ids].map((grantId) => ({ grantId }))).map((i) => i.grantId);
}
export { offeredIds as normalizeOfferedGrantIds };

/** Open a proof ceremony for the browser. Reads nothing about the selection: the same answer for every id. */
export async function openGrantSelectionProofCeremony(
  db: PrismaClient,
  input: { selectionId: string; browserNonceHash: string },
): Promise<{ ceremonyId: string; challenge: string }> {
  const ceremonyId = randomBytes(32).toString('base64url');
  const challenge = selectionProofChallenge(input.selectionId, ceremonyId);
  await db.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at)
    VALUES (${ceremonyId}, 'GRANT_SELECTION_SIGN_PROOF', ${input.browserNonceHash}, ${sha256Hex(challenge)},
            (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${GRANT_SIGN_PROOF_TTL_SECONDS}))`;
  return { ceremonyId, challenge: challenge.toString('base64url') };
}

export interface SelectionCeremonyItemView {
  grantId: string;
  /** OFFERED: shown and signable. UNREADABLE: shown without a sentence, not signable. ENDED: no longer signable (`endedState`). */
  status: 'OFFERED' | 'UNREADABLE' | 'ENDED';
  endedState: string | null;
  summary: string | null;
  requesterReason: string;
  reasonAuthor: { name: string | null; via: string | null; run: boolean };
  holder: { kind: 'user' | 'agent' | 'worker' | 'app'; name: string | null };
  startsAt: string | null;
  expiresAt: string | null;
  maxUses: number | null;
}

export interface SelectionCeremonyView {
  app: { urn: string };
  requester: { name: string; via: string | null };
  requestExpiresAt: string;
  items: SelectionCeremonyItemView[];
}

export type GrantSelectionProofResult =
  | { outcome: 'open'; view: SelectionCeremonyView; canSign: boolean; offered: string[]; /** For the route's cookie; never in the body. */ sessionNonce?: string }
  | { outcome: 'ended'; state: string };

/** #4546: the selection's own anonymous refusal time. The proof spend has ALREADY committed; this never changes the bare refusal. */
async function recordSelectionRefusalObservation(db: PrismaClient, o: { selectionId: string; attemptedAt: Date }): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '750ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
      await tx.$executeRaw`UPDATE grant_signing_selections
        SET last_refused_at = GREATEST(last_refused_at, (${o.attemptedAt}::timestamptz AT TIME ZONE 'UTC'))
        WHERE id = ${o.selectionId} AND state = 'open' AND expires_at > hadron_signing_now()`;
    }, { maxWait: 1000, timeout: 1500 });
  } catch {
    console.warn('grant.signing.selection_refusal_observation_failed');
  }
}

/**
 * The proof step: verify the assertion over the selection-bound proof challenge OUTSIDE any transaction; then, in one, anchor the
 * prover (exclusive), spend the proof, run the issuer gate for EVERY item first, and only then build what the prover may see.
 */
export async function proveForGrantSelectionSigning(db: PrismaClient, a: {
  selectionId: string; ceremonyId: string; browserNonceHash: string;
  credentialId: Buffer; assertion: AssertionParts; rpId: string; origins: string[];
}): Promise<GrantSelectionProofResult> {
  const cred = await loadCredential(db, a.credentialId);
  if (!cred || cred.revoked_at !== null || cred.enrollment_rp_id !== a.rpId) throw new CeremonyRefused();
  let verified;
  try {
    verified = await verifyCeremonyAssertion({
      assertion: a.assertion,
      credential: { passkeyId: cred.id, ownerId: cred.owner_id, credentialId: cred.credential_id, publicKey: cred.public_key, counter: cred.counter },
      expectedChallenge: selectionProofChallenge(a.selectionId, a.ceremonyId), rpId: a.rpId, origins: a.origins,
    });
  } catch { throw new CeremonyRefused(); }

  const result = await db.$transaction<GrantSelectionProofResult | { outcome: 'refused'; observation?: { selectionId: string; attemptedAt: Date } }>(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: cred.owner_id }], 'exclusive');
    const ctx = await personContext(tx, cred.owner_id);
    if (!ctx) throw new CeremonyRefused();
    const decided = await decideCeremonyAssertion(tx, { ceremonyId: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'GRANT_SELECTION_SIGN_PROOF', verified: verified.snapshot });
    if (!decided || decided.ownerId !== cred.owner_id) throw new CeremonyRefused();

    const sel = await tx.grantSigningSelection.findUnique({ where: { id: a.selectionId } });
    if (!sel) return { outcome: 'refused' };
    const rows = sortedSelectionItems(await tx.grantSigningRequest.findMany({ where: { selectionId: sel.id } }));
    // The issuer gate for EVERY item before anything about any of them is read into a view.
    const issuable: Array<{ item: (typeof rows)[number]; g: GrantRow }> = [];
    for (const item of rows) {
      const g = await readGrant(tx, item.grantId, sel.appId);
      if (g && (await mayIssue(ctx, g.action, sel.appId, g.id))) issuable.push({ item, g });
    }
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    if (issuable.length === 0) return { outcome: 'refused', observation: { selectionId: sel.id, attemptedAt: now } };
    const state = effectiveRequestState(sel, now);
    if (state !== 'open') return { outcome: 'ended' as const, state: state.toUpperCase() };

    const app = await tx.app.findUnique({ where: { id: sel.appId }, select: { urn: true } });
    if (!app) throw new CeremonyRefused();
    const appUrn = emitEntityUrnV2('app', app.urn);
    const items: SelectionCeremonyItemView[] = [];
    const offered: typeof rows = [];
    for (const { item, g } of issuable) {
      const itemState = effectiveRequestState(item, now);
      const ended = itemState !== 'open' ? (itemState === 'expired' ? 'EXPIRED' : 'STALE') : grantEnded(g, item, now);
      const summary = ended ? null : await summaryFor(ctx, tx, g, appUrn);
      const holder = holderOf(g);
      const status = ended ? 'ENDED' as const : summary === null ? 'UNREADABLE' as const : 'OFFERED' as const;
      if (status === 'OFFERED') offered.push(item);
      items.push({
        grantId: g.id, status, endedState: ended, summary, requesterReason: g.reason, reasonAuthor: await reasonAuthorOf(tx, g),
        holder: { kind: holder.kind, name: await holderName(tx, holder) },
        startsAt: g.starts_at?.toISOString() ?? null, expiresAt: g.expires_at?.toISOString() ?? null, maxUses: g.max_uses,
      });
    }
    const view: SelectionCeremonyView = { app: { urn: appUrn }, requester: await requesterOf(tx, sel), requestExpiresAt: sel.expiresAt.toISOString(), items };
    // As the one-grant proof: a FRESH server-chosen nonce binds the signing ceremony to this browser; a newer proof retires this
    // prover's earlier selection ceremony in this browser, BEFORE the can't-sign answer.
    const sessionNonce = randomBytes(32).toString('base64url');
    await tx.$executeRaw`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE purpose = 'GRANT_SELECTION_SIGN' AND user_id = ${cred.owner_id}
        AND browser_nonce_hash IN (${a.browserNonceHash}, ${sha256Hex(sessionNonce)}) AND consumed_at IS NULL`;
    if (offered.length === 0) return { outcome: 'open' as const, view, canSign: false, offered: [] };
    let challenge: Buffer;
    try { challenge = selectionSigningChallenge(sel.id, sel.payloadVersion, offered); } catch { return { outcome: 'ended' as const, state: 'STALE' }; }
    await tx.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at, user_id, kind)
      VALUES (${randomBytes(32).toString('base64url')}, 'GRANT_SELECTION_SIGN', ${sha256Hex(sessionNonce)}, ${sha256Hex(challenge)},
              (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${GRANT_SIGN_TTL_SECONDS}), ${cred.owner_id}, 'sign')`;
    return { outcome: 'open' as const, view, canSign: true, offered: offered.map((o) => o.grantId), sessionNonce };
  });
  if (result.outcome === 'refused') {
    if (result.observation) await recordSelectionRefusalObservation(db, result.observation);
    throw new CeremonyRefused();
  }
  return result;
}

/**
 * `/challenge`: the signing challenge over the offered set the browser names, read back from the ONE live ceremony this browser's
 * proof minted whose bound challenge is exactly that set's hash. Anything else is the one refusal; nothing is minted.
 */
export async function currentGrantSelectionSigningChallenge(db: PrismaClient, a: { selectionId: string; grantIds: unknown; browserNonceHash: string; rpId: string }): Promise<{
  ceremonyId: string; challenge: string; rpId: string; allowCredentials: string[];
}> {
  const ids = offeredIds(a.grantIds);
  if (!ids) throw new CeremonyRefused();
  const sel = await db.grantSigningSelection.findUnique({ where: { id: a.selectionId } });
  if (!sel) throw new CeremonyRefused();
  const rows = await db.grantSigningRequest.findMany({ where: { selectionId: sel.id, grantId: { in: ids } } });
  if (rows.length !== ids.length) throw new CeremonyRefused();
  let challenge: Buffer;
  try { challenge = selectionSigningChallenge(sel.id, sel.payloadVersion, rows); } catch { throw new CeremonyRefused(); }
  const [cer] = await db.$queryRaw<Array<{ id: string; user_id: string | null }>>`
    SELECT id, user_id FROM passkey_ceremonies
     WHERE purpose = 'GRANT_SELECTION_SIGN' AND browser_nonce_hash = ${a.browserNonceHash} AND challenge_hash = ${sha256Hex(challenge)}
       AND consumed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
     ORDER BY created_at DESC LIMIT 1`;
  if (!cer?.user_id) throw new CeremonyRefused();
  const creds = await db.$queryRaw<Array<{ credential_id: Buffer }>>`SELECT credential_id FROM passkey_credentials
    WHERE owner_id = ${cer.user_id} AND revoked_at IS NULL AND enrollment_rp_id = ${a.rpId}`;
  return { ceremonyId: cer.id, challenge: challenge.toString('base64url'), rpId: a.rpId, allowCredentials: creds.map((c) => Buffer.from(c.credential_id).toString('base64url')) };
}

interface Located {
  appId: string; anchors: AuthorityAnchor[]; app: { organizationId: string | null; ownerUserId: string | null }; signerId: string;
  ids: string[]; items: Map<string, ItemRow>; payloadVersion: string;
}

/** The unlocked pre-read that NAMES the anchors and rows to lock. It authorizes nothing: everything is read again under the locks. */
async function locate(db: PrismaClient, a: { selectionId: string; ceremonyId: string; grantIds: unknown }): Promise<Located> {
  const ids = offeredIds(a.grantIds);
  if (!ids) throw new CeremonyRefused();
  const sel = await db.grantSigningSelection.findUnique({ where: { id: a.selectionId } });
  if (!sel) throw new CeremonyRefused();
  const rows = await db.grantSigningRequest.findMany({ where: { selectionId: sel.id, grantId: { in: ids } } });
  if (rows.length !== ids.length) throw new CeremonyRefused();
  const app = await db.app.findUnique({ where: { id: sel.appId }, select: { organizationId: true, ownerUserId: true } });
  if (!app) throw new CeremonyRefused();
  const [peek] = await db.$queryRaw<Array<{ user_id: string | null }>>`
    SELECT user_id FROM passkey_ceremonies WHERE id = ${a.ceremonyId} AND purpose = 'GRANT_SELECTION_SIGN'`;
  if (!peek?.user_id) throw new CeremonyRefused();
  const anchors: AuthorityAnchor[] = [
    { kind: 'app', id: sel.appId },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ];
  return { appId: sel.appId, anchors, app, signerId: peek.user_id, ids, items: new Map(rows.map((r) => [r.grantId, r])), payloadVersion: sel.payloadVersion };
}

/** Lock the App-level rows and the ceremony, then every offered grant ascending (shared by completion and decline). */
async function lockPrefix(tx: Prisma.TransactionClient, loc: Located, a: { ceremonyId: string }) {
  // S4: secret rows (ascending secret id) and the held workers (ascending id) of every reveal item, before ceremony/grant/request/credential.
  const pre = new Map<string, GrantRow>();
  for (const id of loc.ids) {
    const g = await readGrant(tx, id, loc.appId);
    if (!g) throw new CeremonyRefused();
    pre.set(id, g);
  }
  const reveal = [...pre.values()].filter((g) => g.action === 'secret.reveal');
  const secretIds = [...new Set(reveal.map((g) => (g.action_values as Record<string, unknown>).secret))];
  if (secretIds.some((s) => typeof s !== 'string')) throw new CeremonyRefused();
  for (const secretId of (secretIds as string[]).sort()) if (!(await lockSecretRow(tx, secretId))) throw new CeremonyRefused();
  for (const workerId of [...new Set(reveal.map((g) => g.worker_id).filter((w): w is string => w !== null))].sort()) {
    await tx.$queryRaw`SELECT id FROM workers WHERE id = ${workerId} FOR SHARE`;
  }
  const [app] = await tx.$queryRaw<Array<{ organization_id: string | null; owner_user_id: string | null }>>`
    SELECT organization_id, owner_user_id FROM apps WHERE id = ${loc.appId}`;
  if (!app || app.organization_id !== loc.app.organizationId || app.owner_user_id !== loc.app.ownerUserId) throw new CeremonyRefused();
  const [cer] = await tx.$queryRaw<Array<{ challenge_hash: string | null; browser_nonce_hash: string; consumed_at: Date | null; expires_at: Date }>>`
    SELECT challenge_hash, browser_nonce_hash, consumed_at, expires_at FROM passkey_ceremonies
     WHERE id = ${a.ceremonyId} AND purpose = 'GRANT_SELECTION_SIGN' AND user_id = ${loc.signerId} FOR UPDATE`;
  if (!cer) throw new CeremonyRefused();
  if (loc.app.organizationId) {
    await tx.$queryRaw`SELECT 1 FROM org_members WHERE organization_id = ${loc.app.organizationId} AND user_id = ${loc.signerId} FOR SHARE`;
  }
  // Every grant FOR UPDATE, ascending, each its own statement, through the module export so a race pin can pause between them.
  for (const id of loc.ids) if (!(await grantLocks.lockGrantForSigning(tx, id, loc.appId))) throw new CeremonyRefused();
  const grants = new Map<string, GrantRow>();
  for (const id of loc.ids) {
    const g = await readGrant(tx, id, loc.appId);
    if (!g) throw new CeremonyRefused();
    const before = pre.get(id)!;
    if (g.action === 'secret.reveal') {
      const s = (g.action_values as Record<string, unknown>).secret;
      if (before.action !== 'secret.reveal' || g.worker_id !== before.worker_id || typeof s !== 'string' || s !== (before.action_values as Record<string, unknown>).secret) throw new CeremonyRefused();
    }
    grants.set(id, g);
  }
  return { cer, grants };
}

export interface GrantSelectionCompletion { outcomes: Array<{ grantId: string; outcome: SelectionItemOutcome }> }

/** The whole-call refusal R9 raises when every offered item fails: the first failing item's own code. */
function allFailedRefusal(first: { outcome: SelectionItemOutcome }): GrantSigningRefusal {
  switch (first.outcome) {
    case 'SIGNER_NOT_ELIGIBLE': return new GrantSigningRefusal('SIGNER_NOT_ELIGIBLE', 'You can no longer issue any of these grants.');
    case 'SECRET_AUTO_DELETE_NEEDS_LIMIT': return new GrantSigningRefusal('SECRET_AUTO_DELETE_NEEDS_LIMIT', 'A secret grant that deletes its secret needs a limit.');
    case 'SECRET_PROTECTED_TWO_PERSON_REQUIRED': return new GrantSigningRefusal('SIGNER_NOT_ELIGIBLE', 'A protected secret requires a different person to hold its read client.');
    default: return new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'None of these grants can be signed any more.', { state: first.outcome });
  }
}

/**
 * Complete: ONE transaction judges everything under its locks (whole-call refusals first, then each offered item alone, without
 * throwing), then spends the ceremony, verifies the assertion once, records the touch record, and for each passing item (ascending)
 * its signature, its completed request and its activation. All items failing is a whole-call refusal with nothing recorded and the
 * ceremony unspent (R9). A ceremony problem is `CeremonyRefused`; what the completion itself refuses is a typed `GrantSigningRefusal`.
 */
export async function completeGrantSelectionSigning(db: PrismaClient, a: {
  selectionId: string; ceremonyId: string; grantIds: unknown; browserNonceHash: string; credentialId: Buffer; assertion: AssertionParts;
}): Promise<GrantSelectionCompletion> {
  const loc = await locate(db, a);
  const ctx = { db, userId: loc.signerId, roles: [] } as unknown as Context;
  let outcomes: GrantSelectionCompletion['outcomes'] = [];
  await withAuthorizedTx(ctx, loc.anchors, async () => undefined, async (tx, txCtx) => {
    const { cer, grants } = await lockPrefix(tx, loc, a);
    await tx.$queryRaw`SELECT id FROM grant_signing_selections WHERE id = ${a.selectionId} FOR UPDATE`;
    const [sel] = await tx.$queryRaw<Array<{ id: string; app_id: string; payload_version: string; state: string; expires_at: Date }>>`
      SELECT id, app_id, payload_version, state, expires_at FROM grant_signing_selections WHERE id = ${a.selectionId}`;
    if (!sel || sel.app_id !== loc.appId || sel.payload_version !== loc.payloadVersion) throw new CeremonyRefused();
    const items: ItemRow[] = [];
    for (const id of loc.ids) {
      const [r] = await tx.$queryRaw<Array<{ id: string; grant_id: string; version: number; terms_hash: string; payload_version: string; state: string; expires_at: Date; selection_id: string | null }>>`
        SELECT id, grant_id, version, terms_hash, payload_version, state, expires_at, selection_id FROM grant_signing_requests
         WHERE id = ${loc.items.get(id)!.id} FOR UPDATE`;
      if (!r || r.selection_id !== sel.id || r.grant_id !== id) throw new CeremonyRefused();
      items.push({ id: r.id, grantId: r.grant_id, version: r.version, termsHash: r.terms_hash, payloadVersion: r.payload_version, state: r.state, expiresAt: r.expires_at });
    }
    const [credential] = await tx.$queryRaw<Array<CredentialRow & { window_ends_at: Date | null; window_outcome: string | null }>>`
      SELECT id, owner_id, credential_id, public_key, counter, revoked_at, enrollment_rp_id, window_ends_at, window_outcome
        FROM passkey_credentials WHERE credential_id = ${a.credentialId} AND owner_id = ${loc.signerId} FOR UPDATE`;
    // ONE clock read, after the last lock: every deadline below is judged on it.
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;

    // Whole-call refusals first.
    let challenge: Buffer;
    try { challenge = selectionSigningChallenge(sel.id, sel.payload_version, items); } catch { throw new CeremonyRefused(); }
    if (cer.consumed_at || cer.expires_at.getTime() <= now.getTime() || cer.browser_nonce_hash !== a.browserNonceHash
        || cer.challenge_hash !== sha256Hex(challenge)) {
      throw new CeremonyRefused();
    }
    const selState = effectiveRequestState({ state: sel.state, expiresAt: sel.expires_at }, now);
    if (selState !== 'open') throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.', { state: selState.toUpperCase() });
    const rpId = passkeyRpId();
    if (!credential || credential.revoked_at !== null || credential.enrollment_rp_id !== rpId) {
      throw new GrantSigningRefusal('SIGNATURE_NOT_VERIFIED', 'The signature did not verify.');
    }
    // Ruling 0257: a first passkey still in its cooling-off window cannot sign a grant: nothing recorded, every grant stays pending.
    if (credential.window_outcome === null && credential.window_ends_at !== null && credential.window_ends_at.getTime() > now.getTime()) {
      throw new GrantSigningRefusal('PASSKEY_COOLING_OFF', 'This passkey is still in its cooling-off period.');
    }

    // Each offered item, alone, without throwing.
    const verdicts: Array<{ item: ItemRow; g: GrantRow; outcome: SelectionItemOutcome }> = [];
    for (const item of items) {
      const g = grants.get(item.grantId)!;
      const itemState = effectiveRequestState({ state: item.state, expiresAt: item.expiresAt }, now);
      let outcome: SelectionItemOutcome = 'ACTIVATED';
      const ended = itemState !== 'open' ? (itemState === 'expired' ? 'EXPIRED' as const : 'STALE' as const) : grantEnded(g, item, now);
      if (ended) outcome = ended;
      else if (!(await mayIssue(txCtx, g.action, g.app_id, g.id))) outcome = 'SIGNER_NOT_ELIGIBLE';
      else {
        try {
          if (g.action === 'secret.reveal') {
            await requireProtectedSecretHolder(tx, (g.action_values as Record<string, unknown>).secret as string, loc.signerId, g.worker_id === null ? g.user_id : null);
          }
        } catch (e) {
          if (e instanceof GraphQLError && e.extensions?.code === 'SECRET_PROTECTED_TWO_PERSON_REQUIRED') outcome = 'SECRET_PROTECTED_TWO_PERSON_REQUIRED';
          else throw e;
        }
        if (outcome === 'ACTIVATED') {
          // #4001/#4594: a historical pending row must also obey the finite deletion rule at activation.
          const limit = autoDeleteLimitRefusal(['secret.reveal', 'secret.use'].includes(g.action) && (g.action_values as Record<string, unknown>)?.['auto-delete'] === 'delete', g.expires_at, g.max_uses);
          if (limit) outcome = 'SECRET_AUTO_DELETE_NEEDS_LIMIT';
        }
      }
      verdicts.push({ item, g, outcome });
    }
    // R9: every offered item failing refuses the whole call, nothing recorded, the ceremony unspent (the throw rolls everything back).
    if (verdicts.every((v) => v.outcome !== 'ACTIVATED')) throw allFailedRefusal(verdicts[0]!);

    if (!(await consumeCeremony(tx, { id: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'GRANT_SELECTION_SIGN' }))) throw new CeremonyRefused();
    let newCounter: number;
    try {
      ({ newCounter } = await verifySigningAssertion({
        assertion: a.assertion,
        credential: { credentialId: credential.credential_id, publicKey: credential.public_key, counter: credential.counter },
        payload: grantSelectionPayloadBytes(sel.payload_version, { selectionId: sel.id, items: items.map((i) => ({ grantId: i.grantId, recordVersion: i.version, termsHash: i.termsHash })) }),
        rpId,
        origins: signingCeremonyOrigins(),
      }));
    } catch (e) {
      if (e instanceof SigningNotConfiguredError) throw e;
      throw new GrantSigningRefusal('SIGNATURE_NOT_VERIFIED', 'The signature did not verify.');
    }
    await tx.$executeRaw`UPDATE passkey_credentials
       SET last_used_at = GREATEST(COALESCE(last_used_at, registered_at), (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)),
           counter = GREATEST(counter, ${BigInt(newCounter)})
     WHERE id = ${credential.id}`;
    // The ONE touch record, keeping the signed item list (every offered item, ascending): a later read rebuilds the bytes from it.
    const touch = await tx.grantSelectionSignature.create({
      data: {
        selectionId: sel.id, signerId: loc.signerId, passkeyCredentialId: credential.id, payloadVersion: sel.payload_version,
        items: items.map((i) => ({ grantId: i.grantId, version: i.version, termsHash: i.termsHash })),
        rpId,
        authenticatorData: new Uint8Array(a.assertion.authenticatorData),
        clientDataJson: new Uint8Array(a.assertion.clientDataJson),
        signature: new Uint8Array(a.assertion.signature),
      },
      select: { id: true },
    });
    for (const { item, g, outcome } of verdicts) {
      if (outcome !== 'ACTIVATED') continue;
      const holder = holderOf(g);
      const signature = await tx.grantSignature.create({
        data: {
          grantId: g.id, signingRequestId: item.id, signerId: loc.signerId, passkeyCredentialId: credential.id,
          version: item.version, termsHash: item.termsHash, holderKind: holder.kind, holderId: holder.id,
          payloadVersion: item.payloadVersion, rpId, selectionSignatureId: touch.id,
          authenticatorData: new Uint8Array(a.assertion.authenticatorData),
          clientDataJson: new Uint8Array(a.assertion.clientDataJson),
          signature: new Uint8Array(a.assertion.signature),
        },
        select: { id: true },
      });
      // The item completes BEFORE its grant activates: the activation's stale trigger then ends only the OTHER open requests.
      await tx.$executeRaw`UPDATE grant_signing_requests SET state = 'completed' WHERE id = ${item.id} AND state = 'open'`;
      await tx.$executeRaw`UPDATE grants
         SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC'), verification_kind = 'passkey', verified_by = ${loc.signerId},
             signature_id = ${signature.id}, updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
       WHERE id = ${g.id}`;
      await tx.grantEvent.create({ data: { grantId: g.id, appId: g.app_id, action: 'ACTIVATE', actorUserId: loc.signerId } });
      await ensureSecretReadClient(tx, g, loc.signerId);
    }
    // The selection completes; its trigger ends the items still open (the failed ones, and any not offered): a new request is needed (R6).
    await tx.$executeRaw`UPDATE grant_signing_selections SET state = 'completed' WHERE id = ${sel.id} AND state = 'open'`;
    outcomes = verdicts.map((v) => ({ grantId: v.item.grantId, outcome: v.outcome }));
  }, { lockMode: 'shared' });
  return { outcomes };
}

/** Decline (R10): the proven issuer's own signing ceremony turns the WHOLE selection down. Every grant stays pending. */
export async function declineGrantSelectionSigning(db: PrismaClient, a: { selectionId: string; ceremonyId: string; grantIds: unknown; browserNonceHash: string }): Promise<void> {
  const loc = await locate(db, a);
  const ctx = { db, userId: loc.signerId, roles: [] } as unknown as Context;
  await withAuthorizedTx(ctx, loc.anchors, async () => undefined, async (tx, txCtx) => {
    const { cer, grants } = await lockPrefix(tx, loc, a);
    await tx.$queryRaw`SELECT id FROM grant_signing_selections WHERE id = ${a.selectionId} FOR UPDATE`;
    const [sel] = await tx.$queryRaw<Array<{ id: string; app_id: string; payload_version: string; state: string; expires_at: Date }>>`
      SELECT id, app_id, payload_version, state, expires_at FROM grant_signing_selections WHERE id = ${a.selectionId}`;
    if (!sel || sel.app_id !== loc.appId) throw new CeremonyRefused();
    const rows = await tx.grantSigningRequest.findMany({ where: { selectionId: sel.id, grantId: { in: loc.ids } } });
    if (rows.length !== loc.ids.length) throw new CeremonyRefused();
    let challenge: Buffer;
    try { challenge = selectionSigningChallenge(sel.id, sel.payload_version, sortedSelectionItems(rows)); } catch { throw new CeremonyRefused(); }
    if (cer.challenge_hash !== sha256Hex(challenge)) throw new CeremonyRefused();
    if (!(await consumeCeremony(tx, { id: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'GRANT_SELECTION_SIGN' }))) throw new CeremonyRefused();
    let eligible = false;
    for (const g of grants.values()) if (await mayIssue(txCtx, g.action, g.app_id, g.id)) { eligible = true; break; }
    if (!eligible) throw new GrantSigningRefusal('SIGNER_NOT_ELIGIBLE', 'You can no longer issue these grants.');
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    const state = effectiveRequestState({ state: sel.state, expiresAt: sel.expires_at }, now);
    if (state !== 'open') throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.', { state: state.toUpperCase() });
    const n = await tx.$executeRaw`UPDATE grant_signing_selections SET state = 'declined' WHERE id = ${sel.id} AND state = 'open'`;
    if (n !== 1) throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.');
  }, { lockMode: 'shared' });
}
