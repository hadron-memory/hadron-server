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

# Keep raw command output private and short-lived: pg/Prisma may echo URLs.
# Report only a numeric exit status and an allowlisted Prisma error-code shape.
# These diagnostics retain failure identity without attempting to scrub arbitrary
# database messages (which can contain decoded passwords or multiline secrets).
startup_umask=$(umask)
umask 077
startup_log=$(mktemp "${TMPDIR:-/tmp}/hadron-start.XXXXXX")
umask "$startup_umask"
trap 'rm -f "$startup_log"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 131' QUIT
run_setup() {
  setup_phase=$1
  setup_url=$2
  shift 2
  if DATABASE_URL="$setup_url" "$@" >"$startup_log" 2>&1; then
    return 0
  else
    setup_exit=$?
    setup_prisma=$(sed -n 's/^Error: \(P[0-9][0-9][0-9][0-9]\).*$/\1/p' "$startup_log" | head -n 1)
    echo "$setup_phase exit=$setup_exit prisma=${setup_prisma:-unknown}" >&2
    return 1
  fi
}
run_setup db.runtime_role.generate_failed "$DATABASE_URL" pnpm prisma generate || exit 1
run_setup db.runtime_role.migrate_failed "$migration_url" pnpm prisma migrate deploy || exit 1
# Default ACLs can grant this table when Prisma first creates it. Revoke only
# after migrate, before verification, using the owner connection (no psql).
run_setup db.runtime_role.revoke_failed "$migration_url" pnpm tsx scripts/db/revoke-runtime-migrations.ts || exit 1
# R3: verifier failure is deliberately warn-only during phase 1.
if ! run_setup db.runtime_role.verify_failed "$migration_url" pnpm tsx scripts/db/verify-runtime-role.ts; then
  echo 'db.runtime_role.verify_warning: phase-1 warning; continuing' >&2
fi
rm -f "$startup_log"
trap - EXIT INT TERM HUP QUIT
unset migration_url setup_url startup_log startup_umask
exec pnpm tsx src/index.ts
