# Sourced by run.sh and its tests (#2589). Ownership, sample retention and output-boundary helpers.

# refuse_existing_stack <state-dir> <instance-name>: a stack this invocation did not create is never torn down.
# Returns 1 when the name is already in use (recorded state, or a live Incus instance of that name).
refuse_existing_stack() {
  local state=$1 name=$2
  if [ -e "$state" ]; then echo "stack name already in use; refusing (not created by this run)" >&2; return 1; fi
  if command -v incus >/dev/null 2>&1 && incus list --format csv -c n 2>/dev/null | grep -qx "$name"; then
    echo "instance name already in use; refusing (not created by this run)" >&2; return 1
  fi
  return 0
}

# copy_samples <dest>: strict copy of the samples file out of the app container. Fails (and leaves any existing dest
# untouched) when the container read fails or yields nothing, so a run can never pass with no sample series.
copy_samples() {
  local dest=${1:?dest}
  declare -F app_exec >/dev/null || return 1
  if app_exec cat /var/lib/hadron/graphs/diagnose-samples.jsonl > "$dest.partial" 2>/dev/null && [ -s "$dest.partial" ]; then
    mv "$dest.partial" "$dest"
  else
    rm -f "$dest.partial"; echo "could not retrieve the samples file" >&2; return 1
  fi
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
  local dest=$1 conns=$2
  copy_samples "$dest" || return 5
  printf '{"kind":"pg_activity","connectionsAfterLoad":%s}\n' "$conns" >> "$dest"
}

# keep_logs_private <dest> <cmd...>: raw logs go to a fresh 0600 file, never to stderr; only a fixed line is published.
# The destination is removed first and created exclusively, so an existing permissive file (or symlink) is never reused.
keep_logs_private() {
  local dest=$1; shift
  rm -f -- "$dest"
  ( umask 077; set -C; "$@" 2>&1 | tail -200 > "$dest" ) || true
  echo "failure logs kept privately ($(wc -l < "$dest" 2>/dev/null || echo 0) lines)" >&2
}

# purge_snapshots: heap snapshots hold real values, so they are deleted from the stack host and the deletion is verified.
# SNAP_DIR is the container directory the server writes them to. Fails when any survives.
SNAP_DIR=${SNAP_DIR:-/var/lib/hadron/graphs}
purge_snapshots() {
  declare -F app_exec >/dev/null || return 0
  app_exec rm -f -- "$SNAP_DIR"/*.heapsnapshot 2>/dev/null || true
  if app_exec sh -c "ls '$SNAP_DIR'/*.heapsnapshot" >/dev/null 2>&1; then echo "heap snapshot files survived the purge" >&2; return 1; fi
  return 0
}
