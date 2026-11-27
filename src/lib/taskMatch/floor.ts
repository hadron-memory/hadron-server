/**
 * #5284 (S4 of #4360) — the no-match floor (R4; Proposed hrn:node:hadronmemory.com:specs:cor:dmo:050:24): the vector
 * similarity of a task's abstract to the phrase below which no task fits.
 *
 * The default, 0.45, is the separating score of the re-cut S0 measurement on abstracts, which Holger accepted
 * ("Accept both", 2026-11-25, decisions:2026-11-25-holger-rulings-to-peter item 7).
 */
export const TASK_MATCH_MIN_SCORE_DEFAULT = 0.45;

/**
 * `TASK_MATCH_MIN_SCORE`, read per call: a plain decimal strictly between 0 and 1. Unset, empty or anything else
 * (0, 1, negatives, above 1, junk) falls back to the default, so no configured value switches the floor off or
 * refuses every task.
 */
export function taskMatchMinScore(): number {
  const raw = process.env.TASK_MATCH_MIN_SCORE?.trim();
  if (!raw || !/^(0?\.\d+|0)$/.test(raw)) return TASK_MATCH_MIN_SCORE_DEFAULT;
  const n = Number(raw);
  return n > 0 && n < 1 ? n : TASK_MATCH_MIN_SCORE_DEFAULT;
}
