-- Add App.urn, backfill existing rows, then enforce NOT NULL + UNIQUE.
-- URN format matches memories and agents: "{org.urn}:{slug}" where slug is
-- derived from the app's name (lowercase, spaces → hyphens).

-- 1. Add the column (nullable so the backfill can succeed)
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "urn" TEXT;

-- 2. Backfill from existing org URN + a slugified name. The slug rules here
--    are intentionally simple; any conflicts will be resolved by the admin
--    via updateApp after migration.
UPDATE "apps" a
SET "urn" = o."urn" || ':' || lower(regexp_replace(a."name", '[^a-zA-Z0-9_-]+', '-', 'g'))
FROM "organizations" o
WHERE a."organization_id" = o."id"
  AND a."urn" IS NULL;

-- 3. Enforce NOT NULL and uniqueness
ALTER TABLE "apps" ALTER COLUMN "urn" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "apps_urn_key" ON "apps"("urn");
