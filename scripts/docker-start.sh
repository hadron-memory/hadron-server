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
# #3770: a migration whose preflight REFUSES on data (SQLSTATE HDPRF, see
# scripts/db/resolve-refused-migrations.ts) must not become an outage: a failed
# migration is re-tried into P3009 on every restart. Mark each refused migration
# rolled back, say so once, and serve the schema that exists; the next boot tries
# it again. Any other failure, or one we cannot classify, still stops boot.
# Never inherit a refusal list from outside: only this boot's own refusals reach the server.
unset HADRON_MIGRATIONS_REFUSED
migrate_attempts=0
while ! run_setup db.runtime_role.migrate_failed "$migration_url" pnpm prisma migrate deploy; do
  migrate_attempts=$((migrate_attempts + 1))
  [ "$migrate_attempts" -le 3 ] || exit 1
  case $setup_prisma in P3009|P3018) ;; *) exit 1 ;; esac
  failed_code=$setup_prisma
  refused=$(DATABASE_URL="$migration_url" pnpm tsx scripts/db/resolve-refused-migrations.ts 2>/dev/null) || exit 1
  [ -n "$refused" ] || exit 1
  # Only well-formed migration names are acted on or printed (command output may carry URLs).
  for refused_name in $refused; do
    case $refused_name in
      *[!A-Za-z0-9_]*) exit 1 ;;
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_?*) ;;
      *) exit 1 ;;
    esac
  done
  for refused_name in $refused; do
    run_setup db.migration.resolve_failed "$migration_url" pnpm prisma migrate resolve --rolled-back "$refused_name" || exit 1
    # P3018: the refusal just happened in THIS deploy, so say so (once per migration per boot).
    # P3009 is a failure an earlier boot left: clear it silently and try the migration again below.
    if [ "$failed_code" = P3018 ]; then
      HADRON_MIGRATIONS_REFUSED="${HADRON_MIGRATIONS_REFUSED:+$HADRON_MIGRATIONS_REFUSED }$refused_name"
      export HADRON_MIGRATIONS_REFUSED
      echo "db.migration.refused_preflight migration=$refused_name action=rolled_back_and_serving_existing_schema: later migrations were not applied; fix the data it reported, the next boot retries" >&2
    fi
  done
  # P3018: running it again would only refuse again. P3009: the data may have been repaired since, so try once more.
  [ "$failed_code" = P3009 ] || break
done
# Default ACLs can grant this table when Prisma first creates it. Revoke only
# after migrate, before verification, using the owner connection (no psql).
run_setup db.runtime_role.revoke_failed "$migration_url" pnpm tsx scripts/db/revoke-runtime-migrations.ts || exit 1
# #3668: the platform's actions are written ONLY here, as the owner, never by the running server. Idempotent; the list is empty in S1a.
run_setup db.actions_upsert_failed "$migration_url" pnpm tsx scripts/db/upsert-actions.ts || exit 1
# R3: verifier failure is deliberately warn-only during phase 1.
if ! run_setup db.runtime_role.verify_failed "$migration_url" pnpm tsx scripts/db/verify-runtime-role.ts; then
  echo 'db.runtime_role.verify_warning: phase-1 warning; continuing' >&2
fi
rm -f "$startup_log"
trap - EXIT INT TERM HUP QUIT
unset migration_url setup_url startup_log startup_umask
exec pnpm tsx src/index.ts
