// #4281 S12c — Query.reviewQualityReport: the monthly review quality measures per reviewer family and model
// (Proposed, not yet in the spec corpus).
//
// AUTHORIZATION (hrn:node:hadronmemory.com:specs:cor:agt:050:21, the Proposed reader line; Peter, team chat #110352): the
// measures are worked out from the App's tasks and events, so they are read exactly as those are, through
// `withReadableApp`, the function `agentTeamEvents` uses: the App's participants and the App's own key. Anyone else is
// refused APP_NOT_FOUND, the answer for an App that does not exist. Read-only, and never an input to readiness or
// matching (hrn:node:hadronmemory.com:specs:cor:agt:130:03).
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { taskError, withReadableApp } from './resolvers.agentTask.js';
import { toNaiveUtc } from '../../../lib/sessionActivity.js';

const MONTH = /^([2-9]\d{3})-(0[1-9]|1[0-2])$/;

type Counted = {
  asOf: Date; family: string | null; model: string | null; reported: boolean | null;
  reviews: number | null; findings: number; confirmed: number; rejected: number; undisposed: number; approving: number; missed: number;
};

/** `YYYY-MM` to the half-open UTC range [first instant of the month, first instant of the next). */
function monthRange(month: unknown): { start: Date; end: Date } {
  const m = typeof month === 'string' ? MONTH.exec(month) : null;
  if (!m) throw taskError('BAD_USER_INPUT', 'month must be a calendar month as YYYY-MM, for example 2026-11.');
  const year = Number(m[1]), index = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(year, index, 1)), end: new Date(Date.UTC(year, index + 1, 1)) };
}

