#!/usr/bin/env bash
# Restore a snapshot of the PRODUCTION Hadron DB into a SEPARATE local DB.
#
# The "safe" path for pulling prod data down for local work:
#   • restores into a throwaway DB (default: hadron_prod_snapshot) and REFUSES
#     to touch `hadron` / `hadron_test`
#   • --no-owner --no-privileges  → restores as the local `holger` role
#   • excludes `_prisma_migrations` → keeps prod's migration ledger out of the
#     local DB (local dev is `db push`-managed — see CLAUDE.md "Local Postgres
#     setup")
#
# ── READ BEFORE USING — two things a restore does NOT solve ──────────────────
#   1. ENCRYPTION KEY. Columns encrypted under the prod HADRON_ENCRYPTION_KEY
#      (AES-256-GCM) come back as opaque bytes and will NOT decrypt locally:
#        - organizations.github_app_private_key_encrypted
#        - memories.source_token_encrypted
#        - ai_service_configs.api_key_encrypted
#        - any memory with is_encrypted = true (content + asset bytes)
#      The app errors when it touches these. Do NOT copy the prod key here to
#      "fix" it — that one key unlocks every tenant's secrets.
#   2. REAL DATA. The snapshot holds production rows. Treat the target DB as
#      production-classified and disposable; it is not a fixture set.
#
# Usage:
#   PROD_DATABASE_URL='postgresql://…prod…' scripts/dev-from-prod-snapshot.sh
#   PROD_DATABASE_URL='…' scripts/dev-from-prod-snapshot.sh my_snapshot_db
#   PROD_DATABASE_URL='…' scripts/dev-from-prod-snapshot.sh --yes        # skip the prompt
#   PROD_DATABASE_URL='…' scripts/dev-from-prod-snapshot.sh --sync       # then run db:dev-setup on it
#
# Get PROD_DATABASE_URL from your secrets manager (e.g. Doppler) — never
# hardcode it. Use a pg_dump client whose major version >= the prod server's.

set -euo pipefail
cd "$(dirname "$0")/.."

# ── args ─────────────────────────────────────────────────────────────────────
TARGET_DB="hadron_prod_snapshot"
SYNC=0
for arg in "$@"; do
  case "$arg" in
    --sync)    SYNC=1 ;;
    -y|--yes)  ASSUME_YES=1 ;;
    --*)       echo "unknown flag: $arg" >&2; exit 2 ;;
    *)         TARGET_DB="$arg" ;;
  esac
done

LOCAL_HOST="postgresql://holger@localhost:5432"
TARGET_URL="$LOCAL_HOST/$TARGET_DB"
ADMIN_URL="$LOCAL_HOST/postgres"

# ── guards ───────────────────────────────────────────────────────────────────
if [[ -z "${PROD_DATABASE_URL:-}" ]]; then
  echo "error: PROD_DATABASE_URL is not set. Export it (e.g. from Doppler) and re-run:" >&2
  echo "       PROD_DATABASE_URL='postgresql://…' scripts/dev-from-prod-snapshot.sh" >&2
  exit 1
fi
case "$TARGET_DB" in
  hadron|hadron_test)
    echo "error: refusing to overwrite '$TARGET_DB' (the canonical dev/test DB)." >&2
    echo "       Pick a throwaway name, e.g. hadron_prod_snapshot." >&2
    exit 1 ;;
esac
for bin in pg_dump pg_restore psql; do
  command -v "$bin" >/dev/null || { echo "error: '$bin' not found on PATH." >&2; exit 1; }
done

# ── loud warning banner ──────────────────────────────────────────────────────
cat >&2 <<'BANNER'
────────────────────────────────────────────────────────────────────────────
  PRODUCTION → LOCAL snapshot
  • Pulls REAL production data onto this machine. The target DB is
    production-classified and disposable — not a fixture set.
  • Columns encrypted under the prod HADRON_ENCRYPTION_KEY (GitHub App private
    key, memory source tokens, AI API keys, is_encrypted memory content/assets)
    will NOT decrypt locally. Do NOT copy the prod key here to work around it.
────────────────────────────────────────────────────────────────────────────
BANNER
echo "  Source : production (PROD_DATABASE_URL)" >&2
echo "  Target : $TARGET_URL  (will be DROPPED and recreated)" >&2
echo >&2

if [[ "${ASSUME_YES:-0}" != "1" ]]; then
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted."; exit 0; }
fi

# ── dump (custom format, minus the prod migration ledger) ────────────────────
DUMP="$(mktemp "${TMPDIR:-/tmp}/hadron_prod_snapshot.XXXXXX")"
cleanup() { rm -f "$DUMP"; }   # the dump holds prod data — always remove it
trap cleanup EXIT

echo "→ Dumping production (custom format, excluding _prisma_migrations)…"
pg_dump -Fc --no-owner --no-privileges \
  --exclude-table='_prisma_migrations' \
  --file="$DUMP" "$PROD_DATABASE_URL"

# ── (re)create the target DB locally ─────────────────────────────────────────
echo "→ Recreating $TARGET_DB locally…"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$TARGET_DB\";"

# pgvector must exist before the HNSW index restores; create it up front so the
# dump's own (idempotent) CREATE EXTENSION is a harmless no-op.
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

# ── restore ──────────────────────────────────────────────────────────────────
echo "→ Restoring into $TARGET_DB (benign 'already exists' notices are expected)…"
set +e
pg_restore --no-owner --no-privileges --dbname="$TARGET_URL" "$DUMP"
restore_rc=$?
set -e
[[ $restore_rc -ne 0 ]] && \
  echo "  (pg_restore exited $restore_rc — usually benign extension/comment notices; verifying…)"

# Distinguish benign notices from an actual failure: a core table must exist.
if ! psql "$TARGET_URL" -tAc "SELECT to_regclass('public.memories') IS NOT NULL;" | grep -q '^t$'; then
  echo "error: restore verification failed — 'memories' table not present. See pg_restore output above." >&2
  exit 1
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo
echo "→ Restored. Row counts:"
psql "$TARGET_URL" -tA -c \
  "SELECT 'memories='||count(*) FROM memories
   UNION ALL SELECT 'users='||count(*) FROM users
   UNION ALL SELECT 'nodes='||count(*) FROM nodes;" 2>/dev/null || true

cat <<EOF

Done → $TARGET_URL

Next:
  • One-off run against it:  DATABASE_URL='$TARGET_URL' <your dev server command>
  • Prod may be BEHIND your working schema.prisma (e.g. Memory.data). To bring
    the snapshot up to the local schema:  scripts/dev-setup.sh $TARGET_DB
  • Encrypted columns won't decrypt without the prod key — by design.
EOF

if [[ "$SYNC" == "1" ]]; then
  echo
  echo "→ --sync: bringing $TARGET_DB up to the local schema (db:dev-setup)…"
  scripts/dev-setup.sh "$TARGET_DB"
fi
