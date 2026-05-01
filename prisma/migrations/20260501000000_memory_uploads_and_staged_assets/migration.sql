-- Spec: 006-asset-upload-redesign — foundational migration.
--
-- See specs/006-asset-upload-redesign/contracts/migration-sql.md for the
-- canonical version + sequencing rationale.
--
-- Three changes, atomic in one transaction:
--   1. Memory.accepts_uploads — new column; defaults derived per class.
--   2. Asset.memory_id — drop NOT NULL to support staging.
--   3. Two partial indexes on staged Asset rows for listing + janitor sweep.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 1. Memory.accepts_uploads
-- ──────────────────────────────────────────────────────────────────────

-- Add as nullable so the data fix can populate before locking.
ALTER TABLE "memories"
  ADD COLUMN "accepts_uploads" BOOLEAN;

-- Derive defaults per memory class.
-- system  → false (consumer-shouldn't-write-to surface)
-- app     → true  (shared family/team upload destination)
-- knowledge → true (read-write knowledge bases accept uploads)
-- personal → true (user's own memory; their files)
UPDATE "memories"
SET "accepts_uploads" = CASE
  WHEN "class" = 'system'    THEN FALSE
  WHEN "class" = 'app'       THEN TRUE
  WHEN "class" = 'knowledge' THEN TRUE
  WHEN "class" = 'personal'  THEN TRUE
  ELSE FALSE  -- safe fallback: refuse uploads if class is unknown
END;

-- Lock down the column.
ALTER TABLE "memories"
  ALTER COLUMN "accepts_uploads" SET NOT NULL;

-- New memories default to true; system-class memories must opt-out at
-- creation time in application code (the platform creates system
-- memories, not users).
ALTER TABLE "memories"
  ALTER COLUMN "accepts_uploads" SET DEFAULT TRUE;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Asset.memory_id becomes nullable (staging)
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE "assets"
  ALTER COLUMN "memory_id" DROP NOT NULL;

-- The existing FK constraint with ON DELETE CASCADE is preserved.
-- Cascade only fires when memory_id IS NOT NULL — existing behavior.

-- ──────────────────────────────────────────────────────────────────────
-- 3. Partial indexes on staged Asset rows
-- ──────────────────────────────────────────────────────────────────────

-- Powers per-user staged-asset listing (Query.myStagedAssets).
CREATE INDEX "assets_uploaded_by_staged_idx"
  ON "assets" ("uploaded_by", "uploaded_at" DESC)
  WHERE "memory_id" IS NULL;

-- Powers the janitor's staging-TTL sweep.
CREATE INDEX "assets_staged_uploaded_at_idx"
  ON "assets" ("uploaded_at")
  WHERE "memory_id" IS NULL;

COMMIT;
