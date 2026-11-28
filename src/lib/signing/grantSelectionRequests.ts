/**
 * #5001 slice 3 (hrn:node:hadronmemory.com:specs:cor:acl:140:07, :09; ruling 0255 item 19): a signing request for a SELECTION of
 * one App's pending grants, one passkey touch. Create and withdraw; the ceremony is `grantSelectionCeremony.ts`.
 *
 * A selection is one row and one ITEM per grant: an ordinary `grant_signing_requests` row with its own version and terms-hash pin
 * (so the per-grant stale trigger and the activation guard stay per grant). Authorization is the caller's: the shared grant read
 * gate, for every ref, before this runs and again under the transaction's locks.
 *
 * Refused whole, naming the FIRST bad ref in ascending id order, before any write (cor:acl:140:07, R4): an empty list, a list above
 * the cap, a repeated ref, a grant that is unknown to this App, not pending, past its expiry, or whose terms the signed document
 * cannot hold. Nothing is opened for the rest, so a refusal confirms nothing about refs the caller could not already read.
 *
 * LOCK ORDER: every grant `FOR UPDATE` in ASCENDING id order, each in its own statement, then ONE clock read, then the selection
 * and its items (grant, then selection: the order the guards take). Withdrawal locks the same grants, then the selection.
 */
