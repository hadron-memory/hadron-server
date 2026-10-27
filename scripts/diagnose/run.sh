#!/usr/bin/env bash
# #2589 diagnosis runner. Private e2e stack only; never touches production.
# Stages a throwaway copy of HEAD with the diagnose overlay, so scripts/e2e stays unchanged in the PR.
# usage: run.sh <worker> <api-port> <portal-port> <workload> [duration-s]
# env: DIAG_W2=1 (synthetic embed/matcher/stall activity + local stub embedding endpoint), DIAG_SNAPSHOTS=1 (heap snapshots at start/load/idle,
#   reduced to constructor/type counts and sizes; the files never leave the stack and are deleted), DIAG_EXPOSE_GC=1 (forced GC before each snapshot).
#   Anything not enabled is printed as 'not exercised', never zero.
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
  local rc=$?
  # On success the samples were already copied and the pg_activity line appended; re-copying would overwrite it.
  [ "$rc" = 0 ] || preserve_samples "$DIAG_OUT"
  if [ "$rc" != 0 ]; then keep_logs_private "$DIAG_OUT.private.log" bash -c "cd '$stage/src' && scripts/e2e/stack.sh logs '$worker'"; fi
  # A purge or stack-down failure must not read as a clean run: raw snapshots may survive, so the status says so.
  local final=0; teardown "$rc" || final=$?
  git -C "$root" worktree remove --force "$stage/src" || true; rm -rf "$stage"
  exit "$final"
}
stack_down() { (cd "$stage/src" && scripts/e2e/stack.sh down "$worker"); }
trap down EXIT
reductions="$stage/reductions.jsonl"; : > "$reductions"
mkdir "$stage/src/scripts/e2e/diagnose"
cp "$here"/{sampler.mjs,preload.mjs,embedstub.mjs,snapshot.mjs} "$stage/src/scripts/e2e/diagnose/"
(cd "$stage/src" && git apply "$here/compose.patch"
  if [ -n "${DIAG_POOL_LIMIT:-}" ]; then   # unset must stay unset: poolUrl.ts refuses an empty value
    sed -i "s|^      GRAPHS_PATH: .*|&\n      DB_POOL_CONNECTION_LIMIT: '$DIAG_POOL_LIMIT'\n      DB_POOL_TIMEOUT_SECONDS: '${DIAG_POOL_TIMEOUT_S:-10}'|" scripts/e2e/compose.yaml
  fi
  if [ "${DIAG_W2:-}" = 1 ]; then   # the stub is the only embedding endpoint this stack ever sees
    sed -i "s|^      GRAPHS_PATH: .*|&\n      EMBEDDING_API_URL: http://embedstub:11435/api/embed|" scripts/e2e/compose.yaml
  fi
  if [ "${DIAG_EXPOSE_GC:-}" = 1 ]; then sed -i 's|\${DIAG_NODE_OPTIONS:-}|--expose-gc|' scripts/e2e/compose.yaml; fi
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
HADRON_DIAG_ADMIN_KEY=$(app_exec node -e "process.stdout.write(require('/fixtures/credentials.json')['alpha-admin'])")
export HADRON_DIAG_ADMIN_KEY
# take_snapshot <label>: ask the server for a snapshot, reduce it in the stub container (outside the server's cgroup),
# keep only the reduction, delete the file at once.
take_snapshot() {
  [ "${DIAG_SNAPSHOTS:-}" = 1 ] || return 0
  app_exec touch "$SNAP_DIR/snap-$1.trigger"
  local i
  # The sampler logs the snapshot line only after the file is fully written, so wait for that line, not for the file.
  for i in $(seq 1 120); do app_exec grep -q "\"kind\":\"snapshot\",\"label\":\"$1\"" /var/lib/hadron/graphs/diagnose-samples.jsonl && break; sleep 2; done
  app_exec test -s "$SNAP_DIR/$1.heapsnapshot" || { echo "snapshot $1 was not produced" >&2; return 6; }
  local red; red=$(compose_exec embedstub node --max-old-space-size=3072 /app/scripts/e2e/diagnose/snapshot.mjs "$SNAP_DIR/$1.heapsnapshot") || { echo "snapshot reduction failed: $1" >&2; return 6; }
  printf '{"label":"%s","reduction":%s}\n' "$1" "$red" >> "$reductions"
  app_exec rm -f -- "$SNAP_DIR/$1.heapsnapshot"
}
take_snapshot start
if [ "${DIAG_W2:-}" = 1 ]; then
  node "$here/activity.mjs" "http://127.0.0.1:$api" > "$stage/w2-created.json"
fi
timeout $((dur + 300)) node "$here/load.mjs" "http://127.0.0.1:$api" "$workload" "$dur"
take_snapshot load
# pg_stat_activity control: the effective pool size is only believed if the database agrees.
conns=$(compose_exec db psql -U e2e -d e2e -Atc "select count(*) from pg_stat_activity where datname='e2e' and pid <> pg_backend_pid()" | tr -d '\r')
[[ "$conns" =~ ^[0-9]+$ ]] || conns=null
# Idle tail: the sampler keeps running after load stops, so retention vs release is visible.
sleep "${DIAG_IDLE_S:-300}"
take_snapshot idle
finish_samples "$DIAG_OUT" "$conns"
w2=null; heap=null
if [ "${DIAG_W2:-}" = 1 ]; then
  stub=$(compose_exec embedstub node -e "fetch('http://127.0.0.1:11435/count').then(r=>r.text()).then(t=>process.stdout.write(t))" | tr -d '\r')
  emb=$(compose_exec db psql -U e2e -d e2e -Atc "select count(distinct ne.node_id) from node_embeddings ne join nodes n on n.id=ne.node_id where n.loc like 'diag:w2:%'" | tr -d '\r')
  stall=$(compose_exec db psql -U e2e -d e2e -Atc "select count(*) from agent_team_events where type='assignment.unassignable'" | tr -d '\r')
  w2=$(node "$here/report.mjs" w2 "$stage/w2-created.json" "$stub" "$emb" "$stall")
  printf '%s\n' "$w2" >> "$DIAG_OUT"
fi
if [ -s "$reductions" ]; then node "$here/snapshot.mjs" --report "$reductions" >> "$DIAG_OUT"; heap='{"snapshots":1}'; fi
node "$here/report.mjs" coverage "$w2" "$heap" >> "$DIAG_OUT"
echo "samples: $DIAG_OUT" >&2
