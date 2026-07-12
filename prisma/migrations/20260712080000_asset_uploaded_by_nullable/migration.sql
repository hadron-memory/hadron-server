-- #631 / PR #635 — hadron_store_file: assets can be created server-side by
-- an app run with no on-behalf-of user. NULL uploaded_by = run-created; the
-- run id is recorded on the asset's reference node and in the audit log.

ALTER TABLE "assets" ALTER COLUMN "uploaded_by" DROP NOT NULL;
