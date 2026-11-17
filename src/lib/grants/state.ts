/**
 * #4173 (cor:acl:140:03 seven states, :01 derived not stored, :05): the ONE derivation of a grant's lifecycle state, in two
 * spellings pinned against each other (state4173.test.ts): {@link deriveGrantState} judges a row in memory, {@link grantStateSql} is
 * the matching fragment. Both judge time on the DATABASE clock (the caller passes `now`; the SQL default is `clock_timestamp()`).
 *
 * The state is worked out from the record and never stored. "An ended grant keeps its first end" (ruling 0259), so:
 *   1. SPENT   - activated and the count reached its cap: the grant's own `max_uses`, or its ACTION's limit (#4163, the same cap
 *                `grantLiveSql` applies). A use needs a live grant, so the count was reached before any later end.
 *   2. EXPIRED - the end came first: no stamp yet and the end `<= now`, or the end `<= ` the stamp (equality counts as first, as the
 *                activation trigger's `<=`). The end is the grant's `expires_at` or, once activated, its ACTION's lifetime from
 *                activation (#4163); the earlier of the two. Pending and active alike (Holger, a pending grant past its expiry shows expired).
 *   3. HOLDER_GONE (holder_departed_at), then WITHDRAWN (revoked with `withdrawn_at`) or REVOKED. A row never carries two stamps
 *      (the writers and the guard refuse it); departed is tested first and no tie rule is invented for raw rows.
 *   4. PENDING (never activated) or ACTIVE. A signed grant before its start is ACTIVE and allows nothing (Holger, "A").
 * `allows` is still produced by {@link grantLiveSql}, unchanged: it is `state = ACTIVE` and started and the App not deleted.
 * A grant ended by a deleted secret, protection turned on or a deleted App gets no name here (unruled / concealed).
 */
import { Prisma } from '../../generated/prisma/index.js';
import { GRANT_DB_NOW, type GrantLiveFields } from './live.js';

export type GrantState = 'PENDING' | 'ACTIVE' | 'SPENT' | 'EXPIRED' | 'REVOKED' | 'WITHDRAWN' | 'HOLDER_GONE';

export interface GrantStateFields extends GrantLiveFields {
  /** The withdrawal marker: equal to `revokedAt`, on a never-activated row. Old-style withdrawals have none and read REVOKED. */
  withdrawnAt: Date | null;
}

export function deriveGrantState(row: GrantStateFields, now: Date): GrantState {
  if (row.activatedAt !== null
    && ((row.maxUses !== null && row.useCount >= row.maxUses) || (row.actionMaxUses !== null && row.useCount >= row.actionMaxUses))) return 'SPENT';
  const stamp = row.holderDepartedAt ?? row.revokedAt;
  const actionEnd = row.activatedAt !== null && row.actionLifetimeSeconds !== null ? row.activatedAt.getTime() + row.actionLifetimeSeconds * 1000 : null;
  const end = row.expiresAt !== null && actionEnd !== null ? Math.min(row.expiresAt.getTime(), actionEnd) : (row.expiresAt?.getTime() ?? actionEnd);
  if (end !== null && end <= (stamp ?? now).getTime()) return 'EXPIRED';
  if (row.holderDepartedAt !== null) return 'HOLDER_GONE';
  if (row.revokedAt !== null) return row.withdrawnAt !== null ? 'WITHDRAWN' : 'REVOKED';
  return row.activatedAt === null ? 'PENDING' : 'ACTIVE';
}

/** The same verdict as a SQL text expression over the grants table aliased `alias` (a literal, never input). */
export function grantStateSql(alias = 'grants', now: Prisma.Sql = GRANT_DB_NOW): Prisma.Sql {
  const a = Prisma.raw(`"${alias.replace(/"/g, '')}"`);
  return Prisma.sql`(CASE
    WHEN ${a}.activated_at IS NOT NULL AND ((${a}.max_uses IS NOT NULL AND ${a}.use_count >= ${a}.max_uses)
      OR EXISTS (SELECT 1 FROM actions st_action WHERE st_action.name = ${a}.action AND st_action.max_uses IS NOT NULL AND ${a}.use_count >= st_action.max_uses)) THEN 'SPENT'
    WHEN (${a}.expires_at IS NOT NULL AND ${a}.expires_at <= COALESCE(${a}.holder_departed_at, ${a}.revoked_at, ${now}))
      OR (${a}.activated_at IS NOT NULL AND EXISTS (SELECT 1 FROM actions st_action WHERE st_action.name = ${a}.action AND st_action.lifetime_seconds IS NOT NULL
        AND ${a}.activated_at + make_interval(secs => st_action.lifetime_seconds) <= COALESCE(${a}.holder_departed_at, ${a}.revoked_at, ${now}))) THEN 'EXPIRED'
    WHEN ${a}.holder_departed_at IS NOT NULL THEN 'HOLDER_GONE'
    WHEN ${a}.revoked_at IS NOT NULL THEN CASE WHEN ${a}.withdrawn_at IS NOT NULL THEN 'WITHDRAWN' ELSE 'REVOKED' END
    WHEN ${a}.activated_at IS NULL THEN 'PENDING'
    ELSE 'ACTIVE' END)`;
}
