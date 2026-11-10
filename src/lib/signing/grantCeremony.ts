/**
 * #3649 slice C (hrn:node:hadronmemory.com:specs:cor:acl:140:07, :04, :03; ruling 0257) — the grant signing ceremony's
 * logic, below the HTTP routes (`src/api/grantSigningCeremonyRoutes.ts`). It mirrors node signing's
 * (`signingCeremony.ts`) with its own purposes, its own proof prefix and its own cookie path, so neither ceremony ever
 * stands in for the other.
 *
 *  1. PROOF (`GRANT_SIGN_PROOF`). `openGrantProofCeremony` mints a ceremony for this browser whose challenge is bound to
 *     the request id AND the ceremony id. The assertion over it (`proveForGrantSigning`) names the viewer: the
 *     credential's OWNER. Nothing about the grant leaves the server unless that person may ISSUE it (cor:acl:140:04: the
 *     action's issuer gate); anyone else, and an unknown id, gets the one `CeremonyRefused`.
 *  2. SIGN (`GRANT_SIGN`). A proven issuer who can read every node the summary names gets ONE signing ceremony, bound to
 *     them and to this request by its challenge: SHA-256 of the grant signature payload (cor:acl:140:09).
 *     `completeGrantSigning` judges everything under its locks and then, in ONE transaction, spends the ceremony,
 *     verifies the assertion, records the signature, completes the request and ACTIVATES the grant (the signer becomes
 *     the issuer). Every refusal rolls the whole transaction back, so nothing is half-written.
 *
 * LOCK ORDER at completion (the refold's C row): the authority anchors (App, its org, its owner, the signer; shared), the
 * App and org rows (`withAuthorizedTx`), then the GRANT_SIGN ceremony, the signer's org membership (FOR SHARE), the grant
 * (FOR UPDATE, `lockGrantForSigning`), the request, the signer's credential. The decision is taken on ONE database clock
 * read after the last lock. Every other writer that ends a request (revocation, a holder's departure, withdrawal) takes
 * the grant row before the request, so the two orders cannot cycle.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isMemoryReadableCached } from '../../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../auth/authorityAnchors.js';
import { consumeCeremony, decideCeremonyAssertion, verifyCeremonyAssertion } from '../passkeys/ceremony.js';
import { PLATFORM_ACTIONS } from '../grants/actions.js';
import { GraphQLError } from 'graphql';
import * as issuers from '../grants/issuers.js';
import { GrantSummaryError, renderGrantSummary } from '../grants/summary.js';
import { GrantTermsError, grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { emitEntityUrnV2, safeNodeUrnV2 } from '../urnEmit.js';
import type { AssertionParts } from './verify.js';
import { verifySigningAssertion } from './verify.js';
import { grantSignaturePayloadBytes } from './grantPayload.js';
import { signatureChallenge } from './payload.js';
import { passkeyRpId, signingCeremonyOrigins, SigningNotConfiguredError } from './config.js';
import { effectiveRequestState } from './requests.js';
import { GrantSigningRefusal } from './grantRequests.js';
import * as grantLocks from './grantActivationLocks.js';
import { CeremonyRefused } from './signingCeremony.js';

export { CeremonyRefused };

export const GRANT_SIGN_PROOF_TTL_SECONDS = 300;
/** Long enough to read the terms before signing; the ceremony is single-use and bound, so a longer window adds no replay. */
export const GRANT_SIGN_TTL_SECONDS = 600;

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();
const sha256Hex = (b: Uint8Array | string) => sha256(b).toString('hex');

/** The proof challenge: its own prefix (never node signing's), bound to the request AND the ceremony id. */
export function grantProofChallenge(requestId: string, ceremonyId: string): Buffer {
  return sha256(`hadron-grant-signing-proof\nrequest ${requestId}\nceremony ${ceremonyId}\n`);
}

interface RequestPins { id: string; grantId: string; version: number; termsHash: string; payloadVersion: string }

