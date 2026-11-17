/** #3448: closed protocol facts. Opaque task properties are never protocol inputs (cor:agt:050:28). */
export const PR_EVENT_TYPES = ['review.scheduled', 'pr.frozen', 'review.seat.assigned', 'review.verdict', 'pr.ready'] as const;
export const REVIEW_VERDICTS = ['APPROVE', 'CHANGES_REQUESTED', 'PASS', 'FAIL', 'CARRY', 'REFUSED'] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];
export type PrProtocolEvent =
  | { type: 'review.scheduled'; slots: string[] }
  | { type: 'pr.frozen'; head: string; pullRequest: string }
  | { type: 'review.seat.assigned'; slot: string; head: string; supersedes: string | null }
  /**
   * #4235 S12a (hrn:node:hadronmemory.com:specs:cor:agt:130:02): `reviewerFamily`, `reviewerModel` and `modelReportedAt`
   * (ISO) are a snapshot of the reviewing worker's session at record time. A self-report, null where nothing is
   * recorded, and never a readiness input (cor:agt:130:03).
   */
  | { type: 'review.verdict'; slot: string; head: string; verdict: ReviewVerdict; node: string | null; receipt: string | null;
      reviewerFamily: string | null; reviewerModel: string | null; modelReportedAt: string | null }
  | { type: 'pr.ready'; head: string };
