#!/usr/bin/env bash
# The ONLY way anyone other than Hugo's scripts may exec into pg3601-run:
# records the exact argv in the declared-exec ledger, then execs it. Atilla's
# single launch: PG3601_WHO=atilla exec-declared.sh /opt/pg3601/adapter/launch.sh
# Anything exec'd any other way shows up as undeclared and makes the run
# INCONCLUSIVE (audit-lifecycle.sh).
source "$(dirname "$0")/common.sh"
(( $# > 0 )) || die "usage: exec-declared.sh CMD [ARGS...]"
declare_exec "$@"
exec "${INCUS[@]}" exec "$INSTANCE" -- "$@"
