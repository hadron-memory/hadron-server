-- Fix a real drift between prod and the canonical schema: the
-- `chk_memory_class_app_id` constraint on prod is the pre-spec-023 form,
-- missing the `'group'` value in the second `IN (...)` list. The
-- 20260516233753_023_app_shape_additions migration was supposed to
-- extend this constraint (and is marked applied in `_prisma_migrations`)
-- but its ALTER never took effect on prod. Zero `class='group'` memories
-- exist on prod yet, so the bug hasn't bitten — but the next group-class
-- INSERT would fail.
--
-- On a fresh DB, the baseline already includes the correct form, so the
-- DROP/ADD pair here is a no-op (DROP IF EXISTS + identical re-add).
-- On prod, it replaces the broken constraint with the correct one.

ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id";
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_class_app_id" CHECK (
    (class IN ('app', 'personal') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
  );
