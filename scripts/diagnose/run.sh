#!/usr/bin/env bash
# Linux/GNU tools required (Incus, mv -T, date +%s%3N).
# #2589 diagnosis runner. Private e2e stack only; never touches production.
# Stages a throwaway copy of HEAD with the diagnose overlay, so scripts/e2e stays unchanged in the PR.
# usage: run.sh <worker> <api-port> <portal-port> <workload> [duration-s]
# env: DIAG_OUT (default $TMPDIR/diagnose-<project>.jsonl), DIAG_IDLE_S (default 300).
# Failed samples/logs are retained only with verified instance ownership; otherwise private state is left for inspection.
# Raw failure logs go to $DIAG_OUT.private.log, mode 0600.
set -euo pipefail
worker=${1:?worker}; api=${2:?api port}; portal=${3:?portal port}; workload=${4:?workload}; dur=${5:-600}
# Match stack.sh's name contract before deriving any reservation path.
[[ "$worker" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo 'invalid diagnosis stack name' >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd); . "$here/cleanup.sh"; root=$(git -C "$here" rev-parse --show-toplevel)
project="hadron-e2e-$worker"
DIAG_OUT=${DIAG_OUT:-${TMPDIR:-/tmp}/diagnose-$project.jsonl}
state="${XDG_STATE_HOME:-$HOME/.local/state}/hadron-e2e/$project"
# The diagnosis overlay supports Incus ownership markers only. Never silently select Docker.
case "${E2E_BACKEND:-incus}" in incus|auto) export E2E_BACKEND=incus;; *) echo 'diagnosis requires the Incus backend' >&2; exit 2;; esac
acquire_stack_reservation "$state" "$project" || exit 2
stage=''
down() {
  rc=$?
  trap - EXIT
  set +e
  cleanup_rc=0
  # A reservation serializes harness runs; receipts also protect against a failed
  # up colliding with a stack created outside this harness.
  if stack_owned; then
    [ "$rc" = 0 ] || preserve_samples "$DIAG_OUT"
    if [ "$rc" != 0 ]; then keep_logs_private "$DIAG_OUT.private.log" bash -c 'cd "$1" && scripts/e2e/stack.sh logs "$2"' _ "$stage/src" "$worker"; fi
    rm -- "$state/diagnose-owner"
    (cd "$stage/src" && scripts/e2e/stack.sh down "$worker") || cleanup_rc=5
  else
    echo "stack ownership unverified; refusing capture/teardown; inspect private state: $state (manual ownership check required)" >&2
    if [ "$rc" = 0 ]; then cleanup_rc=5; fi
  fi
  if [ -n "$stage" ]; then git -C "$root" worktree remove --force "$stage/src" || cleanup_rc=5; rm -rf -- "$stage"; fi
  release_stack_reservation || cleanup_rc=5
  if [ "$rc" = 0 ]; then rc=$cleanup_rc; fi
  exit "$rc"
}
trap down EXIT
stage=$(mktemp -d)
git -C "$root" worktree add --detach "$stage/src" HEAD >/dev/null
mkdir "$stage/src/scripts/e2e/diagnose"
cp "$here"/{sampler.mjs,preload.mjs} "$stage/src/scripts/e2e/diagnose/"
(cd "$stage/src" && git apply "$here/compose.patch"
  git apply "$here/ownership.patch"
  if [ -n "${DIAG_POOL_LIMIT:-}" ]; then   # unset must stay unset: poolUrl.ts refuses an empty value
    sed -i "s|^      GRAPHS_PATH: .*|&\n      DB_POOL_CONNECTION_LIMIT: '$DIAG_POOL_LIMIT'\n      DB_POOL_TIMEOUT_SECONDS: '${DIAG_POOL_TIMEOUT_S:-10}'|" scripts/e2e/compose.yaml
  fi
  git add -f scripts/e2e)   # stack.sh ships tracked files only
cd "$stage/src"
scripts/e2e/stack.sh up "$worker" "$api" "$portal" >/dev/null   # its output carries the credentials; never echo it
backend=$(cat "$state/backend")
compose_exec() {
  if [ "$backend" = incus ]; then
    incus exec "$project" -- docker compose --project-name "$project" --file /opt/hadron/scripts/e2e/compose.yaml exec -T "$@"
  else
    E2E_PORT=$api E2E_PORTAL_PORT=$portal docker compose --project-name "$project" --file "$stage/src/scripts/e2e/compose.yaml" exec -T "$@"
  fi
}
app_exec() { compose_exec app "$@"; }
limit=$(app_exec cat /sys/fs/cgroup/memory.max | tr -d '\r')
[ "$limit" = 6442450944 ] || { echo "cgroup limit is '$limit', not 6 GB; refusing" >&2; exit 4; }
HADRON_DIAG_KEY=$(app_exec node -e "const c=require('/fixtures/credentials.json');process.stdout.write(c.shared||Object.values(c).find(k=>k.startsWith('hdr_user_')))")
export HADRON_DIAG_KEY
timeout $((dur + 300)) node "$here/load.mjs" "http://127.0.0.1:$api" "$workload" "$dur"
# pg_stat_activity control: the effective pool size is only believed if the database agrees.
conns=$(compose_exec db psql -U e2e -d e2e -Atc "select count(*) from pg_stat_activity where datname='e2e' and pid <> pg_backend_pid()" | tr -d '\r')
[[ "$conns" =~ ^[0-9]+$ ]] || conns=null
# Idle tail: the sampler keeps running after load stops, so retention vs release is visible.
sleep "${DIAG_IDLE_S:-300}"
# Samples are one second apart. Require coverage to within two sampling periods
# of the expected end, plus a live server: an idle-tail abort cannot pass.
expected_end=$(( $(date +%s%3N) - 2000 ))
app_exec node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:5)).catch(()=>process.exit(5))"
finish_samples "$DIAG_OUT" "$conns" "$expected_end"
echo "samples: $DIAG_OUT" >&2
