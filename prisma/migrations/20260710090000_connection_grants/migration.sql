-- ConnectionGrant: user→App scoped delegation on a user-owned connection
-- (spec-042 Track B, #593). See prisma/schema.prisma model ConnectionGrant.

-- CreateTable
CREATE TABLE "connection_grants" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "grantee_app_id" TEXT NOT NULL,
    "granted_by_user_id" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "connection_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_grants_connection_id_grantee_app_id_idx" ON "connection_grants"("connection_id", "grantee_app_id");

-- CreateIndex
CREATE INDEX "connection_grants_grantee_app_id_idx" ON "connection_grants"("grantee_app_id");

-- CreateIndex
CREATE INDEX "connection_grants_granted_by_user_id_idx" ON "connection_grants"("granted_by_user_id");

-- AddForeignKey
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "exchange_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_grantee_app_id_fkey" FOREIGN KEY ("grantee_app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
