#!/usr/bin/env bash
# Sync a local Hadron DB to the current schema WITHOUT wiping data.
#
# This is the dev-DB analogue of the `db:test-setup` script: it applies the
# schema with `prisma db push`, then runs post-push.sql to (re)create the
# objects Prisma's schema language can't model — the CHECK constraints AND
# the pgvector HNSW index (`node_embeddings_embedding_hnsw`).
#
# WHY NOT just `prisma db push`: Prisma cannot represent the HNSW index, so a
# bare push DROPS it every time (and never rebuilds it). It can also abort on
# a "possible data loss" prompt for the nullable `users` composite-unique even
# when no data is actually at risk. This script does push + post-push.sql so
# the HNSW index is rebuilt in the same breath. See the "Local Postgres setup"
# section in CLAUDE.md.
#
# For a from-scratch wipe + reseed, use scripts/reset-db.sh instead.
#
# Usage:
#   scripts/dev-setup.sh              # uses $DATABASE_URL (or .env) — the canonical dev DB
#   scripts/dev-setup.sh hadron       # short form: passes a DB name
#   DATABASE_URL=... scripts/dev-setup.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "" ]]; then
  export DATABASE_URL="postgresql://holger@localhost:5432/$1"
fi

# Pick up DATABASE_URL from .env if not already in the environment. `.env` is
# the single source of truth for which DB local dev uses (currently `hadron`).
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL not set and no .env found" >&2
  exit 1
fi

echo "→ Syncing schema (no wipe): $DATABASE_URL"
echo

# Pre-push transitions (#991). `db push` cannot add a REQUIRED column with no
# default to a populated table, so any change a migration would handle with a
# backfill has to be applied here first — otherwise this non-wiping path aborts.
# Every block in pre-push.sql is idempotent and guards on the state it changes,
# so this is a no-op on a fresh or already-current DB.
echo "→ Applying pre-push.sql (transitions db push can't perform itself)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/pre-push.sql
echo

# --accept-data-loss: the diff against an established dev DB always includes a
# DROP of the HNSW index (Prisma can't model it; post-push.sql rebuilds it
# below) and may re-propose the nullable users unique. Neither loses row data.
# A genuinely destructive change should be reviewed via `prisma migrate diff`
# or handled with a deliberate `pnpm db:dev-reset`.
pnpm prisma db push --accept-data-loss --skip-generate

echo
echo "→ Applying post-push.sql (CHECK constraints + pgvector HNSW index that db push drops)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/post-push.sql

echo
echo "Done. (Bare \`prisma db push\` will still report the HNSW index as drift — that's expected and handled here.)"
