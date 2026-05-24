-- Update the memories CHECK constraints to cover the new 'private' class.
--
-- 'private' shares the (app_id, agent_id, user_id) scope shape with 'personal'
-- per the schema doc-string (secure per-user records keyed on (app_id, user_id);
-- single owner; not shareable). So it joins the "app_id required" side of
-- chk_memory_class_app_id and is added to chk_memory_personal_agent_id's
-- agent-id requirement.
--
-- This migration must follow 20260524120000_add_private_memory_class in a
-- separate transaction because Postgres forbids referencing an enum value in
-- the same transaction that added it.

ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_class_app_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_class_app_id
  CHECK (
    (class IN ('app', 'personal', 'private') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
  );

ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_personal_agent_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_personal_agent_id
  CHECK (class NOT IN ('personal', 'private') OR user_memory_of_agent_id IS NOT NULL);
