#!/usr/bin/env bash
# Dump the Hadron DB from a remote host and restore it into a local DB.
#
# Usage:
#   scripts/restore-db-from-remote.sh                          # alpha → hadron
#   scripts/restore-db-from-remote.sh <ssh-host>               # <host> → hadron
#   scripts/restore-db-from-remote.sh <ssh-host> <local-db>    # <host> → <local-db>
#
# The remote runs PG 17, so the local client tools must also be PG 17 — the
# Homebrew `postgresql@17` keg is preferred over the default PATH entry (which
# may still be 14). The local DB is dropped and recreated, so any existing
# contents are destroyed.
#
# ── Migration-safety ─────────────────────────────────────────────────────────
# Local dev DBs are `prisma db push`-managed with NO migration history (see
# CLAUDE.md "Local Postgres setup"). So this script must NOT import prod's
# migration ledger or pin the local schema to prod's (usually-behind) state:
#   1. The remote dump excludes `_prisma_migrations` → prod's ledger never lands.
#   2. After the restore we run scripts/dev-setup.sh, which applies the working
#      schema.prisma onto the restored data (`db push --accept-data-loss`) and
#      rebuilds the pgvector HNSW index that a bare push drops.
# NOTE: columns encrypted under the prod HADRON_ENCRYPTION_KEY (is_encrypted
# memory content/assets, source tokens, AI API keys, GitHub App keys) come back
# as opaque bytes and will NOT decrypt locally. Do NOT copy the prod key here.

set -euo pipefail

SSH_HOST="${1:-alpha}"
LOCAL_DB="${2:-hadron}"
REMOTE_DB="hadron"
LOCAL_USER="holger"
LOCAL_HOST="localhost"
DUMP_DIR="$(cd "$(dirname "$0")/.." && pwd)/_hs_local/data"

# Prefer Homebrew's PG 17 binaries; fall back to whatever's on PATH.
PG17_BIN="/opt/homebrew/opt/postgresql@17/bin"
if [[ -x "$PG17_BIN/pg_restore" ]]; then
  PG_RESTORE="$PG17_BIN/pg_restore"
else
  PG_RESTORE="$(command -v pg_restore)"
fi

TS=$(date -u +%Y-%m-%d-%H%M)
DUMP_NAME="${REMOTE_DB}-${SSH_HOST}-${TS}.dump"
REMOTE_PATH="/root/backup/${DUMP_NAME}"
LOCAL_PATH="${DUMP_DIR}/${DUMP_NAME}"

mkdir -p "$DUMP_DIR"

echo "→ Dumping ${REMOTE_DB} on ${SSH_HOST} → ${REMOTE_PATH}"
echo "  (excluding _prisma_migrations — local dev is db-push-managed)"
ssh "root@${SSH_HOST}" "mkdir -p /root/backup && sudo -u postgres pg_dump -Fc --clean --if-exists --exclude-table=_prisma_migrations -d ${REMOTE_DB} > '${REMOTE_PATH}' && ls -la '${REMOTE_PATH}'"

echo
echo "→ Copying dump → ${LOCAL_PATH}"
scp "root@${SSH_HOST}:${REMOTE_PATH}" "${LOCAL_PATH}"

echo
echo "→ Dropping and recreating local DB: ${LOCAL_DB}"
# WITH (FORCE) terminates any lingering connections first. A stopped HTTP
# server is NOT enough: `pnpm dev` runs under `tsx watch`, which keeps the Node
# process — and its ~28-conn Prisma pool — alive, and a bare DROP DATABASE then
# fails with "database … is being accessed by other users". FORCE evicts them.
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -d postgres -c "DROP DATABASE IF EXISTS ${LOCAL_DB} WITH (FORCE);"
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -d postgres -c "CREATE DATABASE ${LOCAL_DB} OWNER ${LOCAL_USER};"

# pgvector must exist before the HNSW index restores; create it up front so the
# dump's own (idempotent) CREATE EXTENSION is a harmless no-op.
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -d "$LOCAL_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo
echo "→ Restoring with $($PG_RESTORE --version)"
"$PG_RESTORE" -d "$LOCAL_DB" -U "$LOCAL_USER" -h "$LOCAL_HOST" --no-owner --no-privileges "$LOCAL_PATH"

# Prod creates a few PARTIAL indexes (`… WHERE …`) via hand-edited migrations
# that schema.prisma declares as PLAIN (Prisma's schema language can't express a
# WHERE clause on @@index/@@unique). The `prisma db push` inside dev-setup.sh
# below can't see the partial index as matching its desired plain one, so it
# tries to CREATE a same-named index and dies with "relation … already exists".
# Only the indexes whose names match Prisma's auto-naming collide; the rest are
# custom-named raw-SQL indexes db push never touches. Drop the colliding ones
# here so db push recreates them as the plain versions the dev DB normally has
# (functionally equivalent locally — Postgres treats NULLs as distinct). If a
# future schema adds another Prisma-named partial index, append it to this list.
echo
echo "→ Dropping prod partial indexes that collide with db push (recreated plain below)"
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -d "$LOCAL_DB" -v ON_ERROR_STOP=1 \
  -c "DROP INDEX IF EXISTS memories_user_id_idx;" \
  -c "DROP INDEX IF EXISTS users_external_app_id_external_id_key;"

# Reconcile the restored (prod-state) schema with the working schema.prisma and
# rebuild the pgvector HNSW index that a bare `db push` drops. dev-setup.sh runs
# `prisma db push --accept-data-loss` + post-push.sql against the given DB.
echo
echo "→ Syncing restored DB to working schema.prisma (scripts/dev-setup.sh ${LOCAL_DB})"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"${SCRIPT_DIR}/dev-setup.sh" "$LOCAL_DB"

echo
echo "Done. Local '${LOCAL_DB}' restored from ${SSH_HOST} and synced to schema.prisma."
echo "Note: prod-encrypted columns won't decrypt locally (by design — see header)."
