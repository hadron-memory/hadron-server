/**
 * #3711 (Grants S2b; cor:acl:140:05 Revoke, :03 How It Ends, ruling 0259 first end stands, V57 withdrawal): the ONE writer that
 * ends a grant on a person's call, shared by `revokeGrant` and `withdrawGrant`.
 *
 * An end is the grant's one stamp, `revoked_at` together with `revoked_by` (the person), plus ONE `REVOKE` row in
 * `grant_events` naming the person and, for a worker's act, the worker and session. A withdrawal of a pending grant is the same
 * end: no new column, event action or state label (cor:acl:140:03 leaves the name open).
 *
 * LOCK THEN JUDGE. The grant row is locked FOR UPDATE first ({@link readGrantForUpdate}, two statements so the verdict is read on the
 * post-lock database clock), and EVERYTHING the call decides is read from the locked row: who may end it (the caller's judge, which
 * sees the issuer and requester), whether it already ended, and whether it is still pending. A revoker that waited behind
 * a concurrent revoke, departure or activation therefore never reports an end it did not make (findings:grant-holder-departure-sealed-ids,
 * serializable-advisory-wait-keeps-old-snapshot). The grant row lock is the LAST lock the transaction takes (the callers lock the App
 * anchor, the caller's session and manager memberships first), as every departure door does.
 *
 * THE FIRST END STANDS. A grant already revoked, withdrawn or whose holder departed is NOT stamped again and gets no second event: the
 * call returns `changed: false` and the caller reads the row as it is.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { readGrantForUpdate } from './live.js';

export type GrantManageCode = 'GRANT_NOT_MANAGER' | 'GRANT_NOT_FOUND' | 'GRANT_NOT_REQUESTER' | 'GRANT_NOT_PENDING';

const MESSAGES: Record<GrantManageCode, string> = {
  GRANT_NOT_MANAGER: 'Only whoever manages this App, a grant\'s issuer or a held worker on a validated instruction can do that, and the grant must exist.',
  GRANT_NOT_FOUND: 'Grant not found.',
  GRANT_NOT_REQUESTER: 'Only the one who asked for a grant can withdraw it.',
  GRANT_NOT_PENDING: 'A grant that has been activated cannot be withdrawn; revoke it instead.',
};

/** A refusal of a manage call. The text is fixed per code: it never carries an id or a submitted value. */
export class GrantManageRefusal extends Error {
  constructor(readonly code: GrantManageCode) {
    super(MESSAGES[code]);
    this.name = 'GrantManageRefusal';
  }
}

/** The locked grant row, as the caller's judge reads it. */
export interface LockedGrant {
  id: string;
  appId: string;
  issuerUserId: string | null;
  requestedByUserId: string | null;
  requestedByWorkerId: string | null;
  activatedAt: Date | null;
  revokedAt: Date | null;
  holderDepartedAt: Date | null;
}

/** Who ends it: the PERSON (the user-valued revoker, also for a worker's act, which records its driver), and the worker and session when a worker acted. */
export interface GrantEnder { userId: string; workerId: string | null; sessionId: string | null }

export interface EndGrantOptions {
  /** Refuse (throw) unless the ender may end this locked row. Runs before anything is decided about its state. */
  authorize: (row: LockedGrant) => void | Promise<void>;
  /** Withdrawal: an ACTIVATED row is refused GRANT_NOT_PENDING (after the already-ended check, so a first end stands). */
  pendingOnly?: boolean;
  /** Runs after the row lock and every judgement, immediately before the stamp: a decision that depends on time (a session's hard expiry) is re-made here, on the post-lock database clock, and throws to refuse (Dorian P2 on 9cd8772f). */
  beforeStamp?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/**
 * End `id` in the caller's transaction. Returns whether THIS call ended it. Throws {@link GrantManageRefusal} GRANT_NOT_FOUND for no row
 * (or one of a soft-deleted App) and whatever `authorize` throws.
 */
export async function endGrant(tx: Prisma.TransactionClient, id: string, ender: GrantEnder, opts: EndGrantOptions): Promise<{ changed: boolean }> {
  const locked = await readGrantForUpdate(tx, id);
  if (!locked || locked.row.appDeletedAt !== null) throw new GrantManageRefusal('GRANT_NOT_FOUND');
  const [extra] = await tx.$queryRaw<Array<{ issuer_user_id: string | null; requested_by_user_id: string | null; requested_by_worker_id: string | null }>>`
    SELECT issuer_user_id, requested_by_user_id, requested_by_worker_id FROM grants WHERE id = ${id}`;
  if (!extra) throw new GrantManageRefusal('GRANT_NOT_FOUND'); // unreachable under the row lock; explicit rather than asserted
  const row: LockedGrant = {
    id, appId: locked.row.appId, issuerUserId: extra.issuer_user_id, requestedByUserId: extra.requested_by_user_id,
    requestedByWorkerId: extra.requested_by_worker_id, activatedAt: locked.row.activatedAt, revokedAt: locked.row.revokedAt,
    holderDepartedAt: locked.row.holderDepartedAt,
  };
  await opts.authorize(row);
  if (row.revokedAt !== null || row.holderDepartedAt !== null) return { changed: false };
  if (opts.pendingOnly && row.activatedAt !== null) throw new GrantManageRefusal('GRANT_NOT_PENDING');
  await opts.beforeStamp?.(tx);
  const ended = await tx.$executeRaw`
    UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = ${ender.userId}, updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE id = ${id} AND revoked_at IS NULL AND holder_departed_at IS NULL`;
  if (ended !== 1) return { changed: false };
  await tx.grantEvent.create({ data: { grantId: id, appId: row.appId, action: 'REVOKE', actorUserId: ender.userId, workerId: ender.workerId, sessionId: ender.sessionId } });
  return { changed: true };
}
