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
 * leaving the organization that owns the App (`endHeldGrants(tx, 'user', id, 'ORG_LEFT' | 'ORG_REMOVED', { organizationId })`), and #4172, an agent left
 * with no effective installation in an App ({@link endAgentGrantsAtApps}). Rejoining or reinstalling revives nothing: the stamp
 * is never cleared (the database guard refuses it), so a new grant must be issued and signed.
 *
 * The stamp `holder_departed_at` is a FACT, like `revoked_at`; the ended grant reads HOLDER_GONE (state.ts, #4173). It is
 * set once and only on a grant not already ended (the first end stands), and `isGrantLive` / `grantLiveSql` read it.
 * LOCK ORDER: the grant row lock is the LAST lock a departing transaction takes. Each caller runs this after its own locks
 * (the holder row among them), and anything that locks a grant row and then a holder row can deadlock against it.
 */
import { Prisma } from '../../generated/prisma/index.js';
import { GRANT_DB_NOW } from './live.js';

export type GrantHolderKind = 'user' | 'agent' | 'worker' | 'app';

/**
 * #4180 (Holger R5, cor:acl:140:03; Victor's FIT): WHY a holder went, as a cause with no wording (the words are Holger's, open in
 * :03, so a later ruling on them changes display copy, not these codes). Recorded at least as finely as any wording might need:
 * leaving the organization apart from being removed from it, a worker retired apart from deleted, an agent deleted apart from each
 * way it can lose its installation. Separate from the secret read clients' end reasons (SECRET_DELETED, PROTECTED), which are not
 * holder departures. The database admits each code only for its holder kind and only when it agrees with what happened to the
 * holder (prisma/grant-invariants.sql), and the hard-delete triggers record USER_ERASED / WORKER_DELETED / AGENT_DELETED /
 * APP_DELETED themselves. A grant stamped before causes were kept has none, and reads {@link REASON_NOT_RECORDED}.
 */
export const DEPARTURE_REASONS = {
  user: ['USER_ERASED', 'ORG_LEFT', 'ORG_REMOVED'],
  worker: ['WORKER_RETIRED', 'WORKER_DELETED'],
  agent: ['AGENT_DELETED', 'AGENT_UNINSTALLED', 'AGENT_IMPORTER_UNINSTALLED', 'AGENT_IMPORTER_DELETED', 'AGENT_IMPORT_REMOVED', 'AGENT_LICENSE_REVOKED',
    'AGENT_LICENSE_EXPIRED', 'ORG_DELETED'],
  app: ['APP_DELETED'],
} as const;
export type DepartureReason<K extends GrantHolderKind = GrantHolderKind> = (typeof DEPARTURE_REASONS)[K][number];
export type AgentDepartureReason = DepartureReason<'agent'>;
/**
 * #4180 (Antonio BLIND P2, N1): the cause a door records yields to what already happened to the holder (an agent already deleted
 * records AGENT_DELETED, a person already erased USER_ERASED), through the SQL function the guard itself uses to judge a cause
 * (hadron_fit_departure_cause over hadron_departure_cause_fits, prisma/grant-invariants.sql). One statement of the evidence, so a door
 * and the guard cannot drift, and a door never rolls back on a cause the guard would refuse.
 */
const fittedCause = (reason: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`hadron_fit_departure_cause(${reason}, grants.user_id, grants.worker_id, grants.agent_id)`;

/** The read-side value for a departed grant with no recorded cause (stamped before #4180): a fact, never a guessed cause. */
export const REASON_NOT_RECORDED = 'REASON_NOT_RECORDED';

/** The sealed holder column each kind lives in (an identifier from this closed map, never from input). */
const HOLDER_COLUMN: Record<GrantHolderKind, string> = { user: 'user_id', agent: 'agent_id', worker: 'worker_id', app: 'grantee_app_id' };

/**
 * The first end stands (ruling 0259): an ACTIVATED grant past its own expiry or at its own count, or past its action's limits
 * (#4163, cor:acl:140:03: a used or timed-out boot-prompt grant), has already ended and is never stamped departed. Read with the
 * database clock, after the row locks. ONE fragment for every departure door, so the doors cannot drift.
 *
 * Embedded as BARE `grants` columns (`activated_at`, `expires_at`, `max_uses`, `use_count`) and `grants.action`: it is valid only in a
 * statement whose FROM is the unaliased `grants` table and where no other relation in scope has those column names (an `EXISTS`
 * subquery over another table is fine). Adding a join to such a statement needs the fragment qualified first (#4178 BLIND).
 */
export const ALREADY_ENDED = Prisma.sql`(activated_at IS NOT NULL AND ((expires_at IS NOT NULL AND expires_at <= ${GRANT_DB_NOW})
        OR (max_uses IS NOT NULL AND use_count >= max_uses)
        OR EXISTS (SELECT 1 FROM actions x WHERE x.name = grants.action
          AND ((x.max_uses IS NOT NULL AND grants.use_count >= x.max_uses)
            OR (x.lifetime_seconds IS NOT NULL AND grants.activated_at + make_interval(secs => x.lifetime_seconds) <= ${GRANT_DB_NOW})))))`;

/**
 * End every grant `holderId` holds that has not already ended, in the caller's transaction, recording `reason` (#4180). Returns how many it ended.
 * A grant already revoked, departed, EXPIRED or SPENT (an activated grant past its expiry or at its count) keeps its first end; a grant whose own App is gone is skipped (its row is
 * deleted with the App). Never throws for "no grants".
 */
export async function endHeldGrants<K extends GrantHolderKind>(
  tx: Prisma.TransactionClient,
  kind: K,
  holderId: string,
  reason: DepartureReason<K>,
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
    UPDATE grants SET holder_departed_at = ${GRANT_DB_NOW}, updated_at = ${GRANT_DB_NOW},
      holder_departure_reason = ${fittedCause(Prisma.sql`${reason}::text`)}
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
  pairs: ReadonlyArray<{ appId: string; agentId: string; reason: AgentDepartureReason }>,
): Promise<number> {
  if (pairs.length === 0) return 0;
  const appIds = pairs.map((p) => p.appId);
  const agentIds = pairs.map((p) => p.agentId);
  // #4180: each pair's own cause (one door can end two agents for different reasons: the agent it uninstalled, and the agent that
  // agent imported, which lost its derived installation). A pair named twice keeps its first cause.
  const reasons = pairs.map((p) => p.reason);
  const inPairs = Prisma.sql`(grants.app_id, grants.agent_id) IN (SELECT * FROM unnest(${appIds}::text[], ${agentIds}::text[]))`;
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM grants WHERE ${inPairs} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
    ORDER BY id FOR UPDATE`);
  return tx.$executeRaw(Prisma.sql`
    UPDATE grants SET holder_departed_at = ${GRANT_DB_NOW}, updated_at = ${GRANT_DB_NOW},
      holder_departure_reason = ${fittedCause(Prisma.sql`(SELECT p.reason FROM unnest(${appIds}::text[], ${agentIds}::text[], ${reasons}::text[])
          WITH ORDINALITY AS p(app_id, agent_id, reason, n)
        WHERE p.app_id = grants.app_id AND p.agent_id = grants.agent_id ORDER BY p.n LIMIT 1)`)}
    WHERE ${inPairs} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
      AND NOT ${ALREADY_ENDED}`);
}
