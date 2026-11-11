/**
 * #3825 (cor:agt:060:13, V37/V44; the provider for #3819) — the latest DECIDED match outcome per App and combination.
 *
 * A combination is (family, tier, role). A decided match counts against EACH combination its requirements name: the
 * families of `familyIn`, the tier of `minTier`, the roles of `role`/`roles`; a dimension the requirements leave open is
 * none (V41), stored as the empty string so the composite key has no NULL. A no-worker outcome and a matched outcome are
 * recorded alike, so a match clears the failing streak of every row its requirements named, an open dimension included
 * (V44: otherwise a tier-null row would stay saturated for good).
 *
 * Latest-only: one upserted row per combination (ruling 1 of the gate). `failingSince` is the first no-worker outcome of
 * the current streak and a MATCHED clears it. A match that never reaches a decision (a lost claim, an interrupted and
 * recovered attempt) records nothing. Nothing per candidate is kept (V22). The record is read only by
 * `latestMatchOutcomes`, which #3819 calls behind its own roster gate; it is not a public surface.
 *
 * Time is the database clock, never the process's.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import type { Requirements } from './matcher.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type MatchOutcomeKind = 'MATCHED' | 'NO_WORKER';

/** One dimension-by-dimension combination; `null` is an open dimension. */
export type Combination = { family: string | null; tier: string | null; role: string | null };

/** The longest window a read may ask for (hours): the ceiling of #3819's `windowHours`. Older rows may be purged. */
export const MATCH_OUTCOME_RETENTION_HOURS = 168;
/** Rows one purge deletes at most. */
const PURGE_BATCH = 1000;

/**
 * The combinations a task's requirements name, ALL of them (a MATCHED must clear every row a failure could have set);
 * an open dimension is `null`. Unusable (invalid) requirements name none at all and record nothing: such a task can
 * never be matched, so it must not start a streak on the fully open combination (George P3-6).
 */
export function combinationsOf(req: Requirements): Combination[] {
  if (req.invalid) return [];
  const families: (string | null)[] = req.familyIn?.length ? [...new Set(req.familyIn)].sort() : [null];
  // Roles match case-insensitively (`roleAllowed`), so the key is the lower-case role: one row per role, whatever its spelling.
  const roles: (string | null)[] = req.roles?.length ? [...new Set(req.roles.map(r => r.toLowerCase()))].sort() : req.role ? [req.role.toLowerCase()] : [null];
  const tier = req.minTier ?? null;
  const out: Combination[] = [];
  for (const family of families) for (const role of roles) out.push({ family, tier, role });
  return out;
}

/**
 * A database instant at microsecond precision, as a naive-UTC `YYYY-MM-DD HH24:MI:SS.US` string (a JS Date would cut it to
 * a millisecond, and two decisions in one pass land within one). Strings of this shape order like the instants.
 */
export type DbInstant = string;

