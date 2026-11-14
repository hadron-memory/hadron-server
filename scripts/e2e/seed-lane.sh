#!/usr/bin/env bash
# #4074: run the REAL e2e seed (scripts/e2e/seed.ts, which drives provision-signins.ts against its own loopback
# server) the way entrypoint.sh does, for one passkey matrix row, in CI. Inputs (env): ROW_SIGNING, ROW_REGISTRATION
# ('true'|'false'), ROW_EXPECT ('pass'|'fail'), DATABASE_URL (postgresql://e2e:e2e@db:5432/e2e, an EMPTY database).
# 'fail' is the red control: ROW_MUTATE=drop-registration reintroduces a #4058-shape regression in THIS checkout (the
# server silently drops the registration switch it was asked for), and the lane must go red on it: the seed must refuse
# the stack on its requested-vs-actual /capabilities assert (provision-signins.ts), and for that reason.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
: "${ROW_SIGNING:?}" "${ROW_REGISTRATION:?}" "${ROW_EXPECT:?}" "${DATABASE_URL:?}"
export E2E_SEED=true NODE_ENV=development BASE_URL=http://localhost:4000 FRONTEND_URL=http://localhost:5173
export DISABLE_RUN_WORKER=true DISABLE_SCHEDULER=true GRAPHS_PATH="${RUNNER_TEMP:-/tmp}/hadron-graphs"
# Same as the compose passthrough: an unset switch stays unset, 'false' rows leave the variable empty.
export PASSKEY_SIGNING_ENABLED=$([[ "$ROW_SIGNING" == true ]] && echo true || echo '')
export PASSKEY_REGISTRATION_ENABLED=$([[ "$ROW_REGISTRATION" == true ]] && echo true || echo '')
export SIGNING_CEREMONY_ORIGINS=http://localhost:5173 PASSKEY_RP_ID=localhost
export JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
export HADRON_ENCRYPTION_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
export RATE_LIMIT_KEYRING=$(node -e "process.stdout.write(JSON.stringify({current:'e2e',keys:{e2e:require('crypto').randomBytes(32).toString('hex')}}))")
if [[ "${ROW_MUTATE:-}" == drop-registration ]]; then
  surface=src/lib/signing/surface.ts
  sed -i "s/registration: signing && env.PASSKEY_REGISTRATION_ENABLED === 'true'/registration: false/" "$surface"
  git diff --quiet -- "$surface" && { echo 'LANE FAIL: mutation did not apply' >&2; exit 1; }
fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/pre-push.sql
pnpm prisma db push --skip-generate
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/post-push.sql
out=$(mktemp)
set +e; pnpm tsx scripts/e2e/seed.ts >"$out" 2>&1; status=$?; set -e
cat "$out"
if [[ "$ROW_EXPECT" == pass ]]; then
  [[ $status -eq 0 ]] || { echo "LANE FAIL: seed refused row signing=$ROW_SIGNING registration=$ROW_REGISTRATION" >&2; exit 1; }
  echo "LANE PASS: seed ran signing=$ROW_SIGNING registration=$ROW_REGISTRATION"
else
  [[ $status -ne 0 ]] || { echo 'LANE FAIL: red control seeded cleanly; a dropped switch would go unnoticed' >&2; exit 1; }
  grep -q "stack asked for registration=true but /capabilities says false" "$out" \
    || { echo 'LANE FAIL: red control failed, but not on the mismatch assert' >&2; exit 1; }
  echo 'LANE PASS: red control refused on the capabilities mismatch assert'
fi
