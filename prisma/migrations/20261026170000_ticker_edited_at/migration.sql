-- #2429 (cor:dmo:050:11): a generated ticker edited after the cast is a reference, not bookkeeping.
ALTER TABLE "tickers" ADD COLUMN "edited_at" TIMESTAMP(3);

-- One-time heuristic for rows from before this deploy (ruled time-only: Vera/Xan, #2538): a generated row touched more
-- than a minute after its cast counts as edited, and nothing else is consulted. It fails toward blocking, never toward
-- deleting. Accepted residuals: a pre-migration edit within a minute of the cast stays unmarked; a pristine
-- pre-migration ticker touched by a non-edit write more than a minute after the cast refuses repair (route: retire).
UPDATE "tickers" SET "edited_at" = "updated_at"
WHERE "generated_for_worker_id" IS NOT NULL AND "updated_at" IS NOT NULL
  AND "updated_at" > "created_at" + INTERVAL '1 minute';