/** The database clock now: take it where a judgment is made, to stamp an outcome recorded after a gap. */
export async function decisionClock(db: Db): Promise<DbInstant> {
  const [{ ts }] = await db.$queryRaw<{ ts: string }[]>(Prisma.sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS ts`);
  return ts;
}

/**
 * Record one decided outcome for `appId` against each combination `req` names. One statement, so a decision lands
 * whole. An older decision never overwrites a newer one as the LATEST outcome: a failure judged before a success that
 * landed first does not replace it, because it is stamped with when it was decided, not when it was written (George
 * P2-4). It still reconciles the failing streak by decision time (see the statement).
 */
export async function recordMatchOutcome(
  db: Db, appId: string, req: Requirements, outcome: MatchOutcomeKind, reason: string | null = null,
  /** When the decision was made (`decisionClock`), for a record written after a gap; default: now (DB clock). */
  decidedAt: DbInstant | null = null,
  /** Combinations counted IN ADDITION to the ones `req` names (the chosen worker's own, V37/V44), deduplicated. */
  extra: Combination[] = [],
): Promise<void> {
  const seen = new Set<string>();
  // One global order over the final union (a worker's role is folded to lower case like the requirements'), so two
  // writers that touch overlapping rows take their row locks in the same order and cannot deadlock (Anne's static delta).
  const combos = [...combinationsOf(req), ...extra.map(c => ({ ...c, role: c.role?.toLowerCase() ?? null }))].filter(c => {
    const k = JSON.stringify([c.family, c.tier, c.role]);
    return !seen.has(k) && !!seen.add(k);
  }).sort((a, b) => (a.family ?? '').localeCompare(b.family ?? '') || (a.tier ?? '').localeCompare(b.tier ?? '') || (a.role ?? '').localeCompare(b.role ?? ''));
  if (combos.length === 0) return;
  const families = combos.map(c => c.family ?? '');
  const tiers = combos.map(c => c.tier ?? '');
  const roles = combos.map(c => c.role ?? '');
  const failing = outcome === 'NO_WORKER';
  // A LATE write (decided before the row's latest, written after it) never moves the latest outcome, but it is not dropped:
  // the streak is judged by decision time, so it still reconciles `failing_since` (#3825 follow-up 6773996134):
  //  - a late MATCHED ends a streak that began before it: the streak restarts after it, at the latest failure we know of
  //    (an upper bound: an earlier failure between the two was already folded into the row and cannot be recovered);
  //  - a late NO_WORKER after the last known match moves the streak start back to it.
  // `last_matched_at` is the newest MATCHED decision ever seen, late or not, so a late failure older than it is ignored
  // (on a row that predates the column, the migration's floor: its latest failure then, #3883).
  // The upsert row-locks the row, so concurrent writers apply one after another; only their ARRIVAL order varies.
  await db.$executeRaw(Prisma.sql`
    INSERT INTO agent_match_outcomes (app_id, family, tier, role, outcome, reason, decided_at, failing_since, last_matched_at)
    SELECT ${appId}, f, t, r, ${outcome}, ${failing ? reason : null}::text, c.ts, ${failing ? Prisma.sql`c.ts` : Prisma.sql`NULL::timestamp`},
      ${failing ? Prisma.sql`NULL::timestamp` : Prisma.sql`c.ts`}
    FROM unnest(${families}::text[], ${tiers}::text[], ${roles}::text[]) AS u(f, t, r)
    CROSS JOIN (SELECT COALESCE(${decidedAt}::timestamp, (clock_timestamp() AT TIME ZONE 'UTC')) AS ts) c
    ON CONFLICT (app_id, family, tier, role) DO UPDATE SET
      -- Stamps carry microseconds, so a tie is practically a same-instant double write: the later writer wins it (not late).
      outcome = CASE WHEN agent_match_outcomes.decided_at > EXCLUDED.decided_at THEN agent_match_outcomes.outcome ELSE EXCLUDED.outcome END,
      reason = CASE WHEN agent_match_outcomes.decided_at > EXCLUDED.decided_at THEN agent_match_outcomes.reason ELSE EXCLUDED.reason END,
      decided_at = GREATEST(agent_match_outcomes.decided_at, EXCLUDED.decided_at),
      last_matched_at = CASE WHEN EXCLUDED.outcome = 'MATCHED'
        THEN GREATEST(agent_match_outcomes.last_matched_at, EXCLUDED.decided_at) ELSE agent_match_outcomes.last_matched_at END,
      failing_since = CASE
        -- In order (the usual case): unchanged from before.
        WHEN agent_match_outcomes.decided_at <= EXCLUDED.decided_at THEN CASE
          WHEN EXCLUDED.outcome = 'MATCHED' THEN NULL
          WHEN agent_match_outcomes.outcome = 'NO_WORKER' AND agent_match_outcomes.failing_since IS NOT NULL THEN agent_match_outcomes.failing_since
          ELSE EXCLUDED.decided_at END
        -- Late MATCHED inside the current streak: the streak restarts after it.
        WHEN EXCLUDED.outcome = 'MATCHED' AND agent_match_outcomes.outcome = 'NO_WORKER'
          AND agent_match_outcomes.failing_since <= EXCLUDED.decided_at THEN agent_match_outcomes.decided_at
        -- Late NO_WORKER after the last known match: an earlier start of the same streak.
        WHEN EXCLUDED.outcome = 'NO_WORKER' AND agent_match_outcomes.outcome = 'NO_WORKER'
          AND (agent_match_outcomes.last_matched_at IS NULL OR agent_match_outcomes.last_matched_at < EXCLUDED.decided_at)
          THEN LEAST(agent_match_outcomes.failing_since, EXCLUDED.decided_at)
        ELSE agent_match_outcomes.failing_since END`);
}

export type LatestMatchOutcome = {
  family: string | null; tier: string | null; role: string | null;
  outcome: MatchOutcomeKind; reason: string | null; decidedAt: Date; failingSince: Date | null;
};

/**
 * The latest decided outcome of each combination of one App inside the window (hours, clamped to the 168 h retention),
 * optionally narrowed to a family, tier or role (`null` narrows to the open dimension; `undefined` does not narrow).
 * App-scoped by construction: another App's rows are never read. Internal: #3819 calls it behind its roster gate.
 */
export async function latestMatchOutcomes(
  db: Db, appId: string,
  opts: { windowHours: number; family?: string | null; tier?: string | null; role?: string | null },
): Promise<LatestMatchOutcome[]> {
  const hours = Math.min(Math.max(Number.isFinite(opts.windowHours) ? opts.windowHours : 0, 0), MATCH_OUTCOME_RETENTION_HOURS);
  const narrow = (col: string, v: string | null | undefined) => v === undefined ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(col)} = ${v ?? ''}`;
  const rows = await db.$queryRaw<{ family: string; tier: string; role: string; outcome: string; reason: string | null; decidedAt: Date; failingSince: Date | null }[]>(Prisma.sql`
    SELECT family, tier, role, outcome, reason, decided_at AS "decidedAt", failing_since AS "failingSince"
    FROM agent_match_outcomes
    WHERE app_id = ${appId} AND decided_at >= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${hours * 3600}::float8)
    ${narrow('family', opts.family)} ${narrow('tier', opts.tier)} ${narrow('role', opts.role === undefined ? undefined : opts.role === null ? null : opts.role.toLowerCase())}
    ORDER BY family, tier, role`);
  return rows.map(r => ({
    family: r.family || null, tier: r.tier || null, role: r.role || null,
    outcome: r.outcome as MatchOutcomeKind, reason: r.reason, decidedAt: r.decidedAt, failingSince: r.failingSince,
  }));
}

/** Purge rows whose outcome is older than the retention (no window can read them). Bounded; returns the count deleted. */
export async function purgeMatchOutcomes(db: Db): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    DELETE FROM agent_match_outcomes WHERE (app_id, family, tier, role) IN (
      SELECT app_id, family, tier, role FROM agent_match_outcomes
      WHERE decided_at < (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(hours => ${MATCH_OUTCOME_RETENTION_HOURS}::int) LIMIT ${PURGE_BATCH})
    -- Re-judged on the locked row: a row a matcher refreshed while this waited is no longer expired (George P2-3).
    AND decided_at < (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(hours => ${MATCH_OUTCOME_RETENTION_HOURS}::int)`);
}
