-- #2429 (cor:dmo:050:11): a generated ticker edited after the cast is a reference, not bookkeeping.
ALTER TABLE "tickers" ADD COLUMN "edited_at" TIMESTAMP(3);

-- One-time heuristic for rows from before this deploy. The cast stamps updated_by* = created_by*, and the only code that
-- rewrites a live generated row afterwards is updateTicker, which stamps the editor. So a row counts as edited only when
-- its updated_at is over a minute after the cast AND its updated_by stamp no longer matches the cast's. That keeps non-edit
-- writes to updated_at (clock skew, bookkeeping) from marking a pristine ticker permanently edited. Residuals, both
-- accepted: a pre-migration edit within a minute of the cast, or by the very actor that cast it, stays unmarked.
UPDATE "tickers" SET "edited_at" = "updated_at"
WHERE "generated_for_worker_id" IS NOT NULL AND "updated_at" IS NOT NULL
  AND "updated_at" > "created_at" + INTERVAL '1 minute'
  AND ("updated_by" IS DISTINCT FROM "created_by"
    OR "updated_by_worker_id" IS DISTINCT FROM "created_by_worker_id"
    OR "updated_by_agent_id" IS DISTINCT FROM "created_by_agent_id");
