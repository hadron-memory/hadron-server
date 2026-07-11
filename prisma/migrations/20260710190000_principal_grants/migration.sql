-- PrincipalGrant: individual action grants — the additive half of the
-- grant model (design:grant-model, P2b). See prisma/schema.prisma model
-- PrincipalGrant.

-- CreateTable
CREATE TABLE "principal_grants" (
    "id" TEXT NOT NULL,
    "principal_type" TEXT NOT NULL DEFAULT 'USER',
    "principal_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "principal_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "principal_grants_principal_id_organization_id_idx" ON "principal_grants"("principal_id", "organization_id");

-- CreateIndex
CREATE INDEX "principal_grants_organization_id_idx" ON "principal_grants"("organization_id");

-- AddForeignKey
ALTER TABLE "principal_grants" ADD CONSTRAINT "principal_grants_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "principal_grants" ADD CONSTRAINT "principal_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
