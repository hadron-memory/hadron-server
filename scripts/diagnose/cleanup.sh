# Sourced by run.sh and its tests (#2589). Ownership, sample retention and output-boundary helpers.

# refuse_existing_stack <state-dir> <instance-name>: a stack this invocation did not create is never torn down.
# Returns 1 when the name is already in use (recorded state, or a live Incus instance of that name).
refuse_existing_stack() {
  local state=$1 name=$2 instances
  if [ -e "$state" ] || [ -L "$state" ]; then echo "stack name already in use; refusing (not created by this run)" >&2; return 1; fi
  command -v incus >/dev/null 2>&1 || { echo "Incus is required for owned diagnosis stacks" >&2; return 1; }
  instances=$(incus list --format csv -c n) || { echo "cannot inspect Incus; refusing" >&2; return 1; }
  if grep -qxF "$name" <<< "$instances"; then
    echo "instance name already in use; refusing (not created by this run)" >&2; return 1
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
  local dest=$1 conns=$2 complete
  complete=$(umask 077; mktemp "$(dirname -- "$dest")/.diagnose-finish-XXXXXXXX") || return 5
  if copy_samples "$complete" && node "$(dirname -- "${BASH_SOURCE[0]}")/validate-samples.mjs" "$complete" "${3:-}"; then
    if printf '{"kind":"pg_activity","connectionsAfterLoad":%s}\n' "$conns" >> "$complete" && mv -fT -- "$complete" "$dest"; then return 0; fi
  fi
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
  (umask 077; mkdir -- "$DIAG_LOCK") || { echo "diagnosis stack already reserved" >&2; return 1; }
  DIAG_RUN_TOKEN=$(node -e "process.stdout.write(require('crypto').randomUUID())") || { rmdir -- "$DIAG_LOCK"; return 1; }
  printf '%s\n' "$DIAG_RUN_TOKEN" > "$DIAG_LOCK/owner"
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
