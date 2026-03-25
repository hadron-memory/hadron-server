-- ============================================================
-- Phase 2: URN naming migration
-- ============================================================

-- 1. Organization: rename domain → urn
ALTER TABLE "organizations" RENAME COLUMN "domain" TO "urn";

-- 2. Memory: rename name → urn, add new name column
ALTER TABLE "memories" RENAME COLUMN "name" TO "urn";

-- Backfill Memory.name from urn (part after last '/')
ALTER TABLE "memories" ADD COLUMN "name" TEXT;
UPDATE "memories" SET "name" = CASE
  WHEN "urn" LIKE '%/%' THEN SUBSTRING("urn" FROM '[^/]+$')
  ELSE "urn"
END;
ALTER TABLE "memories" ALTER COLUMN "name" SET NOT NULL;

-- Drop old unique constraint on (organizationId, name) and add unique on (urn)
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_organization_id_name_key";
ALTER TABLE "memories" ADD CONSTRAINT "memories_urn_key" UNIQUE ("urn");

-- 3. Node: drop title, drop namespace, drop namespace index
ALTER TABLE "nodes" DROP COLUMN "title";
ALTER TABLE "nodes" DROP COLUMN "namespace";
DROP INDEX IF EXISTS "nodes_namespace_idx";

-- 4. NodeVersion: drop title
ALTER TABLE "node_versions" DROP COLUMN "title";

-- 5. Agent: add urn column, backfill, make unique
ALTER TABLE "agents" ADD COLUMN "urn" TEXT;
UPDATE "agents" SET "urn" = (
  SELECT o."urn" || ':' || "agents"."name"
  FROM "organizations" o
  WHERE o."id" = "agents"."organization_id"
);
ALTER TABLE "agents" ALTER COLUMN "urn" SET NOT NULL;

-- Drop old unique constraint on (organizationId, name) and add unique on (urn)
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_organization_id_name_key";
ALTER TABLE "agents" ADD CONSTRAINT "agents_urn_key" UNIQUE ("urn");

-- 6. Station: rename label → name, add urn column, backfill
ALTER TABLE "stations" RENAME COLUMN "label" TO "name";

ALTER TABLE "stations" ADD COLUMN "urn" TEXT;
UPDATE "stations" SET "urn" = (
  SELECT o."urn" || ':' || "stations"."name"
  FROM "organizations" o
  WHERE o."id" = "stations"."organization_id"
)
WHERE "stations"."organization_id" IS NOT NULL;

-- For stations without an org, derive from user
UPDATE "stations" SET "urn" = (
  SELECT COALESCE(u."github_username", u."email", u."id") || ':' || "stations"."name"
  FROM "users" u
  WHERE u."id" = "stations"."user_id"
)
WHERE "stations"."organization_id" IS NULL AND "stations"."urn" IS NULL;

ALTER TABLE "stations" ALTER COLUMN "urn" SET NOT NULL;

-- Drop old unique constraints on (organizationId, label) and (userId, label), add unique on (urn)
ALTER TABLE "stations" DROP CONSTRAINT IF EXISTS "stations_organization_id_label_key";
ALTER TABLE "stations" DROP CONSTRAINT IF EXISTS "stations_user_id_label_key";
ALTER TABLE "stations" ADD CONSTRAINT "stations_urn_key" UNIQUE ("urn");
