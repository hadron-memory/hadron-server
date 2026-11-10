-- #2439: per-run priced LLM cost rollup. Nullable, no default: runs minted
-- before this column are UNKNOWN, not zero (new runs are minted at 0).
ALTER TABLE "app_runs" ADD COLUMN "cost_micro_cents" BIGINT;