/** The signing challenge of a request: SHA-256 of its grant signature payload. Throws for a pin the payload cannot hold. */
function grantSigningChallenge(r: RequestPins): Buffer {
  return signatureChallenge(grantSignaturePayloadBytes(r.payloadVersion, {
    grantId: r.grantId, recordVersion: r.version, termsHash: r.termsHash, requestId: r.id,
  }));
}

/** Open a proof ceremony for the browser. Reads nothing about the request: the same answer for every id. */
export async function openGrantProofCeremony(
  db: PrismaClient,
  input: { requestId: string; browserNonceHash: string },
): Promise<{ ceremonyId: string; challenge: string }> {
  const ceremonyId = randomBytes(32).toString('base64url');
  const challenge = grantProofChallenge(input.requestId, ceremonyId);
  await db.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at)
    VALUES (${ceremonyId}, 'GRANT_SIGN_PROOF', ${input.browserNonceHash}, ${sha256Hex(challenge)},
            (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${GRANT_SIGN_PROOF_TTL_SECONDS}))`;
  return { ceremonyId, challenge: challenge.toString('base64url') };
}

interface CredentialRow {
  id: string; owner_id: string; credential_id: Buffer; public_key: Buffer; counter: bigint;
  revoked_at: Date | null; enrollment_rp_id: string;
}

async function loadCredential(db: PrismaClient, credentialId: Buffer): Promise<CredentialRow | null> {
  const [row] = await db.$queryRaw<CredentialRow[]>`SELECT id, owner_id, credential_id, public_key, counter, revoked_at, enrollment_rp_id
    FROM passkey_credentials WHERE credential_id = ${credentialId}`;
  return row ?? null;
}

/** A person's context for the shared gates, on the transaction's own client. */
async function personContext(tx: Prisma.TransactionClient, userId: string): Promise<Context | null> {
  const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, roles: true } });
  return user ? ({ db: tx, userId: user.id, roles: user.roles } as unknown as Context) : null;
}

/**
 * Whether `ctx` may issue a grant for `action` in `appId` (cor:acl:140:04). Every refusal the issuer gates raise is a
 * GraphQLError, and any of them is "no". Anything else (a database failure) is not an answer about eligibility and propagates
 * (Gloria P3-2, #3805): it must not read as SIGNER_NOT_ELIGIBLE.
 */
async function mayIssue(ctx: Context, action: string, appId: string): Promise<boolean> {
  try {
    await issuers.requireActionIssuer(ctx, action, appId);
    return true;
  } catch (e) {
    if (e instanceof GraphQLError) return false;
    throw e;
  }
}

interface GrantRow {
  id: string; app_id: string; user_id: string | null; agent_id: string | null; worker_id: string | null; grantee_app_id: string | null;
  action: string; action_values: unknown; starts_at: Date | null; expires_at: Date | null; max_uses: number | null; reason: string;
  version: number; activated_at: Date | null; revoked_at: Date | null; holder_departed_at: Date | null;
}

async function readGrant(tx: Prisma.TransactionClient, grantId: string, appId: string): Promise<GrantRow | null> {
  const [row] = await tx.$queryRaw<GrantRow[]>`
    SELECT id, app_id, user_id, agent_id, worker_id, grantee_app_id, action, action_values, starts_at, expires_at, max_uses, reason,
           version, activated_at, revoked_at, holder_departed_at
      FROM grants WHERE id = ${grantId} AND app_id = ${appId}`;
  return row ?? null;
}

function termsHashOf(g: GrantRow): string | null {
  try {
    return grantTermsHash(grantTermsFromRow({
      appId: g.app_id, userId: g.user_id, agentId: g.agent_id, workerId: g.worker_id, granteeAppId: g.grantee_app_id,
      action: g.action, values: g.action_values, startsAt: g.starts_at, expiresAt: g.expires_at, maxUses: g.max_uses, reason: g.reason,
    }));
  } catch (e) {
    if (e instanceof GrantTermsError) return null;
    throw e;
  }
}

/**
 * Why a grant can no longer be signed through this request, or null while it still can. Expiry is judged on the caller's
 * ONE clock read (`now`, taken after the completion's last lock), never on a clock sampled earlier: a lock wait that crosses
 * the deadline must read EXPIRED here, not reach the activation guard and fail as a raw refusal (Anne P2, #3805).
 */
function grantEnded(g: GrantRow, req: RequestPins, now: Date): 'STALE' | 'EXPIRED' | null {
  if (g.activated_at || g.revoked_at || g.holder_departed_at) return 'STALE';
  // A grant past its expiry can never be signed (ruling 0255 item 16).
  if (g.expires_at !== null && g.expires_at.getTime() <= now.getTime()) return 'EXPIRED';
  if (g.version !== req.version || termsHashOf(g) !== req.termsHash) return 'STALE';
  return null;
}

const holderOf = (g: GrantRow): { kind: 'user' | 'agent' | 'worker' | 'app'; id: string } =>
  g.user_id ? { kind: 'user', id: g.user_id }
    : g.agent_id ? { kind: 'agent', id: g.agent_id }
      : g.worker_id ? { kind: 'worker', id: g.worker_id }
        : { kind: 'app', id: g.grantee_app_id as string };

export interface GrantCeremonyView {
  /** The server's sentence (cor:acl:140:02, ruling 0258), or null when this person cannot read a node it names. */
  summary: string | null;
  /** The requester's own words, shown labelled as theirs; never part of the server's sentence. */
  requesterReason: string;
  requester: { name: string; via: string | null };
  holder: { kind: 'user' | 'agent' | 'worker' | 'app'; name: string | null };
  app: { urn: string };
  startsAt: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  requestExpiresAt: string;
}

export type GrantProofResult =
  | { outcome: 'open'; view: GrantCeremonyView; canSign: boolean; /** For the route's cookie; never in the body. */ sessionNonce?: string }
  | { outcome: 'ended'; state: string };

async function requesterOf(tx: Prisma.TransactionClient, r: { requesterUserId: string | null; requesterAppId: string | null; requesterWorkerId: string | null }) {
  const [user, app, worker] = await Promise.all([
    r.requesterUserId ? tx.user.findUnique({ where: { id: r.requesterUserId }, select: { handle: true } }) : null,
    r.requesterAppId ? tx.app.findUnique({ where: { id: r.requesterAppId }, select: { name: true } }) : null,
    r.requesterWorkerId ? tx.worker.findUnique({ where: { id: r.requesterWorkerId }, select: { name: true } }) : null,
  ]);
  return { name: user?.handle ?? app?.name ?? 'someone', via: worker?.name ?? null };
}

async function holderName(tx: Prisma.TransactionClient, h: { kind: string; id: string }): Promise<string | null> {
  switch (h.kind) {
    case 'user': return (await tx.user.findUnique({ where: { id: h.id }, select: { handle: true } }))?.handle ?? null;
    case 'agent': return (await tx.agent.findUnique({ where: { id: h.id }, select: { name: true } }))?.name ?? null;
    case 'worker': return (await tx.worker.findUnique({ where: { id: h.id }, select: { name: true } }))?.name ?? null;
    default: return (await tx.app.findUnique({ where: { id: h.id }, select: { name: true } }))?.name ?? null;
  }
}

/**
 * The summary as this person may read it: every node the grant names is resolved to its URN behind the prover's own read
 * gate. A node the prover cannot read, a deleted one, or a summary that cannot be written is null: the page then shows no
 * sentence and offers no signing (a person never signs terms they could not read).
 */
async function summaryFor(ctx: Context, tx: Prisma.TransactionClient, g: GrantRow, appUrn: string): Promise<string | null> {
  const action = PLATFORM_ACTIONS.find((a) => a.name === g.action);
  if (!action || !g.action_values || typeof g.action_values !== 'object' || Array.isArray(g.action_values)) return null;
  const values = g.action_values as Record<string, unknown>;
  const refs: Record<string, { urn: string }> = {};
  for (const p of action.parameters) {
    if (p.type !== 'node-ref') continue;
    const id = values[p.name];
    if (typeof id !== 'string') continue;
    const node = await tx.node.findFirst({ where: { id, deletedAt: null }, select: { loc: true, memoryId: true } });
    if (!node || !(await isMemoryReadableCached(ctx, node.memoryId))) return null;
    const memory = await tx.memory.findUnique({ where: { id: node.memoryId }, select: { urn: true } });
    if (!memory) return null;
    refs[id] = { urn: safeNodeUrnV2(memory.urn, node.loc) };
  }
  try {
    return renderGrantSummary({ action, app: { urn: appUrn }, values, refs });
  } catch (e) {
    if (e instanceof GrantSummaryError) return null;
    throw e;
  }
}

/**
 * The proof step. Verifies the assertion over the request-bound proof challenge OUTSIDE any transaction, then in one
 * transaction: anchors the prover (exclusive, as node signing's proof), spends the proof ceremony, and refuses unless the
 * prover may ISSUE the grant. Only then are the terms built and, when the prover can read every node they name, the one
 * signing ceremony minted. A refusal throws `CeremonyRefused` and rolls back, so it spends nothing and moves no counter.
 */
export async function proveForGrantSigning(db: PrismaClient, a: {
  requestId: string; ceremonyId: string; browserNonceHash: string;
  credentialId: Buffer; assertion: AssertionParts; rpId: string; origins: string[];
}): Promise<GrantProofResult> {
  const cred = await loadCredential(db, a.credentialId);
  if (!cred || cred.revoked_at !== null || cred.enrollment_rp_id !== a.rpId) throw new CeremonyRefused();
  let verified;
  try {
    verified = await verifyCeremonyAssertion({
      assertion: a.assertion,
      credential: { passkeyId: cred.id, ownerId: cred.owner_id, credentialId: cred.credential_id, publicKey: cred.public_key, counter: cred.counter },
      expectedChallenge: grantProofChallenge(a.requestId, a.ceremonyId), rpId: a.rpId, origins: a.origins,
    });
  } catch { throw new CeremonyRefused(); }

  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: cred.owner_id }], 'exclusive');
    const ctx = await personContext(tx, cred.owner_id);
    if (!ctx) throw new CeremonyRefused();
    const decided = await decideCeremonyAssertion(tx, { ceremonyId: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'GRANT_SIGN_PROOF', verified: verified.snapshot });
    if (!decided || decided.ownerId !== cred.owner_id) throw new CeremonyRefused();

    const row = await tx.grantSigningRequest.findUnique({ where: { id: a.requestId } });
    if (!row) throw new CeremonyRefused();
    const grantApp = await tx.grant.findUnique({ where: { id: row.grantId }, select: { appId: true, action: true } });
    if (!grantApp) throw new CeremonyRefused();
    // The issuer gate before anything about the grant: someone who may not issue it learns nothing, not even that it exists.
    if (!(await mayIssue(ctx, grantApp.action, grantApp.appId))) throw new CeremonyRefused();

    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    const state = effectiveRequestState(row, now);
    if (state !== 'open') return { outcome: 'ended' as const, state: state.toUpperCase() };
    const g = await readGrant(tx, row.grantId, grantApp.appId);
    if (!g) throw new CeremonyRefused();
    const ended = grantEnded(g, row, now);
    if (ended) return { outcome: 'ended' as const, state: ended };

    const app = await tx.app.findUnique({ where: { id: g.app_id }, select: { urn: true } });
    if (!app) throw new CeremonyRefused();
    const appUrn = emitEntityUrnV2('app', app.urn);
    const holder = holderOf(g);
    const summary = await summaryFor(ctx, tx, g, appUrn);
    const view: GrantCeremonyView = {
      summary,
      requesterReason: g.reason,
      requester: await requesterOf(tx, row),
      holder: { kind: holder.kind, name: await holderName(tx, holder) },
      app: { urn: appUrn },
      startsAt: g.starts_at?.toISOString() ?? null,
      expiresAt: g.expires_at?.toISOString() ?? null,
      maxUses: g.max_uses,
      requestExpiresAt: row.expiresAt.toISOString(),
    };
    if (summary === null) return { outcome: 'open' as const, view, canSign: false };

    // As node signing: the signing ceremony is bound to a FRESH server-chosen browser nonce (no fixation), and a newer proof
    // in this browser retires this person's earlier GRANT_SIGN ceremony. Only GRANT_SIGN rows of THIS prover: a node proof
    // never touches a grant ceremony, and a grant proof never touches a node one or another person's.
    const sessionNonce = randomBytes(32).toString('base64url');
    await tx.$executeRaw`UPDATE passkey_ceremonies SET consumed_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE purpose = 'GRANT_SIGN' AND user_id = ${cred.owner_id}
        AND browser_nonce_hash IN (${a.browserNonceHash}, ${sha256Hex(sessionNonce)}) AND consumed_at IS NULL`;
    let challenge: Buffer;
    try { challenge = grantSigningChallenge(row); } catch { return { outcome: 'ended' as const, state: 'STALE' }; }
    await tx.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at, user_id, kind)
      VALUES (${randomBytes(32).toString('base64url')}, 'GRANT_SIGN', ${sha256Hex(sessionNonce)}, ${sha256Hex(challenge)},
              (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${GRANT_SIGN_TTL_SECONDS}), ${cred.owner_id}, 'sign')`;
    return { outcome: 'open' as const, view, canSign: true, sessionNonce };
  });
}

