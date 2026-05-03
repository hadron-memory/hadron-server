#!/usr/bin/env bash
# Reset a local Hadron DB from scratch and run the seed.
#
# Usage:
#   scripts/reset-db.sh                     # uses $DATABASE_URL (or .env)
#   scripts/reset-db.sh hadron_dev          # short form: passes a DB name
#   DATABASE_URL=... scripts/reset-db.sh    # full URL via env
#
# The DB user is the host's `holger` Postgres role (see CLAUDE.md). Schema
# applied via `prisma db push --force-reset`, then post-push.sql adds the
# CHECK constraints that `db push` skips, then prisma/seed.ts runs.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "" ]]; then
  export DATABASE_URL="postgresql://holger@localhost:5432/$1"
fi

# Pick up DATABASE_URL from .env if not already in the environment.
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL not set and no .env found" >&2
  exit 1
fi

echo "→ Resetting DB: $DATABASE_URL"
echo

pnpm prisma db push --force-reset --accept-data-loss --skip-generate

echo
echo "→ Applying post-push.sql (CHECK constraints that db push skips)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/post-push.sql

echo
echo "→ Running seed.ts"
pnpm tsx prisma/seed.ts

echo
echo "Done."
