-- Rollback for 20260501000000_memory_uploads_and_staged_assets.
--
-- Reverses the three steps in opposite order. Note: rolling back after
-- v2 portal code has deployed will break uploads — the portal expects
-- accepts_uploads to be queryable. Recommended recovery is fix-forward,
-- not rollback. See contracts/migration-sql.md "Rollback strategy."

BEGIN;

-- 3. Drop partial indexes (cheapest and safest to undo).
DROP INDEX IF EXISTS "assets_staged_uploaded_at_idx";
DROP INDEX IF EXISTS "assets_uploaded_by_staged_idx";

-- 2. Re-impose NOT NULL on Asset.memory_id.
-- Refuse to roll back if any staged rows exist — they have no parent
-- memory and would violate the constraint. Operator must triage first.
DO $$
DECLARE
  staged_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO staged_count FROM "assets" WHERE "memory_id" IS NULL;
  IF staged_count > 0 THEN
    RAISE EXCEPTION 'Cannot rollback: % staged asset rows exist (memory_id IS NULL). Attach or delete them first.', staged_count;
  END IF;
END $$;
ALTER TABLE "assets"
  ALTER COLUMN "memory_id" SET NOT NULL;

-- 1. Drop Memory.accepts_uploads.
ALTER TABLE "memories"
  DROP COLUMN "accepts_uploads";

COMMIT;
