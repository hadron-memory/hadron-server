/**
 * #3668 (S1a): the ONE definition of whether a grant is live (cor:acl:140:03). Two spellings of one rule, kept together
 * and pinned against each other (live3668.test.ts): {@link isGrantLive} judges a row in memory, {@link grantLiveSql} is the
 * matching fragment for a locked read. Both judge time on the DATABASE clock (`clock_timestamp()`, never `now()`, which is
 * the transaction start, and never a JS clock).
 *
 * Live means ALL of: activated (a pending row allows nothing), not revoked, its holder has not gone (#3690 S2a-h: a grant ends
 * when its holder does, cor:acl:140:03), its App has not been deleted (a soft-deleted scope App allows nothing until the reclaim
 * cascades the row), started (`starts_at <= now`, inclusive), not expired (`expires_at > now`, the end is exclusive) and not
 * spent (`max_uses` is NULL or `use_count < max_uses`), and inside its ACTION's limits (#4163, cor:acl:140:02, :03): the action's
 * own count of uses and its lifetime from activation, which apply to every grant of it. A grant's own `max_uses` and `expires_at`
 * can only narrow them, since each is a further condition.
 * The state is worked out here and never stored. The `cor:acl:140:03` open questions (a grant signed before its start,
 * a pending grant past its expiry) are NOT given a name here: both simply allow nothing.
 */
import { Prisma } from '../../generated/prisma/index.js';

export interface GrantLiveFields {
  activatedAt: Date | null;
  revokedAt: Date | null;
  /** #3690: when the holder went (a fact, not a state label); NULL while the holder is there. */
  holderDepartedAt: Date | null;
  /** #3690: `apps.deleted_at` of the grant's own App; NULL while the App is not soft-deleted. */
  appDeletedAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  /** #4163: the action's limit on uses (NULL: none), applying to every grant of it. */
  actionMaxUses: number | null;
  /** #4163: the action's limit on lifetime from activation, in seconds (NULL: none). */
  actionLifetimeSeconds: number | null;
}

/** The database clock as a naive UTC timestamp, the shape of every timestamp(3) column. */
export const GRANT_DB_NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

/** In-memory verdict at `now` (a naive-UTC Date, the same convention as the columns). */
export function isGrantLive(row: GrantLiveFields, now: Date): boolean {
  if (row.activatedAt === null) return false;
  if (row.revokedAt !== null) return false;
  if (row.holderDepartedAt !== null) return false;
  if (row.appDeletedAt !== null) return false;
  if (row.startsAt !== null && row.startsAt.getTime() > now.getTime()) return false;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return false;
  if (row.maxUses !== null && row.useCount >= row.maxUses) return false;
  if (row.actionMaxUses !== null && row.useCount >= row.actionMaxUses) return false;
  if (row.actionLifetimeSeconds !== null && row.activatedAt.getTime() + row.actionLifetimeSeconds * 1000 <= now.getTime()) return false;
  return true;
}

/**
 * The same verdict as a SQL boolean over the grants table aliased `alias`. `now` defaults to the database clock; a test
 * passes a fixed instant to judge the boundaries exactly. `alias` is interpolated as an identifier: pass a literal, never input.
 */
export function grantLiveSql(alias = 'grants', now: Prisma.Sql = GRANT_DB_NOW): Prisma.Sql {
  const a = Prisma.raw(`"${alias.replace(/"/g, '')}"`);
  return Prisma.sql`(${a}.activated_at IS NOT NULL
    AND ${a}.revoked_at IS NULL
    AND ${a}.holder_departed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM apps live_app WHERE live_app.id = ${a}.app_id AND live_app.deleted_at IS NOT NULL)
    AND (${a}.starts_at IS NULL OR ${a}.starts_at <= ${now})
    AND (${a}.expires_at IS NULL OR ${a}.expires_at > ${now})
    AND (${a}.max_uses IS NULL OR ${a}.use_count < ${a}.max_uses)
    AND NOT EXISTS (SELECT 1 FROM actions live_action WHERE live_action.name = ${a}.action
      AND ((live_action.max_uses IS NOT NULL AND ${a}.use_count >= live_action.max_uses)
        OR (live_action.lifetime_seconds IS NOT NULL
            AND ${a}.activated_at + make_interval(secs => live_action.lifetime_seconds) <= ${now}))))`;
}

