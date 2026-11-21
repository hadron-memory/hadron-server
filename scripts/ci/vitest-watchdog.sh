#!/usr/bin/env bash
# #4646 (Refs #4278): an in-VM watchdog for the test-shard vitest step.
#
# usage: WATCHDOG_MINUTES=<n> WATCHDOG_STEP_TIMEOUT_MINUTES=<m> [WATCHDOG_STEP_STARTED_AT=<epoch s>] \
#          vitest-watchdog.sh -- <command...>
#
# Hosted runners have been lost mid-shard ("lost communication with the server") 48 to 53 minutes into the vitest step,
# and GitHub keeps NO log for a lost job, so the step's sampler output dies with the VM. This runs the command and,
# if it is still running WATCHDOG_MINUTES after the step started, ends it ourselves while the VM is alive:
#   1. prints a [watchdog] process list and one final [sampler] block (date, free, df, largest processes) to stdout,
#      each diagnostic bounded (#4647 BLIND P2), so a stalled ps or df cannot hold the kill past the step's deadline;
#   2. stops, then kills, the command's own processes, by two scoped handles (#4647 LOCAL F1, BLIND P1):
#      - its process group: the command is started in a new session (setsid), so its group holds every descendant
#        that did not leave it, even one reparented away from the tree when its parent exited;
#      - its PID tree: the command and every descendant found by walking the ppid chain, re-scanned and stopped until
#        no new PID appears, which also holds a descendant that left the group but is still a child.
#      Nothing is matched by name, and nothing outside those two handles is touched (the step's own sampler is a
#      sibling: the step's EXIT trap ends it after this script returns, so it dies last);
#   3. checks that nothing it signalled is still running (a zombie is not running), and prints
#      "[watchdog] vitest exceeded N min; killed", or, if something is, "...; kill NOT verified, still running: <pids>";
#      either way it exits 124 (GNU timeout's code for "the time ran out"), which vitest itself does not use, so a
#      watchdog kill is distinguishable from a test failure (exit 1).
# Inside the budget it returns the command's own exit code, unchanged. If the watchdog itself is sent TERM or INT (the
# step cancelled or timed out), it kills the command's group and tree before it exits, since the new session takes the
# command out of the step shell's group.
#
# The budget must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES, which the step sets equal to its own
# timeout-minutes (both pinned in vitest-watchdog.test.mjs), so the watchdog fires before the step timeout. It counts
# from WATCHDOG_STEP_STARTED_AT (epoch seconds, which the step exports as its first line) when that is set, so time the
# step spent before this script started (sampler setup, the psql probe) comes out of the budget (#4647 BLIND P2);
# unset, it counts from this script's start.
#
# THE LIMIT: this fires only if the VM is still scheduling processes at the budget. If the next loss is the VM
# freezing outright, no dump appears, and that absence is itself the finding for #4278.
#
# WATCHDOG_SECONDS_PER_MINUTE (default 60) exists only for the tests, so a "minute" can be one second; CI never sets it.
set -u

refuse() { echo "[watchdog] $1; refusing" >&2; exit 2; }
budget_msg="WATCHDOG_MINUTES must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES (the step's timeout-minutes)"
minutes=${WATCHDOG_MINUTES-}
step=${WATCHDOG_STEP_TIMEOUT_MINUTES-}
unit=${WATCHDOG_SECONDS_PER_MINUTE:-60}
started=${WATCHDOG_STEP_STARTED_AT-}
# At most four digits each (#4647 LOCAL F2, BLIND P3): a longer digit string would wrap in bash arithmetic and pass the
# checks below as some other number. A step's timeout-minutes is at most 360, so four digits is ample.
[[ "$minutes" =~ ^[1-9][0-9]{0,3}$ ]] || refuse "$budget_msg"
[[ "$step" =~ ^[1-9][0-9]{0,3}$ ]] || refuse "$budget_msg"
(( minutes < step )) || refuse "$budget_msg"
[[ "$unit" =~ ^[1-9][0-9]{0,3}$ ]] || refuse "WATCHDOG_SECONDS_PER_MINUTE must be a positive integer of at most four digits (tests only)"
now=$(date +%s)
if [ -n "$started" ]; then
  # Twelve digits at most, and not in the future: a start the clock has not reached yet would lengthen the budget.
  [[ "$started" =~ ^[1-9][0-9]{0,11}$ ]] && (( started <= now )) \
    || refuse "WATCHDOG_STEP_STARTED_AT must be the step's start in epoch seconds, not after now"
