-- #653: allow `knowledge` and `group` class memories to be attached to an App.
--
-- The `chk_memory_class_app_id` constraint previously FORBADE app_id on
-- system/knowledge/group. This moves knowledge + group to the app_id-OPTIONAL
-- branch (alongside personal/private), so a shared knowledge or group memory
-- can be provisioned inside an App (app_id set) or stand free (app_id NULL).
-- `class='system'` stays app_id-forbidden — an agent's own definition is never
-- app-scoped.
--
-- Kept in sync with prisma/post-push.sql and src/test/globalSetup.ts (the CHECK
-- lives in three places; never add it with IF NOT EXISTS — a DROP+ADD is the
-- only way to replace a CHECK).
ALTER TABLE "memories"
  DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_class_app_id"
  CHECK (
    (class = 'app' AND app_id IS NOT NULL)
    OR (class = 'system' AND app_id IS NULL)
    OR (class IN ('knowledge', 'group', 'personal', 'private'))
  );
