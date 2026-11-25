-- #5125: the code-entry completion's pending-authorization handle and its wrong-entry count. Additive: a previous image
-- writes neither column and reads a dead code through redeemed_at, which the fifth wrong entry sets.
ALTER TABLE "auth_codes" ADD COLUMN "entry_handle" TEXT;
ALTER TABLE "auth_codes" ADD COLUMN "entry_failures" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "auth_codes_entry_handle_key" ON "auth_codes"("entry_handle");
