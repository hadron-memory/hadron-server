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

-- AlterTable. All four are NULLABLE, deliberately: a run minted before this
-- migration has no recorded initial budget and no recorded spend, and 0 there
-- would be a false total — `budget_actions` on such a row is already
-- decremented, which proves the run DID consume actions (PR #854 review).
-- Unknown must read as unknown.
ALTER TABLE "app_runs" ADD COLUMN "budget_tokens_initial" INTEGER;
ALTER TABLE "app_runs" ADD COLUMN "budget_actions_initial" INTEGER;
ALTER TABLE "app_runs" ADD COLUMN "tokens_spent" INTEGER;
ALTER TABLE "app_runs" ADD COLUMN "actions_spent" INTEGER;

-- The DEFAULT is set AFTER the ADD so it applies only to rows inserted from
-- here on. (`ADD COLUMN ... DEFAULT 0` in one statement would backfill every
-- existing row with 0 — precisely the false zero above.)
ALTER TABLE "app_runs" ALTER COLUMN "tokens_spent" SET DEFAULT 0;
ALTER TABLE "app_runs" ALTER COLUMN "actions_spent" SET DEFAULT 0;

-- Best-effort backfill of tokens_spent from the hop trail, for EVERY run that
-- has one — including PENDING/RUNNING rows. The executor checkpoints `hops` as
-- it advances and a resumed run never re-executes a completed hop, so those
-- already-recorded tokens would otherwise be lost forever rather than
-- double-counted (PR #854 review, Codex P2 / Copilot — my original
-- terminal-runs-only filter had this backwards).
--
-- Still best-effort by construction: the trail omits hops that failed
-- mid-execution, which is the very under-report the go-forward counter exists
-- to fix. Runs with no trail stay NULL (unknown), not 0.
UPDATE "app_runs"
SET "tokens_spent" = COALESCE((
  SELECT SUM(COALESCE((hop ->> 'tokensSpent')::int, 0))
  FROM jsonb_array_elements("hops"::jsonb) AS hop
), 0)
WHERE "hops" IS NOT NULL
  AND jsonb_typeof("hops"::jsonb) = 'array'
  AND jsonb_array_length("hops"::jsonb) > 0;
