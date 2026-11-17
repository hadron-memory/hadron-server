/**
 * #3690 (S2a-h): a grant ENDS when its holder goes, and the record stays (cor:acl:140:03 Moves and How It Ends; :01
 * Relationships; ruling 0255 item 3, and 0259 for `retireWorker` and every agent delete, soft delete included).
 *
 * Two halves, one rule. A HARD delete of a holder row (an erasure's cascade, `deleteWorker`, a tombstone reclaim, the owner
 * rename's raw SQL) is ended by the AFTER DELETE triggers in prisma/grant-invariants.sql, so no path can be missed. The SOFT
 * deletes fire no delete, so each door calls {@link endHeldGrants} in its own transaction: a person's erasure, `retireWorker`,
 * `deleteAgent` and `deleteApp`.
 *
 * Two doors end a LIVE holder's grants in a SCOPE without deleting the holder (Holger rulings A, epic #1975): #4171, a person
 * leaving the organization that owns the App (`endHeldGrants(tx, 'user', id, { organizationId })`), and #4172, an agent left
 * with no effective installation in an App ({@link endAgentGrantsAtApps}). Rejoining or reinstalling revives nothing: the stamp
 * is never cleared (the database guard refuses it), so a new grant must be issued and signed.
 *
 * The stamp `holder_departed_at` is a FACT, like `revoked_at`; no state label is chosen for the ended grant (`:03` Open). It is
 * set once and only on a grant not already ended (the first end stands), and `isGrantLive` / `grantLiveSql` read it.
 * LOCK ORDER: the grant row lock is the LAST lock a departing transaction takes. Each caller runs this after its own locks
 * (the holder row among them), and anything that locks a grant row and then a holder row can deadlock against it.
 */
import { Prisma } from '../../generated/prisma/index.js';
import { GRANT_DB_NOW } from './live.js';

export type GrantHolderKind = 'user' | 'agent' | 'worker' | 'app';

/** The sealed holder column each kind lives in (an identifier from this closed map, never from input). */
const HOLDER_COLUMN: Record<GrantHolderKind, string> = { user: 'user_id', agent: 'agent_id', worker: 'worker_id', app: 'grantee_app_id' };

/**
 * The first end stands (ruling 0259): an ACTIVATED grant past its own expiry or at its own count, or past its action's limits
 * (#4163, cor:acl:140:03: a used or timed-out boot-prompt grant), has already ended and is never stamped departed. Read with the
 * database clock, after the row locks. ONE fragment for every departure door, so the doors cannot drift.
 */
const ALREADY_ENDED = Prisma.sql`(activated_at IS NOT NULL AND ((expires_at IS NOT NULL AND expires_at <= ${GRANT_DB_NOW})
        OR (max_uses IS NOT NULL AND use_count >= max_uses)
        OR EXISTS (SELECT 1 FROM actions x WHERE x.name = grants.action
          AND ((x.max_uses IS NOT NULL AND grants.use_count >= x.max_uses)
            OR (x.lifetime_seconds IS NOT NULL AND grants.activated_at + make_interval(secs => x.lifetime_seconds) <= ${GRANT_DB_NOW})))))`;

/**
 * End every grant `holderId` holds that has not already ended, in the caller's transaction. Returns how many it ended.
 * A grant already revoked, departed, EXPIRED or SPENT (an activated grant past its expiry or at its count) keeps its first end; a grant whose own App is gone is skipped (its row is
 * deleted with the App). Never throws for "no grants".
 */
export async function endHeldGrants(
  tx: Prisma.TransactionClient,
  kind: GrantHolderKind,
  holderId: string,
  scope?: { organizationId: string },
): Promise<number> {
  const column = Prisma.raw(`grants."${HOLDER_COLUMN[kind]}"`);
  // #4171: only the grants in Apps OWNED by this organization (a bound parameter; user-owned Apps have no organization, so no
  // org leave reaches them). Absent scope is the historical global call, byte for byte.
  const inScope = scope
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM apps ao WHERE ao.id = grants.app_id AND ao.organization_id = ${scope.organizationId})`
    : Prisma.empty;
  // Lock FIRST, judge SECOND, in two statements (the pattern live.ts documents): one UPDATE judges "has it expired" before it
  // waits for the row lock, so a grant that expired while the departure waited behind another transaction would still be stamped.
  // The second statement reads the database clock after the locks are held. Locked in id order, so two departures cannot deadlock.
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM grants WHERE ${column} = ${holderId} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id) ${inScope}
    ORDER BY id FOR UPDATE`);
  return tx.$executeRaw(Prisma.sql`
    UPDATE grants SET holder_departed_at = ${GRANT_DB_NOW}, updated_at = ${GRANT_DB_NOW}
    WHERE ${column} = ${holderId} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id) ${inScope}
      AND NOT ${ALREADY_ENDED}`);
}

/**
 * #4172: end the grants AGENTS hold in the Apps they no longer have an effective installation in, in ONE lock phase. `pairs` is
 * every (App, agent) the door judged departed under its installation locks; the caller has already taken every anchor and
 * installation lock, so the grant row locks here are the LAST locks of the transaction (the rule in this file's header), taken
 * once, in id order, however many pairs there are. Only AGENT-held grants (never a worker's, a person's or an App's) in exactly
 * those Apps; first end stands; the expiry/spent judgement reads the database clock after the locks. Returns how many it ended.
 */
export async function endAgentGrantsAtApps(
  tx: Prisma.TransactionClient,
  pairs: ReadonlyArray<{ appId: string; agentId: string }>,
): Promise<number> {
  if (pairs.length === 0) return 0;
  const appIds = pairs.map((p) => p.appId);
  const agentIds = pairs.map((p) => p.agentId);
  const inPairs = Prisma.sql`(grants.app_id, grants.agent_id) IN (SELECT * FROM unnest(${appIds}::text[], ${agentIds}::text[]))`;
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM grants WHERE ${inPairs} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
    ORDER BY id FOR UPDATE`);
  return tx.$executeRaw(Prisma.sql`
    UPDATE grants SET holder_departed_at = ${GRANT_DB_NOW}, updated_at = ${GRANT_DB_NOW}
    WHERE ${inPairs} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
      AND NOT ${ALREADY_ENDED}`);
}
