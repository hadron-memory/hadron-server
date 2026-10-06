-- Ruling DY-2 (#1653): a usage event counts toward its session's liveness only
-- when the session was live and owned by the recorder at write time. Existing
-- rows are backfilled TRUE (ADD COLUMN with a constant default is a catalog-only
-- change), so every session's liveness is unchanged at deploy; new rows then
-- default to FALSE, so a writer that does not set the flag fails safe.
ALTER TABLE "usage_events" ADD COLUMN "counts_as_activity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "usage_events" ALTER COLUMN "counts_as_activity" SET DEFAULT false;

-- Ruling DY-5: per-App dormancy threshold for lapsed worker sessions.
ALTER TABLE "apps" ADD COLUMN "session_dormancy_days" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "apps" ADD CONSTRAINT "chk_app_session_dormancy_days_positive" CHECK ("session_dormancy_days" > 0);
