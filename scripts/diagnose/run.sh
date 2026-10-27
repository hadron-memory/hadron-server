#!/usr/bin/env bash
# #2589 diagnosis runner. Private e2e stack only; never touches production.
# Stages a throwaway copy of HEAD with the diagnose overlay, so scripts/e2e stays unchanged in the PR.
# usage: run.sh <worker> <api-port> <portal-port> <workload> [duration-s]
set -euo pipefail
worker=${1:?worker}; api=${2:?api port}; portal=${3:?portal port}; workload=${4:?workload}; dur=${5:-600}
here=$(cd "$(dirname "$0")" && pwd); root=$(git -C "$here" rev-parse --show-toplevel)
stage=$(mktemp -d); git -C "$root" worktree add --detach "$stage/src" HEAD >/dev/null
down() { rc=$?; [ "$rc" = 0 ] || (cd "$stage/src" && scripts/e2e/stack.sh logs "$worker" 2>&1 | tail -60 >&2) || true; (cd "$stage/src" && scripts/e2e/stack.sh down "$worker") || true; git -C "$root" worktree remove --force "$stage/src" || true; rm -rf "$stage"; }
trap down EXIT
mkdir "$stage/src/scripts/e2e/diagnose"
cp "$here"/{sampler.mjs,preload.mjs} "$stage/src/scripts/e2e/diagnose/"
(cd "$stage/src" && git apply "$here/compose.patch" && if [ -n "${DIAG_POOL_LIMIT:-}" ]; then   # unset must stay unset: poolUrl.ts refuses an empty value
    sed -i "s|^      GRAPHS_PATH: .*|&\n      DB_POOL_CONNECTION_LIMIT: '$DIAG_POOL_LIMIT'\n      DB_POOL_TIMEOUT_SECONDS: '${DIAG_POOL_TIMEOUT_S:-10}'|" scripts/e2e/compose.yaml
  fi
  git add -f scripts/e2e)   # stack.sh ships tracked files only
cd "$stage/src"
scripts/e2e/stack.sh up "$worker" "$api" "$portal" >/dev/null   # its output carries the credentials; never echo it
project="hadron-e2e-$worker"
state="${XDG_STATE_HOME:-$HOME/.local/state}/hadron-e2e/$project"
backend=$(cat "$state/backend")
app_exec() {
  if [ "$backend" = incus ]; then
    incus exec "$project" -- docker compose --project-name "$project" --file /opt/hadron/scripts/e2e/compose.yaml exec -T app "$@"
  else
    E2E_PORT=$api E2E_PORTAL_PORT=$portal docker compose --project-name "$project" --file "$stage/src/scripts/e2e/compose.yaml" exec -T app "$@"
  fi
}
# Abort contract: the cap we asked for must be the cap the container has.
limit=$(app_exec cat /sys/fs/cgroup/memory.max | tr -d '\r')
[ "$limit" = 6442450944 ] || { echo "cgroup limit is '$limit', not 6 GB; refusing" >&2; exit 4; }
HADRON_DIAG_KEY=$(app_exec node -e "const c=require('/fixtures/credentials.json');process.stdout.write(c.shared||Object.values(c).find(k=>k.startsWith('hdr_user_')))")
export HADRON_DIAG_KEY
timeout $((dur + 300)) node "$here/load.mjs" "http://127.0.0.1:$api" "$workload" "$dur"
app_exec cat /var/lib/hadron/graphs/diagnose-samples.jsonl > "${DIAG_OUT:-/dev/stdout}"
