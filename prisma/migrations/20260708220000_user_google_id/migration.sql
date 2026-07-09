-- Issue #581 — Sign-in-with-Google. Stores the Google account id (the OIDC
-- `sub` claim) so a returning Google user resolves to the same User row.
-- Text, not bigint: Google documents `sub` as an opaque string.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "google_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");
