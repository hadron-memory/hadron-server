-- Post-`prisma db push` invariants. `db push` introspects the Prisma schema
-- but doesn't apply CHECK constraints (Prisma doesn't model them at the
-- schema-language level). The migrations under prisma/migrations/ DO add
-- them, so applying the migrations to a real DB gives you these for free —
-- but `db push` for a dev/test DB does not.
--
-- Apply this file after every `db push` (the db:dev-setup / db:test-setup
-- scripts in package.json wire it up).

-- 005-agent-subscription: bidirectional invariant for personal memory.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_personal_visibility_user;
ALTER TABLE memories
  ADD CONSTRAINT chk_personal_visibility_user
  CHECK ((visibility = 'PERSONAL') = (user_id IS NOT NULL));

-- 008-agent-installation (extended by 023-app-shape): app_id is required
-- for class IN ('app', 'personal', 'private'), forbidden for class IN
-- ('system', 'knowledge', 'group'). 023 added 'group' as an org-scoped
-- class with no app_id (FR-024). 'private' (added 2026-05-24) shares the
-- (App, Agent, User) scope shape with 'personal' but is single-owner and
-- not shareable; an upcoming spec will pin down the encryption model.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_class_app_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_class_app_id
  CHECK (
    (class IN ('app', 'personal', 'private') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
  );

-- 023-app-shape FR-024: bidirectional invariant — class='group' ⇔
-- visibility='GROUP'.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_group_visibility;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_group_visibility
  CHECK (
    (class = 'group' AND visibility = 'GROUP')
    OR
    (class <> 'group' AND visibility <> 'GROUP')
  );

-- 023-app-shape FR-025: group memory has no single owner.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_group_no_owner;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_group_no_owner
  CHECK (class <> 'group' OR user_id IS NULL);

-- 023-app-shape FR-004 / FR-032: personal memory carries the (App, Agent,
-- User) scope. user_memory_of_agent_id (legacy column name; semantically
-- agent_id) is required-non-null for personal class. 'private' (added
-- 2026-05-24) shares the same scope shape and is covered here too.
--
-- NAMING DEBT: the constraint name still says "personal" but now also covers
-- 'private'. Rename to e.g. chk_memory_user_scoped_agent_id when next touching
-- this constraint.
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_personal_agent_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_personal_agent_id
  CHECK (class NOT IN ('personal', 'private') OR user_memory_of_agent_id IS NOT NULL);
