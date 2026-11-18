#!/usr/bin/env bash
# Build a database matching origin/main, the way production looks just before a deploy: db push of main's
# schema, main's raw-SQL invariants, and main's migration list marked applied. Leaves the PR's prisma/ tree
# in place for the `migrate deploy` that follows. Shared by both jobs of migration-smoke-test.yml.
# Reads DATABASE_URL (the connection the baseline objects are created AS).
set -euo pipefail
# Save PR state, restore main's prisma/ for baseline setup.
# Note: `git checkout origin/main -- prisma/` only restores files
# that exist on main. Migration directories newly added on the PR
# branch would survive and pollute the seeding loop below — they'd
# be pre-marked as applied and `migrate deploy` would no-op.
# `rm -rf prisma` first so only main's files remain.
mkdir -p /tmp/pr-prisma
cp -r prisma /tmp/pr-prisma/
rm -rf prisma
git checkout origin/main -- prisma/
pnpm prisma db push --skip-generate --accept-data-loss
# db push omits functions/triggers/CHECKs from already-applied SQL
# migrations. Restore MAIN's invariants before claiming its migration
# list is applied, so a new migration may depend on those objects.
# This must run before restoring the PR tree below: replaying PR SQL
# here would mask defects in the migration being tested.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/post-push.sql

# Seed `_prisma_migrations` with main's migration list so
# Prisma considers them already-applied. PSQL is available
# via the postgres service.
psql "$DATABASE_URL" -c "
  CREATE TABLE IF NOT EXISTS \"_prisma_migrations\" (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  );"
for m in prisma/migrations/*/; do
  name=$(basename "$m")
  [ "$name" = "migration_lock.toml" ] && continue
  checksum=$(sha256sum "$m/migration.sql" | awk '{print $1}')
  psql "$DATABASE_URL" -c \
    "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
     VALUES (gen_random_uuid()::text, '$checksum', now(), '$name', 1);" >/dev/null
done

# Restore PR's prisma/ for the deploy step
rm -rf prisma
mv /tmp/pr-prisma/prisma .
