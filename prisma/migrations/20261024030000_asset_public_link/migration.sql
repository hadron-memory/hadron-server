-- #1667 (cor:dmo:060:15): per-asset public-link opt-in. Additive. Every existing row backfills to FALSE
-- (the constant default), so no public link in use today keeps serving until its manager switches it on.
ALTER TABLE "assets" ADD COLUMN "public_link_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "asset_public_link_audits" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "previously_enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "asset_public_link_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_public_link_audits_asset_id_created_at_idx" ON "asset_public_link_audits"("asset_id", "created_at");
