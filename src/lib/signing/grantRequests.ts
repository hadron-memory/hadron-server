/**
 * #3649 slice B (cor:acl:140:07; the node-signing mirror cor:dmo:130:03): grant signing requests, create and withdraw. ONE
 * grant per request (gate selection 1); no signer is named (ruling 0255, item 12): whoever signs must be able to issue the
 * grant (cor:acl:140:04), and that is judged at completion (slice C). The database guard (prisma/grant-signing-invariants.sql)
 * is the last word on the pending-grant precondition, the pins, the single end and DB-clock times; this module adds the typed
 * refusals and the terms hash a trigger cannot compute. Authorization is the caller's (the grant read gate).
 *
 * LOCK ORDER: the grant row `FOR UPDATE` (judged after the lock, on the DB clock), then the request row. Every writer that
 * ends a request takes the grant row first: a revocation or a holder's departure updates the grant, and its stale trigger then
 * ends the request; withdrawal and (slice C) completion lock the grant, then the request.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { GrantTermsError, grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { CURRENT_GRANT_SIGNATURE_PAYLOAD_VERSION } from './grantPayload.js';
import { signingRequestTtlSeconds } from './config.js';
import { newSigningRequestId, requesterAccount, type SigningRequester, type SigningRequestState } from './requests.js';

/** Why a grant signing call was refused. The resolver maps `code` to `extensions.code`. */
export class GrantSigningRefusal extends Error {
  constructor(
    readonly code:
      | 'GRANT_NOT_FOUND'
      | 'GRANT_NOT_PENDING'
      | 'GRANT_EXPIRED'
      | 'GRANT_TERMS_UNREPRESENTABLE'
      | 'SIGNING_REQUEST_NOT_FOUND'
      | 'SIGNING_REQUEST_NOT_REQUESTER'
      | 'SIGNING_REQUEST_ENDED',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface LockedGrant {
  id: string; app_id: string; user_id: string | null; agent_id: string | null; worker_id: string | null; grantee_app_id: string | null;
  action: string; action_values: unknown; starts_at: Date | null; expires_at: Date | null; max_uses: number | null; reason: string;
  version: number; activated_at: Date | null; revoked_at: Date | null; holder_departed_at: Date | null; expired: boolean;
}

/**
 * Lock the grant row, then read it in a second statement on the DB clock after the lock (`live.ts`'s lock-then-judge: one
 * statement would judge expiry before it waited). A grant of another App reads as absent.
 */
async function lockGrant(tx: Prisma.TransactionClient, grantId: string, appId: string): Promise<LockedGrant | null> {
  await tx.$queryRaw`SELECT id FROM grants WHERE id = ${grantId} AND app_id = ${appId} FOR UPDATE`;
  const [row] = await tx.$queryRaw<LockedGrant[]>`
    SELECT id, app_id, user_id, agent_id, worker_id, grantee_app_id, action, action_values, starts_at, expires_at, max_uses, reason,
           version, activated_at, revoked_at, holder_departed_at,
           (expires_at IS NOT NULL AND expires_at <= hadron_signing_now()) AS expired
      FROM grants WHERE id = ${grantId} AND app_id = ${appId}`;
  return row ?? null;
}

/**
 * Open a signing request on a pending grant (cor:acl:140:07). The caller has authorized the requester as a READER of the grant
 * in `appId`. Refused, before any write: a grant that is not pending (activated, revoked, or its holder gone: one code, no state
 * label, since cor:acl:140:03 leaves those labels open); a grant past its expiry (it can never be signed, ruling 0255 item 16);
 * terms the signed document cannot hold.
 */
export async function createGrantSigningRequestInTransaction(
  tx: Prisma.TransactionClient,
  grantId: string,
  opts: { appId: string; requester: SigningRequester },
) {
  const g = await lockGrant(tx, grantId, opts.appId);
  if (!g) throw new GrantSigningRefusal('GRANT_NOT_FOUND', 'Grant not found');
  if (g.activated_at || g.revoked_at || g.holder_departed_at) {
    throw new GrantSigningRefusal('GRANT_NOT_PENDING', 'Only a pending grant can be signed.');
  }
  if (g.expired) throw new GrantSigningRefusal('GRANT_EXPIRED', 'This grant is past its expiry, so it can no longer be signed.');
  let termsHash: string;
  try {
    termsHash = grantTermsHash(grantTermsFromRow({
      appId: g.app_id, userId: g.user_id, agentId: g.agent_id, workerId: g.worker_id, granteeAppId: g.grantee_app_id,
      action: g.action, values: g.action_values, startsAt: g.starts_at, expiresAt: g.expires_at, maxUses: g.max_uses, reason: g.reason,
    }));
  } catch (error) {
    if (error instanceof GrantTermsError) {
      throw new GrantSigningRefusal('GRANT_TERMS_UNREPRESENTABLE', 'This grant\'s terms cannot be written in the signed terms document.', { reason: error.reason });
    }
    throw error;
  }
  const id = newSigningRequestId();
  const ttl = signingRequestTtlSeconds();
  await tx.$executeRaw`INSERT INTO grant_signing_requests
    (id, grant_id, version, terms_hash, payload_version,
     requester_user_id, requester_app_id, requester_worker_id, requester_session_id, expires_at)
    VALUES (${id}, ${g.id}, ${g.version}, ${termsHash}, ${CURRENT_GRANT_SIGNATURE_PAYLOAD_VERSION},
      ${opts.requester.userId}, ${opts.requester.userId ? null : opts.requester.appId},
      ${opts.requester.workerId}, ${opts.requester.sessionId},
      hadron_signing_now() + make_interval(secs => ${ttl}))`;
  return tx.grantSigningRequest.findUniqueOrThrow({ where: { id } });
}

/**
 * Lock the request's grant, then the request, and store an expiry that has already happened, so every transition starts from
 * the true state. A request whose grant is outside `appId` is NOT_FOUND, the same as an unknown id.
 */
async function lockRequest(tx: Prisma.TransactionClient, requestId: string, appId: string) {
  const peek = await tx.grantSigningRequest.findUnique({ where: { id: requestId }, select: { grantId: true } });
  if (!peek) throw new GrantSigningRefusal('SIGNING_REQUEST_NOT_FOUND', 'Signing request not found');
  const [grant] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM grants WHERE id = ${peek.grantId} AND app_id = ${appId} FOR UPDATE`;
  if (!grant) throw new GrantSigningRefusal('SIGNING_REQUEST_NOT_FOUND', 'Signing request not found');
  await tx.$queryRaw`SELECT id FROM grant_signing_requests WHERE id = ${requestId} FOR UPDATE`;
  await tx.$executeRaw`UPDATE grant_signing_requests SET state = 'expired'
    WHERE id = ${requestId} AND state = 'open' AND expires_at <= hadron_signing_now()`;
  return tx.grantSigningRequest.findUniqueOrThrow({ where: { id: requestId } });
}

/**
 * Withdraw (the cor:dmo:130:03 mirror): only the requester ACCOUNT, from any of its sessions or workers. The caller has
 * authorized `caller` as a reader of the request's grant.
 */
export async function withdrawGrantSigningRequestInTransaction(
  tx: Prisma.TransactionClient,
  requestId: string,
  opts: { appId: string; caller: { userId: string | null; appId: string | null } },
) {
  const row = await lockRequest(tx, requestId, opts.appId);
  const mine = requesterAccount(opts.caller);
  const theirs = requesterAccount({ userId: row.requesterUserId, appId: row.requesterAppId });
  if (!mine || mine !== theirs) {
    throw new GrantSigningRefusal('SIGNING_REQUEST_NOT_REQUESTER', 'Only the account that requested this signature may withdraw it.');
  }
  if (row.state !== 'open') {
    throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', `This signing request has ended (${row.state}).`, { state: row.state.toUpperCase() });
  }
  const n = await tx.$executeRaw`UPDATE grant_signing_requests SET state = 'withdrawn' WHERE id = ${requestId} AND state = 'open'`;
  if (n !== 1) throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.');
  return tx.grantSigningRequest.findUniqueOrThrow({ where: { id: requestId } });
}

export type GrantSigningRequestState = SigningRequestState;
