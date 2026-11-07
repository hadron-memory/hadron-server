# shellcheck shell=bash
# Shared constants for the server#3601 bounded-PostgreSQL lab (proposal
# hrn:node:hadronmemory.com:hadron-dev-team-hugo:proposals:3601-bounded-pg r4).
# Sourced by every pg3601 script. Nothing here acts.
set -euo pipefail

PROJECT=user-988
INCUS=(incus --project "$PROJECT")
PROFILE=pg3601-bounded
VOLUME=pg3601-data
POOL=default
INSTANCE=pg3601-run
IMAGE_FP=985e718b7cea0c07e979020c12f56cb48713d08850139970fe1373989c8c4982
PG_MAJOR=17
PG_VERSION=17.11-0+deb13u1
CLUSTER=main
HARNESS_MANIFEST_SHA256=8b132fa42ac4bb2bba0c27906121503537f1505462828a7698763bf9eadb5a69
# r5: user-988 is a restricted project, and Incus 6.0.4 forbids the low-level
# key limits.memory.swap on its profiles and instances
# (internal/server/project/permissions.go isContainerLowLevelOptionForbidden).
# No-swap is enforced INSIDE the instance instead: one workload slice holds the
# postgres unit and, by systemd's dash nesting, pg3601-clients.slice. The
# descriptor's instance_cgroup names this slice; the profile's instance-wide
# caps (1GiB, 1 CPU, 512 pids) still apply around it.
WORKLOAD_SLICE=pg3601.slice
WORKLOAD_CG=/sys/fs/cgroup/$WORKLOAD_SLICE
CLIENT_CG=$WORKLOAD_CG/pg3601-clients.slice

# Host-side state: the .deb closure, receipts, lifecycle log. Never inside /tmp.
STATE=${PG3601_STATE:-$HOME/.local/state/pg3601}
DEBS=$STATE/debs
RECEIPTS=$STATE/receipts
LIFECYCLE_LOG=$RECEIPTS/lifecycle.jsonl
mkdir -p "$DEBS" "$RECEIPTS"

ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
mono() { awk '{print $1}' /proc/uptime; }
log() { printf '%s mono=%s %s\n' "$(ts)" "$(mono)" "$*" | tee -a "$RECEIPTS/events.log" >&2; }
# Every exec into the instance goes through the declared-exec ledger (P2-B/D):
# one JSON line per exec with its exact argv, written BEFORE the exec, so the
# audit can match each lifecycle instance-exec event by metadata.context.command.
DECLARED=$RECEIPTS/declared-execs.jsonl
declare_exec() { python3 -I -c 'import json,sys,time; print(json.dumps({"t":time.time(),"who":sys.argv[1],"argv":sys.argv[2:]}))' "${PG3601_WHO:-hugo}" "$@" >> "$DECLARED"; }
ix() { declare_exec "$@"; "${INCUS[@]}" exec "$INSTANCE" -- "$@"; }
# In-window file transfers are declared execs carrying the bytes on stdin (r4
# P2-E): Incus 6.0.4 `file push` goes over the SFTP API, which writes no
# lifecycle event, so a push would be invisible to the audit. Never `incus file`
# inside the window. put_file SRC DEST MODE: write via a temp name, root:root,
# then print the in-instance sha256, which the caller compares to the host's.
put_file() { ix sh -c 'umask 0377; cat > "$1.part" && chown 0:0 "$1.part" && chmod "$2" "$1.part" && mv -f "$1.part" "$1" && sha256sum "$1"' put "$2" "$3" < "$1"; }
mark() { python3 -I -c 'import json,sys,time; print(json.dumps({"t":time.time(),"mark":sys.argv[1]}))' "$1" >> "$RECEIPTS/marks.jsonl"; log "mark: $1"; }
# r4: systemd 257 prints NextElapseUSecMonotonic as a timespan ("4d 12h 10min
# 37.525706s"), never as microseconds; r3 read it as an integer and would have
# refused every handover. span_us parses it exactly (Decimal, systemd's unit
# lengths; checked against the raw D-Bus value) and refuses anything else.
span_us() { python3 -I -c 'import re,sys
from decimal import Decimal as D
U={"y":31557600000000,"month":2629800000000,"w":604800000000,"d":86400000000,"h":3600000000,"min":60000000,"s":1000000,"ms":1000,"us":1,"\u03bcs":1}
v=sys.argv[1].strip(); toks=re.findall(r"(\d+(?:\.\d+)?)(month|min|ms|us|\u03bcs|y|w|d|h|s)(?:\s+|$)",v)
assert toks and " ".join(n+u for n,u in toks)==" ".join(v.split()),"not a timespan: %r"%v
t=sum(D(n)*U[u] for n,u in toks); assert t==int(t) and t>0,"bad timespan: %r"%v
print(int(t))' "$1"; }
# span_of FILE: the parsed NextElapseUSecMonotonic of a recorded `systemctl show`.
span_of() { span_us "$(sed -n 's/^NextElapseUSecMonotonic=//p' "$1")"; }
# The 30-min stop timer's identity (r4 P3-2): compared at handover, close and end.
stop_timer_identity() { systemctl --user show pg3601-stop.timer -p ActiveState -p NextElapseUSecMonotonic -p InvocationID; }
monitor_identity() { systemctl --user show pg3601-monitor.service -p InvocationID -p ActiveEnterTimestampMonotonic -p NRestarts -p ActiveState -p MainPID; }
die() { log "FAIL: $*"; exit 1; }
