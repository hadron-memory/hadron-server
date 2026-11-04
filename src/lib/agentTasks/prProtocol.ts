/** #3448: closed protocol facts. Opaque task properties are never protocol inputs (cor:agt:050:28). */
export const PR_EVENT_TYPES = ['review.scheduled', 'pr.frozen', 'review.seat.assigned', 'review.verdict', 'pr.ready'] as const;
export const REVIEW_VERDICTS = ['APPROVE', 'CHANGES_REQUESTED', 'PASS', 'FAIL', 'CARRY', 'REFUSED'] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];
export type PrProtocolEvent =
  | { type: 'review.scheduled'; slots: string[] }
  | { type: 'pr.frozen'; head: string; pullRequest: string }
  | { type: 'review.seat.assigned'; slot: string; head: string; supersedes: string | null }
  | { type: 'review.verdict'; slot: string; head: string; verdict: ReviewVerdict; node: string | null; receipt: string | null }
  | { type: 'pr.ready'; head: string };
