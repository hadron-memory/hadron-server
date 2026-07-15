-- cor:acl:080:04 (#610) — opt-in marketplace catalogue flag on Organization,
-- Memory, and Agent. Additive, non-null with a DEFAULT so existing rows
-- backfill to false (unlisted). Distinct from visibility=PUBLIC: this governs
-- advertisement (catalogue browse), not access.
ALTER TABLE "organizations" ADD COLUMN "listed_on_marketplace" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "memories" ADD COLUMN "listed_on_marketplace" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agents" ADD COLUMN "listed_on_marketplace" BOOLEAN NOT NULL DEFAULT false;
