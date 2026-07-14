-- spec 047 Phase 2b: additive `owner_user_id` on App / Agent / Memory.
--
-- The user TENANT owner of a user-owned entity (owner-namespace `@<handle>`
-- URN). Additive and UNUSED for now — nullable, no CHECK. The exactly-one-of
-- `organization_id`/`owner_user_id` XOR, the nullable-`organization_id`
-- migration, `createAgent`/install user-owner, the owner-or-org authz branches,
-- and the `@<handle>` URN composition all land together in Phase 2c (they can't
-- be split safely — nullable-org couples with the authz surface).
--
-- On Memory this is DISTINCT from `user_id` (the personal/private strict-owner).
-- Each FK column is indexed so a user delete doesn't sequential-scan the child
-- tables (and to back Phase 2c's owner queries).
--
-- ON DELETE SET NULL for now (not CASCADE): 2b does NOT yet enforce the
-- org-vs-owner XOR, and organization_id is still required, so a row can hold
-- BOTH — CASCADE would hard-delete an org's entity when the user is deleted.
-- SET NULL just clears the (unused) owner instead. Phase 2c switches this to
-- CASCADE once the XOR guarantees an owner-set row is org-less (a genuinely
-- user-owned entity, which SHOULD go when its sole owner does).
ALTER TABLE "apps" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "agents" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "memories" ADD COLUMN "owner_user_id" TEXT;

CREATE INDEX "apps_owner_user_id_idx" ON "apps"("owner_user_id");
CREATE INDEX "agents_owner_user_id_idx" ON "agents"("owner_user_id");
CREATE INDEX "memories_owner_user_id_idx" ON "memories"("owner_user_id");

ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
