-- #2096: ONE live generated ticker per (worker, template). A soft-deleted one does not hold the slot, so the
-- manager-run apply operation can recreate a template ticker the manager deleted. Prisma cannot model the WHERE:
-- schema.prisma carries a plain index (tickers_generated_idx) and the partial unique is raw SQL, synced with
-- prisma/ticker-generated-live-unique.sql (post-push.sql) and src/test/globalSetup.ts.
DROP INDEX IF EXISTS "tickers_generated_uniq";
CREATE INDEX "tickers_generated_idx" ON "tickers"("generated_for_worker_id", "source_template_id");
CREATE UNIQUE INDEX "tickers_generated_live_uniq"
  ON "tickers" ("generated_for_worker_id", "source_template_id")
  WHERE "generated_for_worker_id" IS NOT NULL AND "deleted_at" IS NULL;
