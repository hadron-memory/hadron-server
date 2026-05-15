-- 021-urn-composition: schema additions for soft-uninstall + online URN-shape migration.
--
-- See spec-kits/specs/021-urn-composition/data-model.md and
-- spec-kits/specs/021-urn-composition/contracts/migration.md for the contract.
--
-- Three groups of changes:
--   1) App.uninstalled_at + partial unique index on (urn) so the slug can be
--      reused after soft-uninstall.
--   2) urn_normalized_at + urn_migration_failed_reason transient columns on
--      every entity that stores a URN value (App, Memory, Agent) — gates parser
--      dispatch during the FR-032 online migration.
--   3) Partial indexes covering the migration job's batch-fetch query
--      (WHERE urn_normalized_at IS NULL AND urn_migration_failed_reason IS NULL).
--
-- Node is intentionally NOT touched here: Node stores `loc` (a memory-relative
-- path), not a full URN. The node's URN is computed at read time from
-- `memory.urn + "::" + loc` and renormalizes automatically once the parent
-- memory's URN is migrated.
--
-- Org URN shape is unchanged by spec 021 (always urn:org:<slug>, no `::`), so
-- Org is also intentionally NOT touched.

-- === App: soft-uninstall ============================================
ALTER TABLE "apps" ADD COLUMN "uninstalled_at" TIMESTAMPTZ NULL;

-- Replace the global @unique on App.urn with a partial unique index restricted
-- to active rows. This is what allows reinstall after soft-uninstall — the
-- uninstalled row stays addressable for audit history but doesn't block a new
-- install reusing the same slug.
--
-- Prisma's `@unique` on a field creates the index `apps_urn_key` via
-- CREATE UNIQUE INDEX (not as a named constraint). The DO block handles both
-- cases — constraint-promoted indexes and bare indexes — so this migration
-- applies cleanly across environments that may have been touched differently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'apps'::regclass AND conname = 'apps_urn_key'
  ) THEN
    EXECUTE 'ALTER TABLE "apps" DROP CONSTRAINT "apps_urn_key"';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'apps' AND indexname = 'apps_urn_key'
  ) THEN
    EXECUTE 'DROP INDEX "apps_urn_key"';
  END IF;
END $$;
CREATE UNIQUE INDEX "apps_urn_active_uniq"
  ON "apps" ("urn")
  WHERE "uninstalled_at" IS NULL;

-- === App / Memory / Agent: URN-shape migration gating columns ========
ALTER TABLE "apps"
  ADD COLUMN "urn_normalized_at"           TIMESTAMPTZ NULL,
  ADD COLUMN "urn_migration_failed_reason" TEXT        NULL;
ALTER TABLE "memories"
  ADD COLUMN "urn_normalized_at"           TIMESTAMPTZ NULL,
  ADD COLUMN "urn_migration_failed_reason" TEXT        NULL;
ALTER TABLE "agents"
  ADD COLUMN "urn_normalized_at"           TIMESTAMPTZ NULL,
  ADD COLUMN "urn_migration_failed_reason" TEXT        NULL;

-- === Partial indexes covering the migration job's batch-fetch query ====
-- WHERE urn_normalized_at IS NULL AND urn_migration_failed_reason IS NULL
-- is the work-queue predicate. The partial index keeps it index-served as
-- rows transition out of the queue.
CREATE INDEX "apps_urn_migration_pending_idx"
  ON "apps" ("id")
  WHERE "urn_normalized_at" IS NULL AND "urn_migration_failed_reason" IS NULL;
CREATE INDEX "memories_urn_migration_pending_idx"
  ON "memories" ("id")
  WHERE "urn_normalized_at" IS NULL AND "urn_migration_failed_reason" IS NULL;
CREATE INDEX "agents_urn_migration_pending_idx"
  ON "agents" ("id")
  WHERE "urn_normalized_at" IS NULL AND "urn_migration_failed_reason" IS NULL;
