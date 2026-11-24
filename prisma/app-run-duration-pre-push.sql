-- #855: app_runs.duration_ms is a STORED GENERATED column (prisma/migrations/20261124020000_app_runs_duration_ms), which
-- schema.prisma can only model as a plain nullable BigInt. Prisma reads the generation expression as a column default,
-- so `prisma db push` against a database where the column is already GENERATED tries ALTER COLUMN ... DROP DEFAULT and
-- Postgres refuses ("column duration_ms of relation app_runs is a generated column"), which would break the documented
-- non-wiping `pnpm db:dev-setup` on its second run. So before the push, drop the column when it is generated: it holds
-- nothing but a value computed from started_at and finished_at, and prisma/post-push.sql re-creates it (generated, with
-- its index) after the push. A no-op on a fresh database, on a plain or absent column, and on a table that is absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = to_regclass('app_runs') AND attname = 'duration_ms' AND NOT attisdropped AND attgenerated <> ''
  ) THEN
    ALTER TABLE app_runs DROP COLUMN duration_ms;
  END IF;
END $$;
