-- 034-memory-class-access (leaner MVP): user-creatable, owner-only
-- personal/private memories, including the free-standing (no app, no agent)
-- shape. A personal/private memory still belongs to an org *container*
-- (organization_id stays NOT NULL); access is owner-only by class, so the org
-- grants no one access. Org-less memories + the enum/`Memory.type` removal are
-- deferred follow-ups. This migration only relaxes the ownership/scope CHECKs.
--
-- Dev/test DBs are managed via `prisma db push` + `prisma/post-push.sql`; this
-- migration is for the production `prisma migrate deploy` path and MUST stay in
-- sync with post-push.sql and src/test/globalSetup.ts.

-- Defensive backfill: the `private` class became creatable only in this spec, so
-- production should have no `private` rows — but any that exist (introduced
-- 2026-05-24) carried user_id IS NULL under the old visibility-keyed constraint,
-- which the new class-keyed constraint forbids. Best-effort assign the owner from
-- created_by when it references a real user (guarded to avoid an FK violation).
-- A remaining nonconforming row would be a genuine data defect and SHOULD fail
-- the constraint loudly rather than be silently mis-owned.
UPDATE "memories" m
   SET "user_id" = m."created_by"
 WHERE m."class" = 'private'
   AND m."user_id" IS NULL
   AND m."created_by" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = m."created_by");

-- Ownership is class-based (not visibility-based): personal/private ⇔ owner.
-- Replaces the old `(visibility='PERSONAL') = (user_id IS NOT NULL)` so that a
-- `private` memory (visibility='PRIVATE') can carry an owner.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_personal_visibility_user";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_personal_visibility_user"
  CHECK (("class" IN ('personal', 'private')) = ("user_id" IS NOT NULL));

-- app_id required only for class='app'; forbidden for system/knowledge/group;
-- OPTIONAL for personal/private (set when app-scoped, NULL when free-standing).
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_class_app_id"
  CHECK (
    (class = 'app' AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
    OR (class IN ('personal', 'private'))
  );

-- Agent scope required only for an app-scoped personal/private memory;
-- free-standing (app_id NULL) is exempt. Deliberately NOT coupling app_id ⇔
-- agent: a legacy pre-008 row may be app_id NULL + agent set, and the MCP gate
-- has explicit handling + a regression test for that shape.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_personal_agent_id";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_personal_agent_id"
  CHECK (class NOT IN ('personal', 'private') OR app_id IS NULL OR user_memory_of_agent_id IS NOT NULL);
