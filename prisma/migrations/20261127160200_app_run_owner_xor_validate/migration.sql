-- #5077: validate the NOT VALID CHECK added by 20261127160000 (exactly one of organization_id and owner_user_id). It takes
-- SHARE UPDATE EXCLUSIVE on app_runs, so reads and writes continue while it scans. Every existing row has an organization
-- and a NULL owner, so no row can fail it. One statement, so it runs alone.
ALTER TABLE "app_runs" VALIDATE CONSTRAINT "chk_app_run_owner_xor";
