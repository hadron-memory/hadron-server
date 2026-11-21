#!/usr/bin/env bash
# #4646 (Refs #4278): an in-VM watchdog for the test-shard vitest step.
#
# usage: WATCHDOG_MINUTES=<n> WATCHDOG_STEP_TIMEOUT_MINUTES=<m> vitest-watchdog.sh -- <command...>
#
# Hosted runners have been lost mid-shard ("lost communication with the server") 48 to 53 minutes into the vitest step,
# and GitHub keeps NO log for a lost job, so the step's sampler output dies with the VM. This runs the command and,
# if it is still running after WATCHDOG_MINUTES, ends it ourselves while the VM is alive:
#   1. prints a [watchdog] process list and one final [sampler] block (date, free, df, largest processes) to stdout;
#   2. stops, then kills, the command's own process tree, by PID: the command and every descendant found by walking the
#      ppid chain. Nothing is matched by name, and nothing outside that tree is touched (the step's own sampler is a
#      sibling: the step's EXIT trap ends it after this script returns, so it dies last);
#   3. prints "[watchdog] vitest exceeded N min; killed" and exits 124 (GNU timeout's code for "the time ran out"),
#      which vitest itself does not use, so a watchdog kill is distinguishable from a test failure (exit 1).
# Inside the budget it returns the command's own exit code, unchanged.
#
# The budget must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES, which the step sets equal to its own
# timeout-minutes (pinned in vitest-watchdog.test.mjs), so the watchdog always fires before the step timeout.
#
# THE LIMIT: this fires only if the VM is still scheduling processes at the budget. If the next loss is the VM
# freezing outright, no dump appears, and that absence is itself the finding for #4278.
#
# WATCHDOG_SECONDS_PER_MINUTE (default 60) exists only for the tests, so a "minute" can be one second; CI never sets it.
set -u

refuse() { echo "[watchdog] WATCHDOG_MINUTES must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES (the step's timeout-minutes); refusing" >&2; exit 2; }
minutes=${WATCHDOG_MINUTES-}
step=${WATCHDOG_STEP_TIMEOUT_MINUTES-}
unit=${WATCHDOG_SECONDS_PER_MINUTE:-60}
[[ "$minutes" =~ ^[1-9][0-9]*$ ]] || refuse
[[ "$step" =~ ^[1-9][0-9]*$ ]] || refuse
[[ "$unit" =~ ^[1-9][0-9]*$ ]] || refuse
(( minutes < step )) || refuse
[ "${1:-}" = -- ] || { echo "usage: vitest-watchdog.sh -- <command...>" >&2; exit 2; }
shift
[ "$#" -gt 0 ] || { echo "usage: vitest-watchdog.sh -- <command...>" >&2; exit 2; }
budget=$(( minutes * unit ))

# The command and every descendant of it, by walking ppid from the command's PID. Printed one PID per line.
tree() {
  local root=$1 frontier=$1 found="$1" next
  local table; table=$(ps -eo pid=,ppid=)
  while [ -n "$frontier" ]; do
    next=$(awk -v f=" $frontier " 'index(f, " " $2 " ") { printf "%s ", $1 }' <<< "$table")
    frontier=${next% }
    [ -n "$frontier" ] && found="$found $frontier"
  done
  tr ' ' '\n' <<< "$found" | awk 'NF'
}

"$@" &
cmd=$!
start=$SECONDS
while kill -0 "$cmd" 2>/dev/null; do
  if (( SECONDS - start >= budget )); then
    echo "[watchdog] budget of ${minutes} min reached; process tree before the kill:"
    ps -eo pid,ppid,rss,etime,comm
    echo "[sampler] $(date -u +%FT%TZ) (final, from the watchdog)"; free -m; df -h /; ps -eo rss,comm --sort=-rss | head -5
    # Stop the tree first so nothing in it can spawn while it is collected, then collect again and kill all of it.
    pids=$(tree "$cmd")
    # shellcheck disable=SC2086
    kill -STOP $pids 2>/dev/null
    pids=$(tree "$cmd" | sort -u; echo "$pids") ; pids=$(sort -u <<< "$pids")
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null
    wait "$cmd" 2>/dev/null
    echo "[watchdog] vitest exceeded ${minutes} min; killed"
    exit 124
  fi
  sleep 1
done
wait "$cmd"
exit $?