export interface GrantRowLive extends GrantLiveFields {
  id: string;
  appId: string;
}

/**
 * Lock the row, THEN judge it, in TWO statements. One `SELECT ... FOR UPDATE` is not enough: the projection that computes
 * `live` can be evaluated BEFORE the lock is granted, so a grant that expired while the query waited behind another
 * transaction's lock (one that did not change the row) would still read live. The first statement takes the lock; the
 * second reads the row and the verdict on the database clock while the lock is held. Null when the row is absent.
 */
export async function readGrantForUpdate(tx: Prisma.TransactionClient, id: string): Promise<{ row: GrantRowLive; live: boolean } | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT g.id FROM grants g WHERE g.id = ${id} FOR UPDATE`);
  if (locked.length === 0) return null;
  const rows = await tx.$queryRaw<Array<{
    id: string; app_id: string; activated_at: Date | null; revoked_at: Date | null; holder_departed_at: Date | null; app_deleted_at: Date | null; starts_at: Date | null; expires_at: Date | null;
    max_uses: number | null; use_count: number; action_max_uses: number | null; action_lifetime_seconds: number | null; live: boolean;
  }>>(Prisma.sql`SELECT g.id, g.app_id, g.activated_at, g.revoked_at, g.holder_departed_at,
      (SELECT a.deleted_at FROM apps a WHERE a.id = g.app_id) AS app_deleted_at, g.starts_at, g.expires_at, g.max_uses, g.use_count,
      (SELECT x.max_uses FROM actions x WHERE x.name = g.action) AS action_max_uses,
      (SELECT x.lifetime_seconds FROM actions x WHERE x.name = g.action) AS action_lifetime_seconds,
      ${grantLiveSql('g')} AS live FROM grants g WHERE g.id = ${id}`);
  const r = rows[0];
  if (!r) return null;
  return {
    live: r.live,
    row: { id: r.id, appId: r.app_id, activatedAt: r.activated_at, revokedAt: r.revoked_at, holderDepartedAt: r.holder_departed_at, appDeletedAt: r.app_deleted_at, startsAt: r.starts_at, expiresAt: r.expires_at, maxUses: r.max_uses, useCount: r.use_count,
      actionMaxUses: r.action_max_uses, actionLifetimeSeconds: r.action_lifetime_seconds },
  };
}

/** The grant guard's USE-arm rejection (prisma/grant-invariants.sql), as Prisma reports a raw statement's error. */
const GUARD_USE_REJECTION = 'grants are append-only: a use adds one to a live grant';
function isGuardUseRejection(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2010') return false;
  const meta = e.meta as { code?: unknown; message?: unknown } | undefined;
  return meta?.code === '23514' && typeof meta.message === 'string' && meta.message.includes(GUARD_USE_REJECTION);
}

/**
 * #4163 (cor:acl:140:03, "the use that reaches its count spends it"): charge one use of `grantId`, which the caller holds FOR UPDATE:
 * a guarded `use_count + 1` that changes exactly one row while the grant is live by {@link grantLiveSql} (so inside its action's
 * limits too). False when it no longer qualifies, nothing spent. The guard may reject at its own later clock read (it rounds to
 * timestamp(3)); that is the same miss. Any other error is the caller's.
 */
export async function chargeGrantUse(tx: Prisma.TransactionClient, grantId: string, appId: string): Promise<boolean> {
  try {
    const changed = await tx.$executeRaw(Prisma.sql`
      UPDATE grants SET use_count = use_count + 1, updated_at = ${GRANT_DB_NOW}
      WHERE id = ${grantId} AND app_id = ${appId} AND ${grantLiveSql('grants')}`);
    return changed === 1;
  } catch (e) {
    if (isGuardUseRejection(e)) return false;
    throw e;
  }
}
