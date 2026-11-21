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
#   2. signals the command's process group, and only that group: TERM, a short grace, then KILL;
#   3. checks whether any member of that group is still running (a zombie is not), and prints one line saying what it
#      signalled and what it could observe; then exits 124 (GNU timeout's code for "the time ran out"), which vitest
#      itself does not use, so a watchdog kill is distinguishable from a test failure (exit 1).
# Inside the budget it returns the command's own exit code, unchanged. If the watchdog itself is sent TERM or INT (the
# step cancelled or timed out), it signals the command's group the same way before it exits 143, since the new session
# takes the command out of the step shell's group.
#
# ONLY THE GROUP IS EVER SIGNALLED (the gate's condition; Peter's design ruling on #4647, team chat #129455). The
# command starts under setsid, so it leads a new process group whose number is its own PID, and every signal goes to
# that group (kill -s <sig> -- -<pgid>). The kernel resolves the group's members when it delivers the signal, so there
# is no list of PIDs that could go stale and be reused by an outside process; and the group's members are the command
# and descendants that stayed in it, a subset of the step's own tree. Nothing is matched by name, and no individual PID
# is signalled. The group's number cannot be handed to another group while any member is alive.
#
# ACCEPTED RESIDUAL (Peter's ruling, team chat #128652, restated in #129455). A descendant that leaves the group (its own
# setsid or setpgid) is not signalled and can outlive the watchdog. This fails toward "no kill", never toward signalling
# an outside process; the step's 45-minute timeout is the backstop. So the final line never says a descendant outside
# the group was killed: it says the group was signalled and that escaped descendants are not covered. vitest's workers
# do not leave the group.
#
# The budget must be a positive integer below WATCHDOG_STEP_TIMEOUT_MINUTES, which the step sets equal to its own
# timeout-minutes (both pinned in vitest-watchdog.test.mjs), so the watchdog fires before the step timeout. It counts
# from WATCHDOG_STEP_STARTED_AT when that is set, so time the step spent before this script started (sampler setup,
# the bounded psql probe) comes out of the budget (#4647 BLIND P2); unset, it counts from this script's start. Both
# ends read the same monotonic clock, whole seconds since boot from /proc/uptime, so a wall-clock correction cannot
# stretch or shrink the budget. Set but empty (a failed read at step entry) is refused, never taken as "start now".
# A clock that cannot be read at start refuses; one lost after launch ends the command the same way as the budget, so
# the watchdog never stops watching silently.
#
# Worst case after the budget, well inside the five-minute margin: four diagnostics at up to 12 s each, a grace of
# 5 s after TERM, and verification polls for at most 15 s more, each poll bounded. Under two minutes.
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

# Running (not zombie) members of the command's process group, one PID per line. Fails when the process table cannot
# be read, so an unreadable table is never taken as "nothing left".
members() {
  local table; table=$(bounded ps -eo pid=,pgid=,stat=) || return 1
  awk -v g="$cmd" '$3 !~ /^Z/ && $2 == g { print $1 }' <<< "$table"
}

# Poll until the group has no running member, for up to $1 seconds by the clock; with no clock, one attempt only.
# Sets `left` to what is still running and `seen` when the table could be read on the last attempt.
await_empty() {
  local by="" t; t=$(now_s) && by=$(( t + $1 ))
  left="" seen=""
  while :; do
    if left=$(members); then seen=1; [ -z "$left" ] && return 0; else seen=""; left=""; fi
    t=$(now_s) && [ -n "$by" ] && (( t < by )) || return 1
    sleep 0.5
  done
}

# Signal the command's group, and only it: TERM, up to 5 s for it to empty, then KILL.
end_group() {
  kill -s TERM -- "-$cmd" 2>/dev/null
  await_empty 5 && return 0
  kill -s KILL -- "-$cmd" 2>/dev/null
}

setsid "$@" &
cmd=$!
trap 'end_group; exit 143' TERM INT
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
    end_group
    # No wait on the command: a process stuck in the kernel would hold it. A zombie counts as ended.
    if await_empty 15; then
      echo "[watchdog] ${why}; process group ${cmd} signalled and now empty; descendants that left the group are not covered"
    elif [ -n "$seen" ]; then
      echo "[watchdog] ${why}; process group ${cmd} signalled, kill NOT verified, still running: $(tr '\n' ' ' <<< "$left")"
    else
      echo "[watchdog] ${why}; process group ${cmd} signalled, kill NOT verified, the process table could not be read"
    fi
    exit 124
  fi
  sleep 1
done
wait "$cmd"
exit $?
