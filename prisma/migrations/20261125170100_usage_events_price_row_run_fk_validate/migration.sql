-- #5021: validate the two NOT VALID foreign keys added by 20261125170000. VALIDATE CONSTRAINT takes SHARE UPDATE
-- EXCLUSIVE on usage_events, so reads and writes continue while it scans. Every existing row's price_row_id and
-- app_run_id is NULL (the columns are new), so nothing can fail. After this the constraints are identical to the ones
-- Prisma's schema describes, so migrate diff sees no drift.
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_price_row_id_fkey";

ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_app_run_id_fkey";
