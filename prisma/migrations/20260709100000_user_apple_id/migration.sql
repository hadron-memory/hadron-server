-- Issue #584 — Sign in with Apple. Adds the APPLE identity provider and the
-- Apple account id (the team-scoped `sub` claim) so a returning Apple user
-- resolves to the same User row.
--
-- Single file is safe: the enum-add + CHECK two-migration rule (Postgres
-- can't REFERENCE a fresh enum value in the same transaction) doesn't bite
-- here — nothing below uses the new value.

-- AlterEnum
ALTER TYPE "IdentityProvider" ADD VALUE 'APPLE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "apple_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_apple_id_key" ON "users"("apple_id");
