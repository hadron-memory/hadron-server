-- #5021 (billing A16, cor:dmo:170:06): each unit records the price row that priced it, the markup applied to its
-- charge, and (gate ruling 9) its run. Nullable, no backfill: a unit recorded before these columns keeps an empty
-- reference, never filled in by matching effective dates.
--
-- usage_events is the append-only, high-volume firehose, so nothing here scans it (precedent: #2944's
-- 20261107220000): the columns are nullable with no default (catalog-only) and the foreign keys are added NOT VALID,
-- which takes only a brief lock on each table and checks new writes from then on. 20261125170100 validates them
-- (without blocking writes) and 20261125170200 / 20261125170300 build the indexes CONCURRENTLY.
--
-- The price-row key restricts both ways: price rows are never deleted or re-keyed (the trigger in 20261125170400
-- refuses it too). The run key sets null, like the table's other keys.
ALTER TABLE "usage_events" ADD COLUMN "price_row_id" TEXT,
ADD COLUMN "markup_basis_points" INTEGER,
ADD COLUMN "app_run_id" TEXT;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_price_row_id_fkey" FOREIGN KEY ("price_row_id") REFERENCES "ai_model_prices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_app_run_id_fkey" FOREIGN KEY ("app_run_id") REFERENCES "app_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