/**
 * `/challenge`: the signing challenge of the ONE live GRANT_SIGN ceremony this browser's proof minted for THIS request, read
 * back and never minted again. Anything else is the one refusal.
 */
export async function currentGrantSigningChallenge(db: PrismaClient, a: { requestId: string; browserNonceHash: string; rpId: string }): Promise<{
  ceremonyId: string; challenge: string; rpId: string; allowCredentials: string[];
}> {
  const row = await db.grantSigningRequest.findUnique({ where: { id: a.requestId } });
  if (!row) throw new CeremonyRefused();
  let challenge: Buffer;
  try { challenge = grantSigningChallenge(row); } catch { throw new CeremonyRefused(); }
  const [cer] = await db.$queryRaw<Array<{ id: string; user_id: string | null }>>`
    SELECT id, user_id FROM passkey_ceremonies
     WHERE purpose = 'GRANT_SIGN' AND browser_nonce_hash = ${a.browserNonceHash} AND challenge_hash = ${sha256Hex(challenge)}
       AND consumed_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
     ORDER BY created_at DESC LIMIT 1`;
  if (!cer?.user_id) throw new CeremonyRefused();
  const creds = await db.$queryRaw<Array<{ credential_id: Buffer }>>`SELECT credential_id FROM passkey_credentials
    WHERE owner_id = ${cer.user_id} AND revoked_at IS NULL AND enrollment_rp_id = ${a.rpId}`;
  return { ceremonyId: cer.id, challenge: challenge.toString('base64url'), rpId: a.rpId, allowCredentials: creds.map((c) => Buffer.from(c.credential_id).toString('base64url')) };
}

