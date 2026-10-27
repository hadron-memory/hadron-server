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

# preserve_samples <dest>: best-effort copy of the samples file out of the app container; never fails the caller.
preserve_samples() {
  local dest=${1:-}
  [ -n "$dest" ] && [ "$dest" != /dev/stdout ] || return 0
  declare -F app_exec >/dev/null || return 0
  app_exec cat /var/lib/hadron/graphs/diagnose-samples.jsonl > "$dest.partial" 2>/dev/null && mv "$dest.partial" "$dest" || rm -f "$dest.partial"
  return 0
}

# keep_logs_private <dest> <cmd...>: raw logs go to a 0600 file, never to stderr; only a fixed line is published.
keep_logs_private() {
  local dest=$1; shift
  ( umask 077; "$@" 2>&1 | tail -200 > "$dest" ) || true
  echo "failure logs kept privately ($(wc -l < "$dest" 2>/dev/null || echo 0) lines)" >&2
}
