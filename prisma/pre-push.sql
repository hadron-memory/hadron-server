-- Pre-`prisma db push` transitions.
--
-- The dev and test DBs carry NO migration history (CLAUDE.md, "Local Postgres
-- setup"): they are built and synced with `prisma db push`. That works for
-- ordinary additive changes, but `db push` cannot add a REQUIRED column with no
-- default to a table that already has rows — Postgres rejects it — so a schema
-- change that migration-managed databases handle with a backfill would abort
-- `pnpm db:dev-setup`, the documented non-wiping path, and leave a developer
-- choosing between discarding their DB and hand-patching it.
--
-- This file runs BEFORE the push and performs those transitions itself. Every
-- block MUST be idempotent and MUST guard on the state it is transitioning
-- from, so it is a no-op on a fresh DB, on an already-migrated DB, and on a
-- second run. After it has run, `db push` sees the column already in its target
-- shape and does nothing.
--
-- Wired into scripts/dev-setup.sh and the db:test-setup script, both of which
-- run this → push → post-push.sql.

-- ─── #991: workers.slug ─────────────────────────────────────────────────────
-- The DO block below is DUPLICATED VERBATIM from the
-- 20260815120000_worker_slug migration (migration-managed DBs get it there).
-- Both guard on the column's absence, so whichever runs first wins. Change one,
-- change the other. The derivation mirrors `deriveSlugFromName` step for step
-- and is pinned by a cross-language test (resolvers.workerUrn.test.ts).
DO $$
DECLARE
  w         RECORD;
  base      TEXT;
  candidate TEXT;
  n         INT;
BEGIN
  -- Only act on an existing `workers` table that has no `slug` column yet.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'workers'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'workers' AND column_name = 'slug'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE workers ADD COLUMN slug TEXT;

  FOR w IN
    SELECT id, app_id, name FROM workers WHERE slug IS NULL
    ORDER BY app_id, created_at, id
  LOOP
    base := COALESCE(
      NULLIF(
        regexp_replace(
          left(
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(btrim(w.name)), '[^a-z0-9._-]+', '-', 'g'),
                '^[._-]+', ''),
              '[._-]+$', ''),
            64),
          '[._-]+$', ''),
        ''),
      'worker');

    n := 1;
    candidate := base;
    WHILE EXISTS (
      SELECT 1 FROM workers x WHERE x.app_id = w.app_id AND x.slug = candidate
    ) LOOP
      n := n + 1;
      candidate := regexp_replace(
        left(base, 64 - length('-' || n::text)), '[._-]+$', ''
      ) || '-' || n::text;
    END LOOP;

    UPDATE workers SET slug = candidate WHERE id = w.id;
  END LOOP;

  ALTER TABLE workers ALTER COLUMN slug SET NOT NULL;
END $$;
