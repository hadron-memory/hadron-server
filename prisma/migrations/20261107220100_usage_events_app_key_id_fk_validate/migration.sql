-- #2944 / #3714 blind P2: validate the NOT VALID foreign key added by 20261107220000. VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE on usage_events, so reads and writes continue while it scans. Every existing row's
-- app_key_id is NULL (the column is new), so nothing can fail. After this the constraint is identical to the
-- one Prisma's schema describes, so migrate diff sees no drift.
--
-- Kept alone in its file, like the concurrent index after it.
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_app_key_id_fkey";
