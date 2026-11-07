/**
 * #3668 (S1a): the ONE definition of whether a grant is live (cor:acl:140:03). Two spellings of one rule, kept together
 * and pinned against each other (live3668.test.ts): {@link isGrantLive} judges a row in memory, {@link grantLiveSql} is the
 * matching fragment for a locked read. Both judge time on the DATABASE clock (`clock_timestamp()`, never `now()`, which is
 * the transaction start, and never a JS clock).
 *
 * Live means ALL of: activated (a pending row allows nothing), not revoked, started (`starts_at <= now`, inclusive),
 * not expired (`expires_at > now`, the end is exclusive) and not spent (`max_uses` is NULL or `use_count < max_uses`).
 * The state is worked out here and never stored. The `cor:acl:140:03` open questions (a grant signed before its start,
 * a pending grant past its expiry) are NOT given a name here: both simply allow nothing.
 */
import { Prisma } from '../../generated/prisma/index.js';

export interface GrantLiveFields {
  activatedAt: Date | null;
  revokedAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}

/** The database clock as a naive UTC timestamp, the shape of every timestamp(3) column. */
export const GRANT_DB_NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

/** In-memory verdict at `now` (a naive-UTC Date, the same convention as the columns). */
export function isGrantLive(row: GrantLiveFields, now: Date): boolean {
  if (row.activatedAt === null) return false;
  if (row.revokedAt !== null) return false;
  if (row.startsAt !== null && row.startsAt.getTime() > now.getTime()) return false;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return false;
  if (row.maxUses !== null && row.useCount >= row.maxUses) return false;
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
    AND (${a}.starts_at IS NULL OR ${a}.starts_at <= ${now})
    AND (${a}.expires_at IS NULL OR ${a}.expires_at > ${now})
    AND (${a}.max_uses IS NULL OR ${a}.use_count < ${a}.max_uses))`;
}

export interface GrantRowLive extends GrantLiveFields {
  id: string;
  appId: string;
}

/**
 * Lock the row, THEN judge it: one statement takes `FOR UPDATE` and computes the verdict from the locked row on the
 * database clock, so a revocation that committed before the lock was granted is seen (a guarded read that waits on a lock
 * keeps its pre-wait snapshot under REPEATABLE READ/SERIALIZABLE only if it judges first). Null when the row is absent.
 */
export async function readGrantForUpdate(tx: Prisma.TransactionClient, id: string): Promise<{ row: GrantRowLive; live: boolean } | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string; app_id: string; activated_at: Date | null; revoked_at: Date | null; starts_at: Date | null; expires_at: Date | null;
    max_uses: number | null; use_count: number; live: boolean;
  }>>(Prisma.sql`SELECT g.id, g.app_id, g.activated_at, g.revoked_at, g.starts_at, g.expires_at, g.max_uses, g.use_count,
      ${grantLiveSql('g')} AS live FROM grants g WHERE g.id = ${id} FOR UPDATE`);
  const r = rows[0];
  if (!r) return null;
  return {
    live: r.live,
    row: { id: r.id, appId: r.app_id, activatedAt: r.activated_at, revokedAt: r.revoked_at, startsAt: r.starts_at, expiresAt: r.expires_at, maxUses: r.max_uses, useCount: r.use_count },
  };
}
