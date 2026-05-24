-- Update the memories CHECK constraints to cover the new 'private' class.
--
-- 'private' shares the full (app_id, agent_id, user_id) scope shape with
-- 'personal' (single owner; not shareable). So it joins the "app_id required"
-- side of chk_memory_class_app_id and is added to chk_memory_personal_agent_id's
-- agent-id requirement.
--
-- NAMING DEBT: chk_memory_personal_agent_id now covers both 'personal' and
-- 'private'. The constraint name still says "personal" — renaming requires
-- migration churn we're not taking on here. Track as a follow-up: rename to
-- e.g. chk_memory_user_scoped_agent_id when next touching the constraint.
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
