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

-- 008-agent-installation: app_id is required for class IN ('app', 'personal'),
-- forbidden for class IN ('system', 'knowledge').
ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS chk_memory_class_app_id;
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_class_app_id
  CHECK (
    (class IN ('app', 'personal') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge') AND app_id IS NULL)
  );
