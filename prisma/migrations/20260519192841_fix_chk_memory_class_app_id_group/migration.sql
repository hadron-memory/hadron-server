-- Fix a real drift between prod and the canonical schema: the
-- `chk_memory_class_app_id` constraint on prod is the pre-spec-023 form,
-- missing the `'group'` value in the second `IN (...)` list. The
-- 20260516233753_023_app_shape_additions migration was supposed to
-- extend this constraint (and is marked applied in `_prisma_migrations`)
-- but its ALTER never took effect on prod. Zero `class='group'` memories
-- exist on prod yet, so the bug hasn't bitten — but the next group-class
-- INSERT would fail.
--
-- On a fresh DB, the baseline already includes the correct form. This
-- migration's DROP/ADD pair is then idempotent: the DROP removes the
-- identical constraint, the ADD recreates it. The DDL still executes
-- (it's not a true no-op), but the end state is unchanged.
--
-- Why DROP+ADD in a single ALTER, not the `NOT VALID` + `VALIDATE`
-- pattern: PostgreSQL evaluates all actions of a single ALTER TABLE
-- atomically under one lock. The `memories` table on prod has ~50 rows
-- so validation is microseconds; the lock-avoidance benefits of `NOT
-- VALID` + separate `VALIDATE CONSTRAINT` only matter for large tables.
-- If we ever need to add a CHECK to a multi-million-row table, the
-- correct shape is **two separate migrations** (one ADD ... NOT VALID,
-- the next VALIDATE) so the validating statement runs outside the
-- constraint-creating transaction — same-transaction VALIDATE still
-- holds ACCESS EXCLUSIVE.

ALTER TABLE "memories"
  DROP CONSTRAINT IF EXISTS "chk_memory_class_app_id",
  ADD CONSTRAINT "chk_memory_class_app_id" CHECK (
    (class IN ('app', 'personal') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
  );