interface Located { request: RequestPins & { state: string; expiresAt: Date }; appId: string; action: string; anchors: AuthorityAnchor[]; app: { organizationId: string | null; ownerUserId: string | null }; signerId: string }

/** The unlocked pre-read that NAMES the anchors and rows to lock. It authorizes nothing: everything is read again under the locks. */
async function locate(db: PrismaClient, a: { requestId: string; ceremonyId: string }): Promise<Located> {
  const request = await db.grantSigningRequest.findUnique({ where: { id: a.requestId } });
  if (!request) throw new CeremonyRefused();
  const grant = await db.grant.findUnique({ where: { id: request.grantId }, select: { appId: true, action: true } });
  if (!grant) throw new CeremonyRefused();
  const app = await db.app.findUnique({ where: { id: grant.appId }, select: { organizationId: true, ownerUserId: true } });
  if (!app) throw new CeremonyRefused();
  const [peek] = await db.$queryRaw<Array<{ user_id: string | null }>>`
    SELECT user_id FROM passkey_ceremonies WHERE id = ${a.ceremonyId} AND purpose = 'GRANT_SIGN'`;
  if (!peek?.user_id) throw new CeremonyRefused();
  const anchors: AuthorityAnchor[] = [
    { kind: 'app', id: grant.appId },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ];
  return { request, appId: grant.appId, action: grant.action, anchors, app, signerId: peek.user_id };
}

