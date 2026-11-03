#!/bin/sh
set -eu
# Refuse an initialized DB before any schema push or per-launch key changes.
initialized=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public')")
if [ "$initialized" != f ]; then
  echo 'E2E startup refused: database is already initialized; reset with scoped stack.sh down, then up.' >&2
  exit 1
fi
# Per-launch secrets keep even synthetic JWT sessions isolated between stacks.
JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
HADRON_ENCRYPTION_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
# #1793: only after the empty-DB check above; every process in this fresh stack shares this key.
# A private QA override supports multi-process/overlap probes; never use production key material here.
if [ -z "${RATE_LIMIT_KEYRING:-}" ]; then
  RATE_LIMIT_KEYRING=$(node -e "process.stdout.write(JSON.stringify({current:'e2e',keys:{e2e:require('crypto').randomBytes(32).toString('hex')}}))")
fi
export JWT_SECRET HADRON_ENCRYPTION_KEY RATE_LIMIT_KEYRING
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/pre-push.sql
pnpm prisma db push --skip-generate
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/post-push.sql
pnpm tsx scripts/e2e/seed.ts
exec node scripts/e2e/supervise.mjs