import { Prisma } from '../../generated/prisma/index.js';
import { GrantTermsError, grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { signingRequestTtlSeconds } from './config.js';
import { CURRENT_GRANT_SELECTION_PAYLOAD_VERSION, GRANT_SELECTION_CAP } from './grantSelectionPayload.js';
import { GrantSigningRefusal } from './grantRequests.js';
import { newSigningRequestId, requesterAccount, type SigningRequester } from './requests.js';

interface SelectionGrantRow {
  id: string; app_id: string; user_id: string | null; agent_id: string | null; worker_id: string | null; grantee_app_id: string | null;
  action: string; action_values: unknown; starts_at: Date | null; expires_at: Date | null; max_uses: number | null; reason: string;
  version: number; activated_at: Date | null; revoked_at: Date | null; holder_departed_at: Date | null; expired: boolean;
}

/** The refs as one ascending, repeat-free list, or the refusal. Judged before any read (the cap is not a number a read may shape). */
export function normalizeSelectionRefs(refs: readonly string[]): string[] {
  if (refs.length === 0) throw new GrantSigningRefusal('SELECTION_EMPTY', 'A selection names at least one grant.');
  if (refs.length > GRANT_SELECTION_CAP) {
    throw new GrantSigningRefusal('SELECTION_TOO_LARGE', `A selection holds at most ${GRANT_SELECTION_CAP} grants.`, { cap: GRANT_SELECTION_CAP });
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) throw new GrantSigningRefusal('SELECTION_DUPLICATE_GRANT', 'A grant may appear once in a selection.', { grantRef: ref });
    seen.add(ref);
  }
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `FOR UPDATE` each grant of `appId`, ascending, one statement each (so a race pin can pause between them). */
async function lockGrantsAscending(tx: Prisma.TransactionClient, ids: readonly string[], appId: string): Promise<void> {
  for (const id of ids) await tx.$queryRaw`SELECT id FROM grants WHERE id = ${id} AND app_id = ${appId} FOR UPDATE`;
}

/** Open a selection signing request over `refs` (already authorized as READABLE by the caller). */
export async function createGrantSelectionInTransaction(
  tx: Prisma.TransactionClient,
  refs: readonly string[],
  opts: { appId: string; requester: SigningRequester },
) {
  const ids = normalizeSelectionRefs(refs);
  await lockGrantsAscending(tx, ids, opts.appId);
  // Judged in a second statement, on ONE clock read taken after the last lock.
  const rows = await tx.$queryRaw<SelectionGrantRow[]>`
    SELECT id, app_id, user_id, agent_id, worker_id, grantee_app_id, action, action_values, starts_at, expires_at, max_uses, reason,
           version, activated_at, revoked_at, holder_departed_at,
           (expires_at IS NOT NULL AND expires_at <= hadron_signing_now()) AS expired
      FROM grants WHERE app_id = ${opts.appId} AND id IN (${Prisma.join(ids)})`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pins: Array<{ id: string; version: number; termsHash: string }> = [];
  for (const id of ids) {
    const g = byId.get(id);
    if (!g) throw new GrantSigningRefusal('GRANT_NOT_FOUND', 'Grant not found', { grantRef: id });
    if (g.activated_at || g.revoked_at || g.holder_departed_at) {
      throw new GrantSigningRefusal('GRANT_NOT_PENDING', 'Only a pending grant can be signed.', { grantRef: id });
    }
    if (g.expired) throw new GrantSigningRefusal('GRANT_EXPIRED', 'This grant is past its expiry, so it can no longer be signed.', { grantRef: id });
    try {
      pins.push({
        id, version: g.version,
        termsHash: grantTermsHash(grantTermsFromRow({
          appId: g.app_id, userId: g.user_id, agentId: g.agent_id, workerId: g.worker_id, granteeAppId: g.grantee_app_id,
          action: g.action, values: g.action_values, startsAt: g.starts_at, expiresAt: g.expires_at, maxUses: g.max_uses, reason: g.reason,
        })),
      });
    } catch (error) {
      if (error instanceof GrantTermsError) {
        throw new GrantSigningRefusal('GRANT_TERMS_UNREPRESENTABLE', 'This grant\'s terms cannot be written in the signed terms document.', { grantRef: id, reason: error.reason });
      }
      throw error;
    }
  }
  const selectionId = newSigningRequestId();
  const ttl = signingRequestTtlSeconds();
  const r = opts.requester;
  await tx.$executeRaw`WITH n AS (SELECT hadron_signing_now() AS t)
    INSERT INTO grant_signing_selections
    (id, app_id, payload_version, requester_user_id, requester_app_id, requester_worker_id, requester_session_id, created_at, expires_at)
    SELECT ${selectionId}, ${opts.appId}, ${CURRENT_GRANT_SELECTION_PAYLOAD_VERSION},
      ${r.userId}, ${r.userId ? null : r.appId}, ${r.workerId}, ${r.sessionId}, n.t, n.t + make_interval(secs => ${ttl}) FROM n`;
  let position = 0;
  for (const p of pins) {
    await tx.$executeRaw`WITH n AS (SELECT hadron_signing_now() AS t)
      INSERT INTO grant_signing_requests
      (id, grant_id, version, terms_hash, payload_version, requester_user_id, requester_app_id, requester_worker_id, requester_session_id,
       created_at, expires_at, selection_id, position_in_selection)
      SELECT ${newSigningRequestId()}, ${p.id}, ${p.version}, ${p.termsHash}, ${CURRENT_GRANT_SELECTION_PAYLOAD_VERSION},
        ${r.userId}, ${r.userId ? null : r.appId}, ${r.workerId}, ${r.sessionId},
        n.t, n.t + make_interval(secs => ${ttl}), ${selectionId}, ${position} FROM n`;
    position += 1;
  }
  return tx.grantSigningSelection.findUniqueOrThrow({ where: { id: selectionId }, include: { items: { orderBy: { positionInSelection: 'asc' } } } });
}

/**
 * Withdraw (the cor:dmo:130:03 mirror): only the requester ACCOUNT. Locks the item grants ascending, then the selection, and stores
 * an expiry that has already happened first, so the end is the true one. The selection's end ends its open items (its trigger).
 */
export async function withdrawGrantSelectionInTransaction(
  tx: Prisma.TransactionClient,
  selectionId: string,
  opts: { appId: string; caller: { userId: string | null; appId: string | null } },
) {
  const peek = await tx.grantSigningSelection.findUnique({ where: { id: selectionId }, select: { appId: true, items: { select: { grantId: true } } } });
  if (!peek || peek.appId !== opts.appId) throw new GrantSigningRefusal('SIGNING_REQUEST_NOT_FOUND', 'Signing request not found');
  await lockGrantsAscending(tx, peek.items.map((i) => i.grantId).sort(), opts.appId);
  await tx.$queryRaw`SELECT id FROM grant_signing_selections WHERE id = ${selectionId} FOR UPDATE`;
  await tx.$executeRaw`UPDATE grant_signing_selections SET state = 'expired'
    WHERE id = ${selectionId} AND state = 'open' AND expires_at <= hadron_signing_now()`;
  const row = await tx.grantSigningSelection.findUniqueOrThrow({ where: { id: selectionId } });
  const mine = requesterAccount(opts.caller);
  const theirs = requesterAccount({ userId: row.requesterUserId, appId: row.requesterAppId });
  if (!mine || mine !== theirs) {
    throw new GrantSigningRefusal('SIGNING_REQUEST_NOT_REQUESTER', 'Only the account that requested this signature may withdraw it.');
  }
  if (row.state !== 'open') {
    throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', `This signing request has ended (${row.state}).`, { state: row.state.toUpperCase() });
  }
  const n = await tx.$executeRaw`UPDATE grant_signing_selections SET state = 'withdrawn' WHERE id = ${selectionId} AND state = 'open'`;
  if (n !== 1) throw new GrantSigningRefusal('SIGNING_REQUEST_ENDED', 'This signing request has ended.');
  return tx.grantSigningSelection.findUniqueOrThrow({ where: { id: selectionId }, include: { items: { orderBy: { positionInSelection: 'asc' } } } });
}
