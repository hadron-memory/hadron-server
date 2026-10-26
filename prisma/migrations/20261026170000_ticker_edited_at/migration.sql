-- #2429 (cor:dmo:050:11): a generated ticker edited after the cast is a reference, not bookkeeping.
ALTER TABLE "tickers" ADD COLUMN "edited_at" TIMESTAMP(3);

-- One-time heuristic for rows from before this deploy: a generated row touched more than a minute after its cast
-- counts as edited. A pre-migration edit within a minute of the cast stays unmarked (accepted residual).
UPDATE "tickers" SET "edited_at" = "updated_at"
WHERE "generated_for_worker_id" IS NOT NULL AND "updated_at" IS NOT NULL
  AND "updated_at" > "created_at" + INTERVAL '1 minute';
