/**
 * #5008 (Billing A2) — the AI spend summary of one organization, for a date range and one grouping.
 * Plan: hrn:node:hadronmemory.com:hadron-server:design:subscription-billing-plan, section 7, slice A2.
 * Specs: cor:dmo:170:04 (cost and charge are separate figures; an unpriced unit is never shown as a zero cost),
 * :07 (only platform-key spend is debited; own-key spend has a cost and no charge).
 *
 * One statement, tagged-template parameters, no string-built SQL. The GraphQL enum value never reaches SQL as text: it
 * selects a fragment from {@link GROUP_KEY}. Shaped for the slices that extend it: the owner predicate and the charge
 * are each one named fragment (A13 adds a billable-user owner; A15 adds `cost-correction` adjustments to the charge).
 *
 * `usage_events.created_at` is `timestamp without time zone` holding a UTC instant, so the bounds are bound as
 * naive-UTC literals cast `::timestamp` and the column stays bare (the `(organization_id, created_at)` index is used),
 * and `DAY` truncates the naive column, which is UTC by construction: no `AT TIME ZONE` anywhere
 * (hrn:node:hadronmemory.com:hadron-server:findings:prisma-naive-timestamp-raw-sql).
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { toNaiveUtc } from '../sessionActivity.js';

/** The longest range one call may cover (`to - from`), in days. */
export const AI_SPEND_MAX_DAYS = 366;
/** The most rows one call returns; the exact number of groups is returned beside them. */
export const AI_SPEND_MAX_ROWS = 500;

/** The groupings built in A2. `USER` is not among them: it waits for a ruling (#5008, open ruling R1). */
export type AiSpendGroup = 'DAY' | 'APP' | 'MODEL' | 'KEY_OWNER';

/** The closed map from a grouping to its key expression. A null key is the empty string. */
const GROUP_KEY: Record<AiSpendGroup, Prisma.Sql> = {
  DAY: Prisma.sql`to_char(date_trunc('day', ue.created_at), 'YYYY-MM-DD')`,
  APP: Prisma.sql`coalesce(ue.app_id, '')`,
  // `provider/model` with a missing half empty; both missing is the empty key.
  MODEL: Prisma.sql`CASE WHEN ue.provider IS NULL AND ue.model IS NULL THEN '' ELSE coalesce(ue.provider, '') || '/' || coalesce(ue.model, '') END`,
  KEY_OWNER: Prisma.sql`coalesce(ue.key_owner_type, '')`,
};

/** Whose units: one organization's, or one person's (#5020: the units BILLED to the person, never those done for them). */
export type AiSpendScope = { organizationId: string } | { userId: string };

/**
 * Whose units: one fragment, so a later owner kind adds a branch here and nowhere else. A person's are the units that name
 * them as the billable account (`billable_user_id`, #5020, cor:dmo:170:05), never `user_id`: the user the work was done for
 * is a different person from the one who pays, and a unit of an organization's App done for a member is the
 * organization's, not the member's. Branches on the scope's own kind first, so no comparison can match two null columns.
 */
const ownerPredicate = (scope: AiSpendScope): Prisma.Sql =>
  'userId' in scope ? Prisma.sql`ue.billable_user_id = ${scope.userId}` : Prisma.sql`ue.organization_id = ${scope.organizationId}`;

/**
 * The charge of a unit: the debit the ledger holds for it, joined on the ledger's unique (source_type, source_id). Only
 * a live debit of the unit's own billable account joins: a grant, an adjustment, a deleted row or another owner's row naming
 * this unit's id is not what was charged for it. The account is the unit's organization or its billable person, one
 * fragment per scope kind, each comparing that one column (a unit has exactly one).
 */
const chargeJoin = (scope: AiSpendScope): Prisma.Sql =>
  'userId' in scope
    ? Prisma.sql`LEFT JOIN credit_ledger_entries c
    ON c.source_type = 'usage-event' AND c.source_id = ue.id AND c.kind = 'debit'
   AND c.deleted_at IS NULL AND c.owner_user_id = ue.billable_user_id`
    : Prisma.sql`LEFT JOIN credit_ledger_entries c
    ON c.source_type = 'usage-event' AND c.source_id = ue.id AND c.kind = 'debit'
   AND c.deleted_at IS NULL AND c.organization_id = ue.organization_id`;

