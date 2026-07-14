-- spec 047 Phase 2c: App / Agent / Memory become user-OR-org owned.
--
-- (1) `organization_id` becomes nullable (a user-owned entity has no org).
-- (2) The `owner_user_id` FK flips ON DELETE SET NULL -> CASCADE: a genuinely
--     user-owned entity (org NULL, owner set) should go when its sole owner is
--     deleted. The 2b interim used SET NULL only because the XOR wasn't enforced
--     yet; now it is (below), so a user-owned row can never also hold an org.
-- (3) The org-XOR-owner CHECK: EXACTLY ONE of `organization_id` / `owner_user_id`
--     is set. Prisma can't model a CHECK, so it's kept in sync with
--     prisma/post-push.sql + src/test/globalSetup.ts. Existing rows (org set,
--     owner NULL) satisfy it, so the constraint validates cleanly.

-- (2) owner FK: SET NULL -> CASCADE (drop + re-add)
ALTER TABLE "apps" DROP CONSTRAINT "apps_owner_user_id_fkey";
ALTER TABLE "agents" DROP CONSTRAINT "agents_owner_user_id_fkey";
ALTER TABLE "memories" DROP CONSTRAINT "memories_owner_user_id_fkey";

-- (1) organization_id nullable
ALTER TABLE "apps" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "agents" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "memories" ALTER COLUMN "organization_id" DROP NOT NULL;

ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (3) org-XOR-owner: exactly one owner
ALTER TABLE "apps" ADD CONSTRAINT "chk_app_owner_xor" CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
ALTER TABLE "agents" ADD CONSTRAINT "chk_agent_owner_xor" CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
ALTER TABLE "memories" ADD CONSTRAINT "chk_memory_owner_xor" CHECK (("organization_id" IS NULL) <> ("owner_user_id" IS NULL));