else
  started=$now
fi
[ "${1:-}" = -- ] || { echo "usage: vitest-watchdog.sh -- <command...>" >&2; exit 2; }
shift
[ "$#" -gt 0 ] || { echo "usage: vitest-watchdog.sh -- <command...>" >&2; exit 2; }
deadline=$(( started + minutes * unit ))

# Every diagnostic and scan is bounded, so a stalled one cannot hold the kill (#4647 BLIND P2).
bounded() { timeout -k 2 10 "$@"; }

# The command and every descendant of it, by walking ppid from the command's PID. Printed one PID per line.
tree() {
  local root=$1 frontier=$1 found="$1" next
  local table; table=$(bounded ps -eo pid=,ppid=)
  while [ -n "$frontier" ]; do
    next=$(awk -v f=" $frontier " 'index(f, " " $2 " ") { printf "%s ", $1 }' <<< "$table")
    frontier=${next% }
    [ -n "$frontier" ] && found="$found $frontier"
  done
  tr ' ' '\n' <<< "$found" | awk 'NF'
}

# Stop the command's group and its tree, then kill both. A scan and its STOP are not atomic: a process can fork between
# them, and that new process can fork again (#4647 LOCAL F1, Jane). So the tree is scanned and stopped repeatedly until
# a scan finds no PID not already stopped (bounded, so a tree growing faster than it is stopped still ends in a kill).
# The group signal covers what the walk cannot see: a descendant reparented away when its parent exited (BLIND P1).
pids=""
end_command() {
  kill -STOP -- "-$cmd" 2>/dev/null
  local new
  for _ in $(seq 50); do
    new=$(comm -13 <(sort -u <<< "$pids") <(tree "$cmd" | sort -u))
    [ -n "$new" ] || break
    # shellcheck disable=SC2086
    kill -STOP $new 2>/dev/null
    pids=$(printf '%s\n%s\n' "$pids" "$new" | awk 'NF' | sort -u)
  done
  kill -KILL -- "-$cmd" 2>/dev/null
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null
}

# What is still running (not a zombie) in the command's group or among the PIDs it signalled, one PID per line.
survivors() {
  bounded ps -eo pid=,pgid=,stat= | awk -v g="$cmd" -v p=" $(tr '\n' ' ' <<< "$pids") " \
    '$3 !~ /^Z/ && ($2 == g || index(p, " " $1 " ")) { print $1 }'
}

setsid "$@" &
cmd=$!
trap 'end_command; exit 143' TERM INT
while kill -0 "$cmd" 2>/dev/null; do
  if (( $(date +%s) >= deadline )); then
    echo "[watchdog] budget of ${minutes} min reached; process tree before the kill:"
    bounded ps -eo pid,ppid,pgid,rss,etime,comm
    echo "[sampler] $(date -u +%FT%TZ) (final, from the watchdog)"
    bounded free -m; bounded df -h /; bounded ps -eo rss,comm --sort=-rss | head -5
    end_command
    wait "$cmd" 2>/dev/null
    left=""
    for _ in $(seq 20); do left=$(survivors); [ -z "$left" ] && break; sleep 0.5; done
    if [ -z "$left" ]; then echo "[watchdog] vitest exceeded ${minutes} min; killed"
    else echo "[watchdog] vitest exceeded ${minutes} min; kill NOT verified, still running: $(tr '\n' ' ' <<< "$left")"; fi
    exit 124
  fi
  sleep 1
done
wait "$cmd"
exit $?