export type AiSpendInput = AiSpendScope & { from: Date; to: Date; groupBy: AiSpendGroup };

export type AiSpendRowData = {
  key: string;
  events: number;
  tokensIn: string;
  tokensOut: string;
  /** Sum over the PRICED units only; `unpricedEvents` counts the rest (cor:dmo:170:04). */
  costMicroCents: string;
  unpricedEvents: number;
  /** The sum of the magnitudes of the units' debits: a separate figure from cost. */
  chargedMicroCents: string;
};

export type AiSpendResult = { rows: AiSpendRowData[]; totalGroups: number; truncated: boolean };

type RawRow = {
  key: string;
  events: bigint;
  tokens_in: string;
  tokens_out: string;
  cost: string;
  unpriced: bigint;
  charged: string;
  total_groups: bigint;
};

/** A transaction client or the client itself: the library reads through whichever the caller holds. */
type Db = Pick<PrismaClient, '$queryRaw'>;

export async function aiSpendSummary(db: Db, input: AiSpendInput): Promise<AiSpendResult> {
  // Own keys only: an inherited one (`constructor`, `__proto__`) is not a grouping, whatever a caller sends.
  const keyExpr = Object.hasOwn(GROUP_KEY, input.groupBy) ? GROUP_KEY[input.groupBy] : undefined;
  if (!keyExpr) throw new Error(`aiSpendSummary: unknown grouping ${String(input.groupBy)}`);
  const rows = await db.$queryRaw<RawRow[]>`
    WITH g AS (
      SELECT ${keyExpr} AS key,
             count(*) AS events,
             coalesce(sum(ue.tokens_in), 0) AS tokens_in,
             coalesce(sum(ue.tokens_out), 0) AS tokens_out,
             coalesce(sum(ue.cost_micro_cents), 0) AS cost,
             count(*) FILTER (WHERE ue.cost_micro_cents IS NULL) AS unpriced,
             -- debitCredits stores a debit negative; the magnitude is summed per row, so a mis-signed row still counts as a
             -- charge instead of netting against another. This query does not police a debit's sign.
             coalesce(sum(abs(c.amount_micro_cents)), 0) AS charged
      FROM usage_events ue
      ${chargeJoin(input)}
      WHERE ${ownerPredicate(input)}
        AND ue.deleted_at IS NULL
        AND ue.created_at >= ${toNaiveUtc(input.from)}::timestamp
        AND ue.created_at < ${toNaiveUtc(input.to)}::timestamp
        AND (ue.tokens_in IS NOT NULL OR ue.tokens_out IS NOT NULL)
      GROUP BY 1
    )
    SELECT key, events, tokens_in::text AS tokens_in, tokens_out::text AS tokens_out, cost::text AS cost, unpriced,
           charged::text AS charged, count(*) OVER () AS total_groups
    FROM g
    ORDER BY g.charged DESC, g.cost DESC, g.events DESC, g.key ASC
    LIMIT ${AI_SPEND_MAX_ROWS}`;
  const totalGroups = rows.length === 0 ? 0 : Number(rows[0]!.total_groups);
  return {
    rows: rows.map((r) => ({
      key: r.key,
      events: Number(r.events),
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      costMicroCents: r.cost,
      unpricedEvents: Number(r.unpriced),
      chargedMicroCents: r.charged,
    })),
    totalGroups,
    truncated: totalGroups > AI_SPEND_MAX_ROWS,
  };
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * An ISO 8601 date or date-time, or null. A date alone is midnight UTC and a date-time with no offset is UTC. Nothing a
 * lenient parser would guess at is accepted (`2026`, `1 March 2026`, `2026-02-31`), so the same text means the same
 * instant on every server (#5008, ruling 10.3).
 */
export function parseSpendInstant(raw: string): Date | null {
  const m = ISO_INSTANT.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone = 'Z'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? `.${frac.slice(0, 3).padEnd(3, '0')}` : ''}${zone}`);
  return Number.isNaN(at.getTime()) ? null : at;
}
