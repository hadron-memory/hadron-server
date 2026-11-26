-- #5020: validate the NOT VALID foreign key added by 20261126090000. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on
-- usage_events, so reads and writes continue while it scans; every existing row's billable_user_id is NULL, so nothing can
-- fail. After this the constraint is the one Prisma's schema describes, so migrate diff sees no drift.
--
-- Kept alone in its file, like the concurrent index after it.
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_billable_user_id_fkey";
