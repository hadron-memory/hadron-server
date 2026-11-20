# Sourced by run.sh and its tests (#2589). Ownership, sample retention and output-boundary helpers.

# refuse_existing_stack <state-dir> <instance-name>: a stack this invocation did not create is never torn down.
# Returns 1 when the name is already in use (recorded state, or a live Incus instance of that name).
refuse_existing_stack() {
  local state=$1 name=$2 instances
  # #2628: each refusal names the path or instance that blocks the run. None advises removing anything: this harness
  # holds no authority over state or instances it did not create, so the operator checks ownership by hand.
  if [ -e "$state" ] || [ -L "$state" ]; then
    echo "stack state already exists: $state; refusing (not created by this run; manual ownership check required)" >&2; return 1
  fi
  command -v incus >/dev/null 2>&1 || { echo "Incus is required for owned diagnosis stacks" >&2; return 1; }
  instances=$(incus list --format csv -c n) || { echo "cannot inspect Incus; refusing" >&2; return 1; }
  if grep -qxF "$name" <<< "$instances"; then
    echo "Incus instance $name already exists with no stack state at $state; refusing (foreign or unverified instance; manual ownership check required)" >&2; return 1
  fi
  return 0
}

# copy_samples <dest>: strict copy of the samples file out of the app container. Fails (and leaves any existing dest
# untouched) when the container read fails or yields nothing, so a run can never pass with no sample series.
copy_samples() {
  local dest=${1:?dest} partial
  declare -F app_exec >/dev/null || return 1
  partial=$(umask 077; mktemp "$(dirname -- "$dest")/.diagnose-copy-XXXXXXXX") || return 1
  if app_exec cat /var/lib/hadron/graphs/diagnose-samples.jsonl > "$partial" 2>/dev/null && [ -s "$partial" ]; then
    # -T replaces a destination symlink itself, never follows it (including a symlink to a directory).
    if mv -fT -- "$partial" "$dest"; then return 0; fi
  fi
  rm -f -- "$partial"; echo "could not retrieve the samples file" >&2; return 1
}

# preserve_samples <dest>: best-effort copy for the failure path; never fails the caller.
preserve_samples() {
  local dest=${1:-}
  [ -n "$dest" ] && [ "$dest" != /dev/stdout ] || return 0
  copy_samples "$dest" 2>/dev/null || true
  return 0
}

# finish_samples <dest> <connections>: the success path. Mandatory copy, then the pg_stat_activity control line.
finish_samples() {
  local dest=$1 conns=$2 expected=${3:?expected sample end required} complete token attempt
  complete=$(umask 077; mktemp "$(dirname -- "$dest")/.diagnose-finish-XXXXXXXX") || return 5
  # A live append can race cat. Retry bounded fresh copies; never discard a fragment
  # that could be an abort record, and require positive validator execution evidence.
  for attempt in 1 2 3; do
    if copy_samples "$complete" && token=$(node "$(dirname -- "${BASH_SOURCE[0]}")/validate-samples.mjs" "$complete" "$expected") && [ "$token" = validated ]; then
      if printf '{"kind":"pg_activity","connectionsAfterLoad":%s}\n' "$conns" >> "$complete" && mv -fT -- "$complete" "$dest"; then return 0; fi
      break
    fi
    sleep .05
  done
  rm -f -- "$complete"; return 5
}

# keep_logs_private <dest> <cmd...>: raw logs go to a fresh 0600 file, never to stderr; only a fixed line is published.
# The destination is removed first and created exclusively, so an existing permissive file (or symlink) is never reused.
keep_logs_private() {
  local dest=$1; shift
  rm -f -- "$dest"
  ( umask 077; set -C; "$@" 2>&1 | tail -200 > "$dest" ) || true
  echo "failure logs kept privately ($(wc -l < "$dest" 2>/dev/null || echo 0) lines)" >&2
}

