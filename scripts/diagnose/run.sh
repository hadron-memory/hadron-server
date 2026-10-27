#!/usr/bin/env bash
# #2589 diagnosis runner. Private e2e stack only; never touches production.
# Stages a throwaway copy of HEAD with the diagnose overlay, so scripts/e2e stays unchanged in the PR.
# usage: run.sh <worker> <api-port> <portal-port> <workload> [duration-s]
# env: DIAG_OUT (samples file, default $TMPDIR/diagnose-<project>.jsonl so a failed run always keeps its samples; raw failure logs go to $DIAG_OUT.private.log, mode 0600), DIAG_IDLE_S (idle tail, default 300)
set -euo pipefail
worker=${1:?worker}; api=${2:?api port}; portal=${3:?portal port}; workload=${4:?workload}; dur=${5:-600}
here=$(cd "$(dirname "$0")" && pwd); . "$here/cleanup.sh"; root=$(git -C "$here" rev-parse --show-toplevel)
project="hadron-e2e-$worker"
DIAG_OUT=${DIAG_OUT:-${TMPDIR:-/tmp}/diagnose-$project.jsonl}
state="${XDG_STATE_HOME:-$HOME/.local/state}/hadron-e2e/$project"
# Ownership first: refuse an existing name BEFORE the cleanup trap exists, so a refusal can never tear down someone else's stack.
refuse_existing_stack "$state" "$project" || exit 2
stage=$(mktemp -d); git -C "$root" worktree add --detach "$stage/src" HEAD >/dev/null
down() {
  rc=$?
  # On success the samples were already copied and the pg_activity line appended; re-copying would overwrite it.
  [ "$rc" = 0 ] || preserve_samples "$DIAG_OUT"
  if [ "$rc" != 0 ]; then keep_logs_private "$DIAG_OUT.private.log" bash -c "cd '$stage/src' && scripts/e2e/stack.sh logs '$worker'"; fi
  (cd "$stage/src" && scripts/e2e/stack.sh down "$worker") || true
  git -C "$root" worktree remove --force "$stage/src" || true; rm -rf "$stage"
}
trap down EXIT
mkdir "$stage/src/scripts/e2e/diagnose"
cp "$here"/{sampler.mjs,preload.mjs} "$stage/src/scripts/e2e/diagnose/"
(cd "$stage/src" && git apply "$here/compose.patch"
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
finish_samples "$DIAG_OUT" "$conns"
echo "samples: $DIAG_OUT" >&2
