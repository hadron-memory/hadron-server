#!/bin/sh
set -eu
# Per-launch secrets keep even synthetic JWT sessions isolated between stacks.
JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
HADRON_ENCRYPTION_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
export JWT_SECRET HADRON_ENCRYPTION_KEY
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/pre-push.sql
pnpm prisma db push --skip-generate
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/post-push.sql
pnpm tsx scripts/e2e/seed.ts
node scripts/e2e/proxy.mjs &
exec pnpm tsx src/index.ts
