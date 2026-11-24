-- CreateTable
CREATE TABLE "owner_limits" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "owner_user_id" TEXT,
    "key" TEXT NOT NULL,
    "limit_value" BIGINT,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "owner_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "owner_limits_organization_id_key_key" ON "owner_limits"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "owner_limits_owner_user_id_key_key" ON "owner_limits"("owner_user_id", "key");

-- AddForeignKey
ALTER TABLE "owner_limits" ADD CONSTRAINT "owner_limits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_limits" ADD CONSTRAINT "owner_limits_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #5009 (Billing A7a): the owner-limit rows. One source, shared verbatim with migration 20261124163000_owner_limits.
-- Idempotent: drop-then-add.
ALTER TABLE owner_limits DROP CONSTRAINT IF EXISTS chk_owner_limits_one_owner;
ALTER TABLE owner_limits ADD CONSTRAINT chk_owner_limits_one_owner
  CHECK (num_nonnulls(organization_id, owner_user_id) = 1);
ALTER TABLE owner_limits DROP CONSTRAINT IF EXISTS chk_owner_limits_shape;
ALTER TABLE owner_limits ADD CONSTRAINT chk_owner_limits_shape CHECK (
  key <> '' AND (limit_value IS NULL OR limit_value >= 0)
  AND btrim(source_type) <> '' AND btrim(source_id) <> '' AND btrim(note) <> ''
);
