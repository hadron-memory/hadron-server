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
-- No index yet — Phase 2c adds one alongside the owner queries.
ALTER TABLE "apps" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "agents" ADD COLUMN "owner_user_id" TEXT;
ALTER TABLE "memories" ADD COLUMN "owner_user_id" TEXT;

ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