/**
 * Lock, then judge on one clock read. Returns what the writes need; throws `CeremonyRefused` for anything about the
 * ceremony, and a typed `GrantSigningRefusal` for what the completion itself refuses.
 */
async function lockAndJudge(tx: Prisma.TransactionClient, txCtx: Context, loc: Located, a: {
  requestId: string; ceremonyId: string; browserNonceHash: string; credentialId: Buffer;
}) {
  // The App's owner and org must still be the ones whose anchors we hold.
  const [app] = await tx.$queryRaw<Array<{ organization_id: string | null; owner_user_id: string | null }>>`
    SELECT organization_id, owner_user_id FROM apps WHERE id = ${loc.appId}`;
  if (!app || app.organization_id !== loc.app.organizationId || app.owner_user_id !== loc.app.ownerUserId) throw new CeremonyRefused();
  const [cer] = await tx.$queryRaw<Array<{ user_id: string | null; challenge_hash: string | null; browser_nonce_hash: string; consumed_at: Date | null; expires_at: Date }>>`
    SELECT user_id, challenge_hash, browser_nonce_hash, consumed_at, expires_at FROM passkey_ceremonies
     WHERE id = ${a.ceremonyId} AND purpose = 'GRANT_SIGN' AND user_id = ${loc.signerId} FOR UPDATE`;
  if (!cer) throw new CeremonyRefused();
  // The signer's membership, held so a demotion that commits first is seen and one that comes later waits for this commit.
  if (loc.app.organizationId) {
    await tx.$queryRaw`SELECT 1 FROM org_members WHERE organization_id = ${loc.app.organizationId} AND user_id = ${loc.signerId} FOR SHARE`;
  }
  // Through the module export: the reverse-order race pins pause a real completion right after this lock.
  if (!(await grantLocks.lockGrantForSigning(tx, loc.request.grantId, loc.appId))) throw new CeremonyRefused();
  const g = await readGrant(tx, loc.request.grantId, loc.appId);
  if (!g) throw new CeremonyRefused();
  const [request] = await tx.$queryRaw<Array<{ id: string; grant_id: string; version: number; terms_hash: string; payload_version: string; state: string; expires_at: Date }>>`
    SELECT id, grant_id, version, terms_hash, payload_version, state, expires_at FROM grant_signing_requests WHERE id = ${a.requestId} FOR UPDATE`;
  if (!request || request.grant_id !== g.id) throw new CeremonyRefused();
  const pins: RequestPins = { id: request.id, grantId: request.grant_id, version: request.version, termsHash: request.terms_hash, payloadVersion: request.payload_version };
  const [credential] = await tx.$queryRaw<Array<CredentialRow & { window_ends_at: Date | null; window_outcome: string | null }>>`
    SELECT id, owner_id, credential_id, public_key, counter, revoked_at, enrollment_rp_id, window_ends_at, window_outcome
      FROM passkey_credentials WHERE credential_id = ${a.credentialId} AND owner_id = ${loc.signerId} FOR UPDATE`;
  // ONE clock read, after the last lock: every deadline below is judged on it.
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;

  // The ceremony: this browser's, unspent, unexpired, bound to THIS request by its challenge.
  let challenge: Buffer;
  try { challenge = grantSigningChallenge(pins); } catch { throw new CeremonyRefused(); }
  if (cer.consumed_at || cer.expires_at.getTime() <= now.getTime() || cer.browser_nonce_hash !== a.browserNonceHash
      || cer.challenge_hash !== sha256Hex(challenge)) {
    throw new CeremonyRefused();
  }
  // The request, then the grant.
  const state = effectiveRequestState({ state: request.state, expiresAt: request.expires_at }, now);
  if (state !== 'open') throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.', { state: state.toUpperCase() });
  const ended = grantEnded(g, pins, now);
  if (ended) throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This grant can no longer be signed.', { state: ended });
  // The signer must still be able to ISSUE the grant (cor:acl:140:04), judged under the locks on the transaction's context.
  if (!(await mayIssue(txCtx, g.action, g.app_id))) throw new GrantSigningRefusal('SIGNER_NOT_ELIGIBLE', 'You can no longer issue this grant.');
  // The credential: the signer's own, unrevoked, enrolled under this RP ID.
  const rpId = passkeyRpId();
  if (!credential || credential.revoked_at !== null || credential.enrollment_rp_id !== rpId) {
    throw new GrantSigningRefusal('SIGNATURE_NOT_VERIFIED', 'The signature did not verify.');
  }
  // Ruling 0257: a first passkey still in its cooling-off window cannot sign a grant. Refused, nothing recorded; the window is
  // judged on the clock read after the locks. (No other activator: the person signs again once the window ends.)
  if (credential.window_outcome === null && credential.window_ends_at !== null && credential.window_ends_at.getTime() > now.getTime()) {
    throw new GrantSigningRefusal('PASSKEY_COOLING_OFF', 'This passkey is still in its cooling-off period.');
  }
  return { g, pins, credential, rpId };
}

