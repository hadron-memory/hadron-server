#!/usr/bin/env bash
# Teardown for every path: normal | lease (60-min timer) | boot (host reboot
# inside the window). Idempotent; deletes the three objects, disarms every
# pg3601 unit, writes the proof listing. Never re-arms anything.
source "$(dirname "$0")/common.sh"
reason=${1:-normal}
log "teardown: reason=$reason"
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/lease-timer.end" 2>&1 || true
"${INCUS[@]}" delete --force "$INSTANCE" 2>&1 | tee -a "$RECEIPTS/events.log" || true
"${INCUS[@]}" storage volume delete "$POOL" "$VOLUME" 2>&1 | tee -a "$RECEIPTS/events.log" || true
"${INCUS[@]}" profile delete "$PROFILE" 2>&1 | tee -a "$RECEIPTS/events.log" || true
sleep 2
systemctl --user stop pg3601-stop.timer pg3601-monitor.service 2>/dev/null || true
systemctl --user disable --quiet pg3601-boot-teardown.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/pg3601-boot-teardown.service"; systemctl --user daemon-reload
[[ $reason == lease ]] || systemctl --user stop pg3601-lease.timer 2>/dev/null || true
{
  echo "# teardown proof ($reason), $(ts)"
  echo "instances:"; "${INCUS[@]}" list -f csv -c n | grep '^pg3601-' || echo "  none"
  echo "volumes:"; "${INCUS[@]}" storage volume list "$POOL" -f csv -c n | grep '^pg3601-' || echo "  none"
  echo "profiles:"; "${INCUS[@]}" profile list -f csv -c n | grep '^pg3601-' || echo "  none"
  echo "units:"; systemctl --user list-units --all --no-legend 'pg3601-*' | grep -v 'pg3601-lease' || echo "  none"
} > "$RECEIPTS/teardown.txt"
sha256sum "$RECEIPTS/teardown.txt" "$LIFECYCLE_LOG" "$RECEIPTS/events.log" | tee -a "$RECEIPTS/SHA256SUMS"
log "teardown: done"
