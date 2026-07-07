-- #538: per-hop trail — the walked path, appended at each checkpoint.
-- Bounded by RUN_MAX_HOPS (50), so no growth concern.

ALTER TABLE "app_runs" ADD COLUMN "hops" JSONB;
