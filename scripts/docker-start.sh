#!/bin/sh
# Phase 1 of #2413: migration/owner credential is never used by the server.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo 'db.runtime_role.database_url_missing' >&2
  exit 1
fi
if [ -z "${MIGRATE_DATABASE_URL:-}" ]; then
  echo 'db.runtime_role.owner_serving: MIGRATE_DATABASE_URL unset; legacy single-role boot' >&2
fi
migration_url=${MIGRATE_DATABASE_URL:-$DATABASE_URL}
# Do not pass the owner credential to the serving process as a second env var.
unset MIGRATE_DATABASE_URL

# Prisma failure messages may include connection strings. Only phase labels go
# to boot logs; operator diagnostics use the owner-only migration procedure.
if ! pnpm prisma generate >/dev/null 2>&1; then
  echo 'db.runtime_role.generate_failed' >&2
  exit 1
fi
if ! DATABASE_URL="$migration_url" pnpm prisma migrate deploy >/dev/null 2>&1; then
  echo 'db.runtime_role.migrate_failed' >&2
  exit 1
fi
# Default ACLs can grant this table when Prisma first creates it. Revoke only
# after migrate, before verification, using the owner connection (no psql).
if ! DATABASE_URL="$migration_url" pnpm tsx scripts/db/revoke-runtime-migrations.ts >/dev/null 2>&1; then
  echo 'db.runtime_role.revoke_failed' >&2
  exit 1
fi
# R3: verifier failure is deliberately warn-only during phase 1.
if ! DATABASE_URL="$migration_url" pnpm tsx scripts/db/verify-runtime-role.ts >/dev/null 2>&1; then
  echo 'db.runtime_role.verify_failed: phase-1 warning; continuing' >&2
fi
unset migration_url
exec pnpm tsx src/index.ts