# Reservations are never reclaimed by age/PID. A stale reservation needs manual inspection.
# Incus-only: stack.sh's default Docker selection cannot establish this run's instance marker.
acquire_stack_reservation() {
  DIAG_STATE=$1 DIAG_PROJECT=$2
  DIAG_LOCK="$DIAG_STATE.diagnose-lock"
  mkdir -p -- "$(dirname -- "$DIAG_STATE")" || return 1
  if ! (umask 077; mkdir -- "$DIAG_LOCK"); then
    # #4607 BLIND F1: only an existing lock is a held reservation. Any other failure (permissions, a read-only or full
    # filesystem) is reported as such, after mkdir's own line, so nobody goes looking for a reservation that never existed.
    if [ -e "$DIAG_LOCK" ] || [ -L "$DIAG_LOCK" ]; then
      echo "diagnosis stack already reserved: $DIAG_LOCK; refusing (another run holds it, or a run ended without releasing it; a reservation is never taken over by age or PID; manual check required)" >&2
    else
      echo "could not create the diagnosis reservation $DIAG_LOCK (see the error above); refusing" >&2
    fi
    return 1
  fi
  DIAG_RUN_TOKEN=$(node -e "process.stdout.write(require('crypto').randomUUID())") || { rmdir -- "$DIAG_LOCK"; return 1; }
  if ! printf '%s\n' "$DIAG_RUN_TOKEN" > "$DIAG_LOCK/owner"; then rm -f -- "$DIAG_LOCK/owner"; rmdir -- "$DIAG_LOCK"; return 1; fi
  if ! refuse_existing_stack "$DIAG_STATE" "$DIAG_PROJECT"; then release_stack_reservation; return 1; fi
  export DIAG_RUN_TOKEN
}
reservation_owned() {
  [ -n "${DIAG_RUN_TOKEN:-}" ] && [ "$(cat "$DIAG_LOCK/owner" 2>/dev/null)" = "$DIAG_RUN_TOKEN" ]
}
release_stack_reservation() {
  if reservation_owned; then rm -- "$DIAG_LOCK/owner"; rmdir -- "$DIAG_LOCK"; fi
}
stack_owned() {
  reservation_owned || return 1
  [ "$(cat "$DIAG_STATE/diagnose-owner" 2>/dev/null)" = "$DIAG_RUN_TOKEN" ] || return 1
  [ "$(cat "$DIAG_STATE/backend" 2>/dev/null)" = incus ] || return 1
  local instances marker
  instances=$(incus list --format csv -c n) || return 1
  # State creation precedes launch. No live marked instance means no authority to call down.
  grep -qxF "$DIAG_PROJECT" <<< "$instances" || return 1
  marker=$(incus config get "$DIAG_PROJECT" user.hadron-diagnose) || return 1
  [ "$marker" = "$DIAG_RUN_TOKEN" ] || return 1
}

# explain_stack_ownership_failure <state-dir> <instance-name>: why stack_owned refused, for the end-of-run line (#2628).
# It reads the same facts stack_owned does and changes nothing, and names which check failed. Missing state proves only
# that the path is absent now, not that nothing was created (#4607 BLIND F2), so that line claims no more than that.
# It never advises removing anything, and tolerates missing arguments so the rest of the EXIT trap always runs.
explain_stack_ownership_failure() {
  local state=${1:-} name=${2:-the stack instance} prefix='stack ownership unverified; refusing capture/teardown'
  if ! reservation_owned; then
    # #4607 BLIND F3: a lost reservation is its own case, named by its path, whatever the state marker says.
    echo "$prefix; inspect private state: $state (this run no longer holds its reservation ${DIAG_LOCK:-}; manual ownership check required)" >&2
  elif ! [ -e "$state" ] && ! [ -L "$state" ]; then
    echo "$prefix: no stack state found at $state, so ownership cannot be verified; capture and teardown skipped (if an Incus instance named $name exists, check it by hand)" >&2
  elif [ "$(cat "$state/diagnose-owner" 2>/dev/null)" != "${DIAG_RUN_TOKEN:-}" ]; then
    echo "$prefix; inspect private state: $state (it does not carry this run's owner marker: created outside this run or by another holder; manual ownership check required)" >&2
  else
    echo "$prefix; inspect private state: $state (this run's state, but the Incus instance $name is missing, unreadable or not marked by this run; manual ownership check required)" >&2
  fi
}

# purge_snapshots: heap snapshots hold real values, so they are deleted from the stack host and the deletion is verified.
# SNAP_DIR is the container directory the server writes them to. Fails when any survives.
SNAP_DIR=${SNAP_DIR:-/var/lib/hadron/graphs}
purge_snapshots() {
  declare -F app_exec >/dev/null || return 0
  # The glob must expand inside the container, so both steps run in one sh -c there.
  app_exec sh -c "rm -f -- '$SNAP_DIR'/*.heapsnapshot" >/dev/null 2>&1 || { echo "heap snapshot purge could not run" >&2; return 1; }
  local left
  # A failed listing is not proof of absence: only a successful, empty find passes.
  left=$(app_exec sh -c "find '$SNAP_DIR' -maxdepth 1 -name '*.heapsnapshot'" 2>/dev/null) || { echo "heap snapshot purge could not be verified" >&2; return 1; }
  if [ -n "$left" ]; then echo "heap snapshot files survived the purge" >&2; return 1; fi
  return 0
}
