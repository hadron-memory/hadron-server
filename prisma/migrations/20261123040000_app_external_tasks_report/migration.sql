-- #4937 (cor:agt:050:31): the App's latest report of whether external tasks exist. Additive and expand-safe: three nullable
-- columns, NULL for every existing App, so the lead cadence alarm is OFF for every App until its first report. The
-- previous image ignores the columns.
ALTER TABLE "apps" ADD COLUMN "external_tasks_exist" BOOLEAN;
ALTER TABLE "apps" ADD COLUMN "external_tasks_reported_at" TIMESTAMP(3);
ALTER TABLE "apps" ADD COLUMN "external_tasks_reported_by" TEXT;
