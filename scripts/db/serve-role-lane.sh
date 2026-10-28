#!/usr/bin/env bash
# CI helpers for the serve-role lane (#2413 S3, .github/workflows/migration-smoke-test.yml).
# Each subcommand asserts its own expectation and exits non-zero when it does not hold.
#
#   serve-role-lane.sh fresh-order   role BEFORE the first migrate: the ledger gets granted, verify must say so,
#                                    and re-running the grants file must fix it
#   serve-role-lane.sh mutants       mutation proof: the lane must FAIL when the grants file loses its
#                                    ALTER DEFAULT PRIVILEGES lines, or one table's grant
#
# Env: ADMIN_URL (a superuser, ONLY for CREATE/DROP DATABASE), OWNER_URL (the non-superuser migrator that owns
# the main lane database), SERVE_URL (the serve role on that same database), SERVE_ROLE.
# Nothing here echoes a URL: psql/pnpm output is the only output, and psql never prints its connection string.
set -euo pipefail

: "${ADMIN_URL:?}" "${OWNER_URL:?}" "${SERVE_URL:?}" "${SERVE_ROLE:?}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
grants="$repo/prisma/runtime-role.sql"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# `<scheme>://user:pw@host:port/<db>` with the database swapped.
with_db() { echo "${1%/*}/$2"; }
psql_q() { psql "$1" -v ON_ERROR_STOP=1 -q -X "${@:2}"; }
verify() { MIGRATE_DATABASE_URL="$1" pnpm -s tsx "$here/verify-runtime-role.ts" --role "$SERVE_ROLE"; }

fresh_db() {
  psql_q "$ADMIN_URL" -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" -c "CREATE DATABASE $1 OWNER $(psql_q "$OWNER_URL" -Atc 'select current_user')"
  psql_q "$(with_db "$ADMIN_URL" "$1")" -c 'CREATE EXTENSION IF NOT EXISTS vector'
}

expect_fail() { # <what> <command...>
  local what="$1"; shift
  if "$@" >"$tmp/out" 2>&1; then
    cat "$tmp/out"; echo "::error::MUTANT SURVIVED: $what did not make the lane fail"; exit 1
  fi
  echo "ok: the lane fails when $what"
}

case "${1:-}" in
fresh-order)
  db=hadron_serve_fresh
  url="$(with_db "$OWNER_URL" "$db")"
  fresh_db "$db"
  psql_q "$url" -v "serve_role=$SERVE_ROLE" -f "$grants"
  psql_q "$url" -c 'CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY)' -c 'CREATE TABLE later_table (id serial PRIMARY KEY)'
  if verify "$url" >"$tmp/out" 2>&1; then cat "$tmp/out"; echo "::error::verify passed although the ledger was granted by default privileges"; exit 1; fi
  grep -q 'migrations-table-granted' "$tmp/out" || { cat "$tmp/out"; echo "::error::verify failed for the wrong reason"; exit 1; }
  echo "ok: role-before-migrate: verify names the granted ledger"
  psql_q "$url" -v "serve_role=$SERVE_ROLE" -f "$grants"
  verify "$url"
  echo "ok: role-before-migrate: re-running the grants file after migrate fixes it"
  ;;
mutants)
  # 1. No ALTER DEFAULT PRIVILEGES: a table created after the grants is unusable, and verify says so.
  sed -e '/ALTER DEFAULT PRIVILEGES/d' "$grants" >"$tmp/no-default-privs.sql"
  cmp -s "$grants" "$tmp/no-default-privs.sql" && { echo "::error::mutant 1 did not change the grants file"; exit 1; }
  db=hadron_serve_mutant
  url="$(with_db "$OWNER_URL" "$db")"
  fresh_db "$db"
  psql_q "$url" -v "serve_role=$SERVE_ROLE" -f "$tmp/no-default-privs.sql"
  psql_q "$url" -c 'CREATE TABLE later_table (id serial PRIMARY KEY)'
  expect_fail 'the grants file has no ALTER DEFAULT PRIVILEGES' verify "$url"
  grep -q 'missing-table-privilege' "$tmp/out" || { cat "$tmp/out"; echo "::error::mutant 1 failed for the wrong reason"; exit 1; }

  # 2. One table grant missing: the real smoke and the verifier both fail. Start from a clean slate for that
  #    table, since the real grants already gave it DML.
  sed -e "s/AND c.relname <> '_prisma_migrations'/AND c.relname NOT IN ('_prisma_migrations', 'nodes')/" "$grants" >"$tmp/no-nodes.sql"
  cmp -s "$grants" "$tmp/no-nodes.sql" && { echo "::error::mutant 2 did not change the grants file"; exit 1; }
  psql_q "$OWNER_URL" -c "REVOKE ALL ON TABLE nodes FROM $SERVE_ROLE"
  psql_q "$OWNER_URL" -v "serve_role=$SERVE_ROLE" -f "$tmp/no-nodes.sql"
  expect_fail 'one table grant (nodes) is missing from the grants file' verify "$OWNER_URL"
  expect_fail 'one table grant (nodes) is missing from the grants file (smoke)' \
    env MIGRATE_DATABASE_URL="$OWNER_URL" SERVE_DATABASE_URL="$SERVE_URL" pnpm -s tsx "$here/serve-role-smoke.ts"
  # Restore, and prove the restore is whole.
  psql_q "$OWNER_URL" -v "serve_role=$SERVE_ROLE" -f "$grants"
  verify "$OWNER_URL"
  ;;
*)
  echo "usage: $0 fresh-order|mutants" >&2
  exit 2
  ;;
esac
