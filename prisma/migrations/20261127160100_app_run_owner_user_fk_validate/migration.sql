-- #5077: validate the NOT VALID foreign key added by 20261127160000. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on
-- app_runs, so reads and writes continue while it scans, and SHARE ROW EXCLUSIVE on the REFERENCED table (users), which
-- blocks writes to users while it runs. The scan is cheap: every existing row's owner_user_id is NULL, so nothing can fail
-- and no row has a parent to look up. After this the constraint is the one Prisma's schema describes, so migrate diff sees
-- no drift. One statement, so it runs alone.
ALTER TABLE "app_runs" VALIDATE CONSTRAINT "app_runs_owner_user_id_fkey";