const plain = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * ONE statement, so one snapshot: tasks, findings, dispositions and verdicts are read at the same instant, and `asOf`
 * is that statement's start on the database clock.
 *
 * - `latest`: each seat's newest `review.verdict` (created_at, then id, as readiness orders them). Verdicts before the
 *   month cannot be a seat's newest when it has one in or after the month, and a seat with none from the month's start
 *   on is not in the month, so only events from `start` on are read; a seat whose newest falls after the month is
 *   then dropped, never counted by an older verdict. `created_at` is a naive UTC timestamp, so the bounds are bound
 *   as naive UTC text (`toNaiveUtc`): the month is UTC whatever the session's time zone.
 * - a review is a FINISHED task of this App carrying such a verdict. Only `recordReviewVerdict` writes the event, and
 *   only on an assigned seat, so a task with one is a seat task.
 * - a snapshot with no family or no model (null, absent before S12a, or empty) is "not recorded": one row, never a family.
 * - findings are the seat's `result_findings`; the dispositions trigger keeps `finding_dispositions` at most one per
 *   finding and only on findings that exist, so undisposed = findings - dispositions.
 * - #4287, defects missed (#4280's rule): an approving review misses each defect linked
 *   (`review.defect-linked`) to its seat's build task whose `introducedAtHead` is null, or was first frozen on that
 *   task no later than the head the review approved: heads in the order of the build's `pr.frozen` events, a head
 *   frozen twice at its FIRST freeze. Each head's position is that one event's (created_at, tx_id, id), compared as a
 *   row (#4289 blind F1: independent minima could mix two events and tie). A head approved before the defect was
 *   introduced never contained it. One link per (defect, task), so each defect counts once per review. Both heads
 *   always have a freeze: a seat is assigned only at a frozen head, and a link names only a frozen one
 *   (DEFECT_HEAD_NOT_FROZEN); a missing one would compare unknown and count nothing.
 */
async function countReviews(tx: Context['db'], appId: string, start: Date, end: Date): Promise<Counted[]> {
  return tx.$queryRaw<Counted[]>(Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (e.task_id) e.task_id, e.payload, e.created_at
      FROM agent_team_events e
      WHERE e.app_id = ${appId} AND e.type = 'review.verdict' AND e.task_id IS NOT NULL AND e.created_at >= ${toNaiveUtc(start)}::timestamp
      ORDER BY e.task_id, e.created_at DESC, e.id DESC
    ), reviews AS (
      SELECT
        l.payload->>'verdict' AS verdict,
        NULLIF(l.payload->>'reviewerFamily', '') AS family,
        NULLIF(l.payload->>'reviewerModel', '') AS model,
        l.payload->>'modelReportedAt' IS NOT NULL AS reported,
        CASE WHEN jsonb_typeof(t.result_findings) = 'array' THEN jsonb_array_length(t.result_findings) ELSE 0 END AS findings,
        jsonb_array_length(t.finding_dispositions) AS disposed,
        (SELECT count(*) FROM jsonb_array_elements(t.finding_dispositions) d WHERE d->>'disposition' IN ('fixed', 'accepted', 'deferred')) AS confirmed,
        (SELECT count(*) FROM jsonb_array_elements(t.finding_dispositions) d WHERE d->>'disposition' = 'rejected') AS rejected,
        CASE WHEN l.payload->>'verdict' IN ('APPROVE', 'PASS', 'CARRY') THEN (
          SELECT count(*) FROM agent_team_events d
          WHERE d.app_id = ${appId} AND d.task_id = t.parent_task_id AND d.type = 'review.defect-linked'
            AND (d.payload->>'introducedAtHead' IS NULL OR (
              SELECT (f.created_at, f.tx_id, f.id) FROM agent_team_events f
              WHERE f.app_id = ${appId} AND f.task_id = t.parent_task_id AND f.type = 'pr.frozen' AND f.payload->>'head' = d.payload->>'introducedAtHead'
              ORDER BY f.created_at, f.tx_id, f.id LIMIT 1
            ) <= (
              SELECT (f.created_at, f.tx_id, f.id) FROM agent_team_events f
              WHERE f.app_id = ${appId} AND f.task_id = t.parent_task_id AND f.type = 'pr.frozen' AND f.payload->>'head' = l.payload->>'head'
              ORDER BY f.created_at, f.tx_id, f.id LIMIT 1
            ))
        ) ELSE 0 END AS missed
      FROM latest l
      JOIN agent_tasks t ON t.id = l.task_id AND t.app_id = ${appId}
      WHERE l.created_at < ${toNaiveUtc(end)}::timestamp AND t.status = 'finished'
    ), keyed AS (
      SELECT r.*, (r.family IS NOT NULL AND r.model IS NOT NULL) AS recorded FROM reviews r
    ), counted AS (
      SELECT
        CASE WHEN recorded THEN family END AS family,
        CASE WHEN recorded THEN model END AS model,
        CASE WHEN recorded THEN reported END AS reported,
        count(*)::int AS reviews,
        COALESCE(sum(findings), 0)::int AS findings,
        COALESCE(sum(confirmed), 0)::int AS confirmed,
        COALESCE(sum(rejected), 0)::int AS rejected,
        COALESCE(sum(findings - disposed), 0)::int AS undisposed,
        (count(*) FILTER (WHERE verdict IN ('APPROVE', 'PASS', 'CARRY')))::int AS approving,
        COALESCE(sum(missed), 0)::int AS missed
      FROM keyed
      GROUP BY 1, 2, 3
    )
    SELECT s."asOf", c.family, c.model, c.reported, c.reviews, c.findings, c.confirmed, c.rejected, c.undisposed, c.approving, c.missed
    FROM (SELECT statement_timestamp() AS "asOf") s LEFT JOIN counted c ON true`);
}

export const reviewQualityQueries = {
  reviewQualityReport: async (_: unknown, { appRef, month }: { appRef: string; month: string }, ctx: Context) =>
    withReadableApp(ctx, appRef, async (c, app) => {
      // Judged only after the gate, so a caller outside the App learns nothing from a malformed month either.
      const { start, end } = monthRange(month);
      const counted = await countReviews(c.db, app.id, start, end);
      const rows = counted.filter((r) => r.reviews != null).map((r) => {
        const recorded = r.family !== null && r.model !== null;
        return {
          recorded, family: r.family, model: r.model, modelReported: recorded ? r.reported : null,
          reviews: r.reviews!, findings: r.findings, findingsPerReview: r.findings / r.reviews!,
          confirmedFindings: r.confirmed, rejectedFindings: r.rejected, undisposedFindings: r.undisposed,
          // No findings, no share: 0 ÷ 0 is not a share of 0.
          shareConfirmed: r.findings > 0 ? r.confirmed / r.findings : null,
          // #4287: always a count; the share is null only with no approving review to divide by.
          approvingReviews: r.approving, defectsMissed: r.missed,
          defectsMissedPerApprovingReview: r.approving > 0 ? r.missed / r.approving : null,
        };
      });
      // Recorded rows by family, model, then reported before unreported (code-unit order, the same on every database);
      // the "not recorded" row last.
      rows.sort((a, b) => Number(b.recorded) - Number(a.recorded)
        || plain(a.family ?? '', b.family ?? '') || plain(a.model ?? '', b.model ?? '')
        || Number(b.modelReported) - Number(a.modelReported));
      return { month, asOf: counted[0]!.asOf, rows };
    }),
};
