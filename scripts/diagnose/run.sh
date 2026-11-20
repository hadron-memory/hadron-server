#!/usr/bin/env bash
# Linux/GNU tools required (Incus, mv -T, date +%s%3N).
# #2589 diagnosis runner. Private e2e stack only; never touches production.
# Stages a throwaway copy of HEAD with the diagnose overlay, so scripts/e2e stays unchanged in the PR.
# usage: run.sh <worker> <api-port> <portal-port> <workload> [duration-s]
# env: DIAG_W2=1 (synthetic embed/matcher/stall activity + local stub embedding endpoint), DIAG_SNAPSHOTS=1 (heap snapshots at start/load/idle,
#   reduced to constructor/type counts and sizes; the files never leave the stack and are deleted), DIAG_EXPOSE_GC=1 (forced GC before each snapshot).
#   Anything not enabled is printed as 'not exercised', never zero.
# env: DIAG_OUT (default $TMPDIR/diagnose-<project>.jsonl), DIAG_IDLE_S (default 300).
#   DIAG_SESSION_CAP (1..1000) bakes MCP_MAX_SESSIONS_PER_PRINCIPAL into the staged stack (the held
#   workload opens cap+1; the measured held count is the cap), DIAG_PROBE_N (held only) times tools/list
#   round trips on a held session (#4448), DIAG_SETTLE_S (default 60) idles before the load so the
#   per-session baseline is settled, not boot-flushed. The load line (counts, latencies, epoch ms) is
#   appended to DIAG_OUT with the per-session reduction.
#   The load generator itself runs inside the app container, never on the shared host (the #4448 host
#   rule, finding synthetic-load-never-on-shared-host); only its counts-only line comes back out.
# Failed samples/logs are retained only with verified instance ownership; otherwise private state is left for inspection.
# Raw failure logs go to $DIAG_OUT.private.log, mode 0600.
set -euo pipefail
worker=${1:?worker}; api=${2:?api port}; portal=${3:?portal port}; workload=${4:?workload}; dur=${5:-600}
# Match stack.sh's name contract before deriving any reservation path.
[[ "$worker" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo 'invalid diagnosis stack name' >&2; exit 2; }
# The server's own ceiling is 1000 (src/mcp/transportBounds.ts); a cap outside it would measure the default.
if [ -n "${DIAG_SESSION_CAP:-}" ]; then
  [[ "$DIAG_SESSION_CAP" =~ ^[0-9]+$ ]] && [ "$DIAG_SESSION_CAP" -ge 1 ] && [ "$DIAG_SESSION_CAP" -le 1000 ] \
    || { echo 'DIAG_SESSION_CAP must be an integer 1..1000' >&2; exit 2; }
  DIAG_SESSION_CAP=$((10#$DIAG_SESSION_CAP))   # 0100 bakes as 100, not an octal-looking literal
fi
here=$(cd "$(dirname "$0")" && pwd); . "$here/cleanup.sh"; root=$(git -C "$here" rev-parse --show-toplevel)
project="hadron-e2e-$worker"
DIAG_OUT=${DIAG_OUT:-${TMPDIR:-/tmp}/diagnose-$project.jsonl}
state="${XDG_STATE_HOME:-$HOME/.local/state}/hadron-e2e/$project"
# The diagnosis overlay supports Incus ownership markers only. Never silently select Docker.
case "${E2E_BACKEND:-incus}" in incus|auto) export E2E_BACKEND=incus;; *) echo 'diagnosis requires the Incus backend' >&2; exit 2;; esac
acquire_stack_reservation "$state" "$project" || exit 2
stage=''
load_line=''   # #4453 N6: always defined, so the trap never depends on set -u luck
down() {
  rc=$?
  trap - EXIT
  set +e
  cleanup_rc=0
  # A reservation serializes harness runs; receipts also protect against a failed
  # up colliding with a stack created outside this harness.
  if stack_owned; then
    [ "$rc" = 0 ] || preserve_samples "$DIAG_OUT"
    # #4453 BLIND review: preserve_samples replaces DIAG_OUT with the container's series, so a load
    # line captured before a failed exit is re-appended here — the counts explain the invalid run.
    # #4453 N6: append only if the line is not already there, so this holds whether or not
    # preserve_samples replaced the file.
    if [ "$rc" != 0 ] && [ -n "$load_line" ] && ! grep -qxF -- "$load_line" "$DIAG_OUT" 2>/dev/null; then printf '%s\n' "$load_line" >> "$DIAG_OUT" 2>/dev/null || true; fi
    if [ "$rc" != 0 ]; then keep_logs_private "$DIAG_OUT.private.log" bash -c 'cd "$1" && scripts/e2e/stack.sh logs "$2"' _ "$stage/src" "$worker"; fi
    # Heap snapshots hold real values: purge before the stack goes, and a purge that fails or cannot be verified fails the run.
    purge_snapshots || cleanup_rc=5
    rm -- "$state/diagnose-owner"
    (cd "$stage/src" && scripts/e2e/stack.sh down "$worker") || cleanup_rc=5
  else
    explain_unowned_stack "$state" "$project"   # #2628: which case, and the path only when there is one to inspect
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
reductions="$stage/reductions.jsonl"; : > "$reductions"
mkdir "$stage/src/scripts/e2e/diagnose"
cp "$here"/{sampler.mjs,preload.mjs,embedstub.mjs,snapshot.mjs,load.mjs} "$stage/src/scripts/e2e/diagnose/"
(cd "$stage/src" && git apply "$here/compose.patch"
  git apply "$here/ownership.patch"
  if [ -n "${DIAG_POOL_LIMIT:-}" ]; then   # unset must stay unset: poolUrl.ts refuses an empty value
    sed -i "s|^      GRAPHS_PATH: .*|&\n      DB_POOL_CONNECTION_LIMIT: '$DIAG_POOL_LIMIT'\n      DB_POOL_TIMEOUT_SECONDS: '${DIAG_POOL_TIMEOUT_S:-10}'|" scripts/e2e/compose.yaml
  fi
  if [ -n "${DIAG_SESSION_CAP:-}" ]; then   # stack.sh forwards only E2E_* across the Incus boundary, so the
    # staged compose cannot interpolate ${DIAG_SESSION_CAP}; bake the literal and verify it landed.
    sed -i "s|^      MCP_MAX_SESSIONS_PER_PRINCIPAL: .*|      MCP_MAX_SESSIONS_PER_PRINCIPAL: '$DIAG_SESSION_CAP'|" scripts/e2e/compose.yaml
    grep -q "^      MCP_MAX_SESSIONS_PER_PRINCIPAL: '$DIAG_SESSION_CAP'$" scripts/e2e/compose.yaml \
      || { echo 'MCP session cap substitution failed in the staged compose' >&2; exit 4; }
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
# #4453 P3: the load step assumes the staged overlay is mounted at /app/scripts/e2e/diagnose and that
# the image has timeout(1); find out now, not after the settle window.
app_exec sh -c 'command -v timeout >/dev/null && test -f /app/scripts/e2e/diagnose/load.mjs' \
  || { echo 'app container lacks timeout(1) or the staged load.mjs; refusing' >&2; exit 4; }
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
# #4453 BLIND review: a heap snapshot (and a forced GC under DIAG_EXPOSE_GC=1) and the W2 setup can
# move RSS for a while after they return. With either on, idle past them BEFORE the settle window
# opens, so the baseline window (the last 60 s before the load) holds only post-perturbation samples.
if [ "${DIAG_SNAPSHOTS:-}" = 1 ] || [ "${DIAG_W2:-}" = 1 ]; then sleep "${DIAG_SETTLE_S:-60}"; fi
# #4448: an idle baseline measured against boot-flushed RSS is not an idle baseline (the first run's
# pre-load window was 8 boot-phase samples at +45 MB over settled). Idle first, then load.
sleep "${DIAG_SETTLE_S:-60}"
# #4448 host rule (finding synthetic-load-never-on-shared-host): the load generator runs INSIDE the app
# container against its loopback server, never on the shared host. The shared user key is read from the
# mounted credentials file inside the container, so it never reaches a host argv or the host environment;
# only the non-secret cap/probe/workload/duration cross the boundary as arguments. The wall-clock guard
# ($6, dur+300) runs in-container too (an outer `timeout` cannot exec a shell function). The load line
# itself carries counts, probe latencies and epoch ms only (load.mjs asserts it secret-free); it is
# captured so DIAG_OUT holds the full record — its stdout previously evaporated.
credjs="const c=require('/fixtures/credentials.json');process.stdout.write(c.shared||Object.values(c).find(k=>k.startsWith('hdr_user_')))"
# #4453 BLIND review: capture the generator's exit instead of letting set -e abort on the assignment —
# the counts on the load line are exactly what explains an invalid run (5: acceptance failed,
# 124: wall-budget timeout), so the line is persisted and echoed before that exit propagates.
load_rc=0
load_line=$(app_exec sh -c 'HADRON_DIAG_KEY=$(node -e "$1") DIAG_SESSION_CAP="${2:-}" DIAG_PROBE_N="${3:-}" exec timeout "$6" node /app/scripts/e2e/diagnose/load.mjs http://127.0.0.1:4000 "$4" "$5"' - "$credjs" "${DIAG_SESSION_CAP:-}" "${DIAG_PROBE_N:-}" "$workload" "$dur" "$((dur + 300))") || load_rc=$?
if [ -n "$load_line" ]; then
  printf '%s\n' "$load_line" >&2
  printf '%s\n' "$load_line" > "$stage/load-line.json"
elif [ "$load_rc" -eq 0 ]; then
  # #4453 N4: exit 0 with no line leaves report.mjs nothing to read; that is an invalid run, not a pass.
  echo 'load generator exited 0 but printed no load line; diagnosis is invalid' >&2
  exit 7   # not 5: that is the generator's acceptance code and cleanup_rc's
fi
# A failed generator still explains itself: the line is echoed and stashed above, the EXIT trap
# re-appends it to DIAG_OUT after preserve_samples, and the rc propagates (samples and private
# logs are kept on any non-zero exit).
if [ "$load_rc" -ne 0 ]; then
  if [ -n "$load_line" ]; then echo "load generator exited $load_rc; the counts above explain the invalid run" >&2
  elif [ "$load_rc" -eq 124 ]; then echo 'load generator hit its wall-clock budget (exit 124) and printed no load line; there are no counts for this run' >&2
  else echo "load generator exited $load_rc and printed no load line; there are no counts for this run" >&2; fi
  exit "$load_rc"
fi
take_snapshot load
# pg_stat_activity control: the effective pool size is only believed if the database agrees.
conns=$(compose_exec db psql -U e2e -d e2e -Atc "select count(*) from pg_stat_activity where datname='e2e' and pid <> pg_backend_pid()" | tr -d '\r')
[[ "$conns" =~ ^[0-9]+$ ]] || conns=null
# Idle tail: the sampler keeps running after load stops, so retention vs release is visible.
sleep "${DIAG_IDLE_S:-300}"
# Samples are one second apart. Require coverage to within two sampling periods
# of the expected end, plus a live server: an idle-tail abort cannot pass.
expected_end=$(( $(date +%s%3N) - 2000 ))
app_exec node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:5)).catch(()=>process.exit(5))"
take_snapshot idle
finish_samples "$DIAG_OUT" "$conns" "$expected_end"
w2=null; heap=null
# #4448: the load line and its per-session reduction join the record after finish_samples has placed
# the container's series (both asserted secret-free at write).
printf '%s\n' "$load_line" >> "$DIAG_OUT"
node "$here/report.mjs" per-session "$DIAG_OUT" "$stage/load-line.json" >> "$DIAG_OUT"
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