/**
 * Complete: ONE transaction judges everything under its locks, then spends the ceremony, verifies the assertion, records the
 * signature, completes the request, activates the grant (the signer becomes its issuer) and writes one ACTIVATE event. A
 * ceremony problem is `CeremonyRefused`; what the completion itself refuses is a typed `GrantSigningRefusal`.
 */
export async function completeGrantSigning(db: PrismaClient, a: {
  requestId: string; ceremonyId: string; browserNonceHash: string; credentialId: Buffer; assertion: AssertionParts;
}): Promise<void> {
  const loc = await locate(db, a);
  const ctx = { db, userId: loc.signerId, roles: [] } as unknown as Context;
  await withAuthorizedTx(ctx, loc.anchors, async () => undefined, async (tx, txCtx) => {
    const { g, pins, credential, rpId } = await lockAndJudge(tx, txCtx, loc, a);
    if (!(await consumeCeremony(tx, { id: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'GRANT_SIGN' }))) throw new CeremonyRefused();
    let newCounter: number;
    try {
      ({ newCounter } = await verifySigningAssertion({
        assertion: a.assertion,
        credential: { credentialId: credential.credential_id, publicKey: credential.public_key, counter: credential.counter },
        payload: grantSignaturePayloadBytes(pins.payloadVersion, { grantId: pins.grantId, recordVersion: pins.version, termsHash: pins.termsHash, requestId: pins.id }),
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
    const holder = holderOf(g);
    const signature = await tx.grantSignature.create({
      data: {
        grantId: g.id, signingRequestId: pins.id, signerId: loc.signerId, passkeyCredentialId: credential.id,
        version: pins.version, termsHash: pins.termsHash, holderKind: holder.kind, holderId: holder.id,
        payloadVersion: pins.payloadVersion, rpId,
        authenticatorData: new Uint8Array(a.assertion.authenticatorData),
        clientDataJson: new Uint8Array(a.assertion.clientDataJson),
        signature: new Uint8Array(a.assertion.signature),
      },
      select: { id: true },
    });
    // The request completes BEFORE the grant activates: the activation's stale trigger then ends only the OTHER open requests.
    await tx.$executeRaw`UPDATE grant_signing_requests SET state = 'completed' WHERE id = ${pins.id} AND state = 'open'`;
    // The guard stamps activated_at with the database clock and makes the signer the issuer (cor:acl:140:04).
    await tx.$executeRaw`UPDATE grants
       SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC'), verification_kind = 'passkey', verified_by = ${loc.signerId},
           signature_id = ${signature.id}, updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
     WHERE id = ${g.id}`;
    await tx.grantEvent.create({ data: { grantId: g.id, appId: g.app_id, action: 'ACTIVATE', actorUserId: loc.signerId } });
  }, { lockMode: 'shared' });
}

/** Decline: the proven issuer's own signing ceremony turns the request down. The grant stays pending. */
export async function declineGrantSigning(db: PrismaClient, a: { requestId: string; ceremonyId: string; browserNonceHash: string }): Promise<void> {
  const loc = await locate(db, a);
  const ctx = { db, userId: loc.signerId, roles: [] } as unknown as Context;
  await withAuthorizedTx(ctx, loc.anchors, async () => undefined, async (tx, txCtx) => {
    const [app] = await tx.$queryRaw<Array<{ organization_id: string | null; owner_user_id: string | null }>>`
      SELECT organization_id, owner_user_id FROM apps WHERE id = ${loc.appId}`;
    if (!app || app.organization_id !== loc.app.organizationId || app.owner_user_id !== loc.app.ownerUserId) throw new CeremonyRefused();
    const [cer] = await tx.$queryRaw<Array<{ challenge_hash: string | null }>>`
      SELECT challenge_hash FROM passkey_ceremonies WHERE id = ${a.ceremonyId} AND purpose = 'GRANT_SIGN' AND user_id = ${loc.signerId} FOR UPDATE`;
    if (!cer) throw new CeremonyRefused();
    if (!(await grantLocks.lockGrantForSigning(tx, loc.request.grantId, loc.appId))) throw new CeremonyRefused();
    const [request] = await tx.$queryRaw<Array<{ id: string; grant_id: string; version: number; terms_hash: string; payload_version: string; state: string; expires_at: Date }>>`
      SELECT id, grant_id, version, terms_hash, payload_version, state, expires_at FROM grant_signing_requests WHERE id = ${a.requestId} FOR UPDATE`;
    if (!request) throw new CeremonyRefused();
    let challenge: Buffer;
    try {
      challenge = grantSigningChallenge({ id: request.id, grantId: request.grant_id, version: request.version, termsHash: request.terms_hash, payloadVersion: request.payload_version });
    } catch { throw new CeremonyRefused(); }
    if (cer.challenge_hash !== sha256Hex(challenge)) throw new CeremonyRefused();
    if (!(await consumeCeremony(tx, { id: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'GRANT_SIGN' }))) throw new CeremonyRefused();
    if (!(await mayIssue(txCtx, loc.action, loc.appId))) throw new GrantSigningRefusal('SIGNER_NOT_ELIGIBLE', 'You can no longer issue this grant.');
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
    const state = effectiveRequestState({ state: request.state, expiresAt: request.expires_at }, now);
    if (state !== 'open') throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.', { state: state.toUpperCase() });
    const n = await tx.$executeRaw`UPDATE grant_signing_requests SET state = 'declined' WHERE id = ${request.id} AND state = 'open'`;
    if (n !== 1) throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.');
  }, { lockMode: 'shared' });
}
