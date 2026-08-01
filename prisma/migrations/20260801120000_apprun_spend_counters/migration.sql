-- #832 — "tokens spent vs budget" on the run audit surface.
--
-- `budget_tokens` / `budget_actions` are what REMAINS (live-decremented), and
-- the minted budget was never stored, so spend could not be computed at all.
-- The two available derivations are both wrong:
--
--   * summing `hops[].tokensSpent` — the hop trail has NO element for a hop
--     that failed mid-execution, so the sum silently under-reports exactly the
--     runs an operator is auditing;
--   * `initial - remaining` — the decrement is CLAMPED (Math.min(spent,
--     budget)) so the remaining budget never goes negative; an overspending
--     run would report exactly its budget and no more.
--
-- Hence unclamped cumulative counters, written in the same statement as the
-- decrement, plus the minted budget for the "vs budget" half.

-- AlterTable. The counters are NOT NULL DEFAULT 0: every future write goes
-- through the increment, and 0 is the truthful starting value. The *_initial
-- columns are nullable — a run minted before this migration genuinely has no
-- recorded initial budget, and 0 there would be a lie (it would render as
-- "0 budget" rather than "unknown").
ALTER TABLE "app_runs" ADD COLUMN "budget_tokens_initial" INTEGER;
ALTER TABLE "app_runs" ADD COLUMN "budget_actions_initial" INTEGER;
ALTER TABLE "app_runs" ADD COLUMN "tokens_spent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_runs" ADD COLUMN "actions_spent" INTEGER NOT NULL DEFAULT 0;

-- Best-effort backfill for runs that are already FINISHED. A terminal run's
-- remaining budget no longer moves, so summing the hop trail is the only
-- signal available for history — under-reporting on failed hops, which is why
-- it is not the go-forward mechanism. In-flight runs (PENDING/RUNNING) are
-- deliberately left at 0 so the live counters take over cleanly rather than
-- double-counting hops that are also about to increment.
UPDATE "app_runs"
SET "tokens_spent" = COALESCE((
  SELECT SUM(COALESCE((hop ->> 'tokensSpent')::int, 0))
  FROM jsonb_array_elements("hops"::jsonb) AS hop
), 0)
WHERE "hops" IS NOT NULL
  AND jsonb_typeof("hops"::jsonb) = 'array'
  AND "status" IN ('COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
