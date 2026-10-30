-- #2096: ONE live generated ticker per (worker, template). A soft-deleted one does not hold the slot, so the
-- manager-run apply operation can recreate a template ticker the manager deleted (the gate's "counts as absent").
-- Prisma cannot model the WHERE, so the schema no longer declares tickers_generated_uniq (the all-rows unique).
-- Synced with the 20261030120000 migration and src/test/globalSetup.ts.
DROP INDEX IF EXISTS tickers_generated_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS tickers_generated_live_uniq
  ON tickers (generated_for_worker_id, source_template_id)
  WHERE generated_for_worker_id IS NOT NULL AND deleted_at IS NULL;
