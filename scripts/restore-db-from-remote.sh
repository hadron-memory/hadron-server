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
ssh "root@${SSH_HOST}" "mkdir -p /root/backup && sudo -u postgres pg_dump -Fc --clean --if-exists -d ${REMOTE_DB} > '${REMOTE_PATH}' && ls -la '${REMOTE_PATH}'"

echo
echo "→ Copying dump → ${LOCAL_PATH}"
scp "root@${SSH_HOST}:${REMOTE_PATH}" "${LOCAL_PATH}"

echo
echo "→ Dropping and recreating local DB: ${LOCAL_DB}"
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -d postgres -c "DROP DATABASE IF EXISTS ${LOCAL_DB};"
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -d postgres -c "CREATE DATABASE ${LOCAL_DB} OWNER ${LOCAL_USER};"

echo
echo "→ Restoring with $($PG_RESTORE --version)"
"$PG_RESTORE" -d "$LOCAL_DB" -U "$LOCAL_USER" -h "$LOCAL_HOST" --no-owner --no-privileges "$LOCAL_PATH"

echo
echo "Done. Local '${LOCAL_DB}' restored from ${SSH_HOST}."
