#!/usr/bin/env bash
# #4646 (Refs #4278): an in-VM watchdog for the test-shard vitest step.
#
# usage: WATCHDOG_MINUTES=<n> WATCHDOG_STEP_TIMEOUT_MINUTES=<m> [WATCHDOG_STEP_STARTED_AT=<s since boot>] \
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
#   3. checks what it can observe: that no member of the command's process group and none of the walked PIDs is still
#      running (a zombie is not running). It does not prove a process it never found has ended (see the residuals).
#      It prints
#      "[watchdog] vitest exceeded N min; killed", or, if something is, "...; kill NOT verified, still running: <pids>";
#      either way it exits 124 (GNU timeout's code for "the time ran out"), which vitest itself does not use, so a
#      watchdog kill is distinguishable from a test failure (exit 1).
# Inside the budget it returns the command's own exit code, unchanged. If the watchdog itself is sent TERM or INT (the
# step cancelled or timed out), it kills the command's group and tree before it exits, since the new session takes the
# command out of the step shell's group.
#
# The budget must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES, which the step sets equal to its own
# timeout-minutes (both pinned in vitest-watchdog.test.mjs), so the watchdog fires before the step timeout. It counts
# from WATCHDOG_STEP_STARTED_AT when that is set, so time the step spent before this script started (sampler setup,
# the bounded psql probe) comes out of the budget (#4647 BLIND P2); unset, it counts from this script's start. Both
# ends read the same monotonic clock, whole seconds since boot from /proc/uptime, so a wall-clock correction cannot
# stretch or shrink the budget (BLIND delta P2). Set but empty (a failed read at step entry) is refused, never taken
# as "start now".
#
# Worst case after the budget (BLIND delta P2), well inside the five-minute margin: four diagnostics at up to 12 s
# each; the stop-and-scan loop ends one test "minute" (60 s in CI) after it starts, with at most one more scan (12 s),
# and the KILL is always sent; verification polls for at most 15 s more, each poll bounded. About 2.5 minutes.
#
# THE KILL NEVER WIDENS (the gate's condition, Peter's ruling on #4647, team chat #128652). Only two handles are ever
# signalled: the command's own process group (its number cannot be reused while any member is alive) and PIDs found by
# walking ppid down from the command. A walked PID gets the KILL only if it is still stopped at that moment, so a PID
# that died after its STOP and was reused by an outside process (which this watchdog never stopped) is left alone.
#
# ACCEPTED RESIDUALS (same ruling). Each one fails toward "no kill", never toward signalling an outside PID; the step's
# 45-minute timeout is the backstop, and the line printed says the kill was not verified wherever the watchdog can see
# it:
#   1. a descendant that both leaves the group (its own setsid) and is reparented away before any scan sees it is in
#      neither handle: it is not signalled and can outlive a "killed" line. Only a cgroup would close this; vitest and
#      its workers never leave the group.
#   2. awk, sort or comm failing after ps succeeded: the walk yields fewer PIDs (at worst the command alone), never a
#      PID the table did not show as a descendant, so fewer processes are stopped and killed.
#   3. a stall inside a scan after the table is read: the KILL waits for that scan (only ps is bounded inside it); the
#      group is already stopped, so nothing in it runs meanwhile.
#   4. the step's own preflight before the watchdog starts (nproc): unbounded, but it signals nothing.
#
# AND THE VM: this fires only if the VM is still scheduling processes at the budget. If the next loss is the VM
# freezing outright, no dump appears, and that absence is itself the finding for #4278.
#
# WATCHDOG_SECONDS_PER_MINUTE (default 60) exists only for the tests, so a "minute" can be one second; CI never sets it.
# WATCHDOG_UPTIME_FILE (default /proc/uptime) also exists only for the tests, to make the clock unreadable; CI never
# sets it.
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
# Whole seconds since boot: monotonic, and the same clock the step read at its entry.
clock=${WATCHDOG_UPTIME_FILE:-/proc/uptime}
now_s() {
  local up _rest; read -r up _rest < "$clock" 2>/dev/null || return 1
  up=${up%.*}; [[ "$up" =~ ^[0-9]{1,12}$ ]] || return 1; echo "$(( 10#$up ))"
}
now=$(now_s) || { echo "[watchdog] cannot read the clock ($clock); refusing" >&2; exit 2; }
if [ -n "${WATCHDOG_STEP_STARTED_AT+set}" ]; then
  # Twelve digits at most, and not in the future: a start the clock has not reached yet would lengthen the budget.
  [[ "$started" =~ ^[0-9]{1,12}$ ]] && (( 10#$started <= now )) \
    || refuse "WATCHDOG_STEP_STARTED_AT must be the step's start in whole seconds since boot (/proc/uptime), not after now"
  started=$(( 10#$started ))
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
  local table; table=$(bounded ps -eo pid=,ppid=) || return 1   # a failed scan is reported, never read as "no PIDs"
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
# The loop has one elapsed-time bound (one "minute" from its start) besides its round count, so a slow scan that keeps
# finding new PIDs cannot hold the KILL; a scan that fails ends the loop and leaves the kill unverified (BLIND delta).
pids=""
scan_failed=""
end_command() {
  kill -STOP -- "-$cmd" 2>/dev/null
  # One "minute" (60 s in CI), and never under 5 s: the clock has whole seconds and a test "minute" is one.
  # A clock that cannot be read ends the loop at once; the KILL below still goes out (#4647 BLIND delta 3).
  local new cur t stop_by=0
  t=$(now_s) && stop_by=$(( t + (unit < 5 ? 5 : unit) ))
  for _ in $(seq 50); do
    t=$(now_s) && (( t < stop_by )) || break
    cur=$(tree "$cmd") || { scan_failed=1; break; }
    new=$(comm -13 <(sort -u <<< "$pids") <(sort -u <<< "$cur"))
    [ -n "$new" ] || break
    # shellcheck disable=SC2086
    kill -STOP $new 2>/dev/null
    pids=$(printf '%s\n%s\n' "$pids" "$new" | awk 'NF' | sort -u)
  done
  kill -KILL -- "-$cmd" 2>/dev/null
  # Only walked PIDs that are still stopped: one that is not was either resumed by someone else or is no longer the
  # process this watchdog stopped (a reused PID). Leaving it fails toward "no kill", and verification reports it.
  local p line state still=""
  for p in $pids; do
    line=$(< "/proc/$p/stat") 2>/dev/null || continue
    state=${line##*) }; state=${state%% *}   # after the LAST ")": the command name may contain one
    [[ "$state" == [Tt] ]] && still="$still $p"
  done
  # shellcheck disable=SC2086
  [ -n "$still" ] && kill -KILL $still 2>/dev/null
}

# What is still running (not a zombie) in the command's group or among the PIDs it signalled, one PID per line. Fails
# when the process table cannot be read, so an unreadable table is never taken as "nothing left" (BLIND delta P1).
survivors() {
  local table; table=$(bounded ps -eo pid=,pgid=,stat=) || return 1
  awk -v g="$cmd" -v p=" $(tr '\n' ' ' <<< "$pids") " '$3 !~ /^Z/ && ($2 == g || index(p, " " $1 " ")) { print $1 }' <<< "$table"
}

setsid "$@" &
cmd=$!
trap 'end_command; exit 143' TERM INT
while kill -0 "$cmd" 2>/dev/null; do
  # A clock read that fails after launch is not "the budget is not reached yet": the watchdog says so and ends the
  # command the same way, so it can never stop watching silently (#4647 BLIND delta 3).
  lost_clock=""
  t=$(now_s) || lost_clock=1
  if [ -n "$lost_clock" ] || (( t >= deadline )); then
    if [ -n "$lost_clock" ]; then
      why="watchdog lost its clock"; echo "[watchdog] cannot read the clock ($clock); process tree before the kill:"
    else
      why="vitest exceeded ${minutes} min"; echo "[watchdog] budget of ${minutes} min reached; process tree before the kill:"
    fi
    bounded ps -eo pid,ppid,pgid,rss,etime,comm
    echo "[sampler] $(date -u +%FT%TZ) (final, from the watchdog)"
    bounded free -m; bounded df -h /; bounded ps -eo rss,comm --sort=-rss | head -5
    end_command
    # No wait on the command: a process stuck in the kernel would hold it. A zombie counts as ended, so the check
    # needs no reaping; it polls, bounded, until nothing it signalled is running or the table cannot be read.
    left="" verified="" verify_by=0 polls=0
    t=$(now_s) && verify_by=$(( t + 15 ))
    while :; do
      if left=$(survivors); then [ -z "$left" ] && { verified=1; break; }; else left=""; fi
      # 15 s by the clock, or 30 polls when the clock cannot be read.
      polls=$(( polls + 1 )); (( polls < 30 )) || break
      if t=$(now_s); then (( t < verify_by )) || break; fi
      sleep 0.5
    done
    if [ -n "$scan_failed" ]; then
      echo "[watchdog] ${why}; kill NOT verified, a process scan failed"
    elif [ -n "$verified" ]; then
      echo "[watchdog] ${why}; killed"
    elif [ -n "$left" ]; then
      echo "[watchdog] ${why}; kill NOT verified, still running: $(tr '\n' ' ' <<< "$left")"
    else
      echo "[watchdog] ${why}; kill NOT verified, the process table could not be read"
    fi
    exit 124
  fi
  sleep 1
done
wait "$cmd"
exit $?
