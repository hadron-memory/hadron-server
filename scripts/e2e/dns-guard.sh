# Sourced by stack.sh. DNS guard for a freshly launched QA instance.
#
# History: #12129/#12157 (Clark) — fresh instances are intermittently born with
# a dead resolver (systemd-resolved's stub with no upstream; the bridge dnsmasq
# is healthy), so the guard probes resolution before anything needs the network
# and, if the stub stays dead, seeds a public resolver.
#
# Boot race (Hugo, 2026-10-19, hadron-server#2051 QA): `incus launch` returns
# before the instance has booted. In the first second /etc/resolv.conf is a
# symlink into /run/systemd/resolve/, which does not exist yet, so the SEED
# write fails with "cannot create /etc/resolv.conf: Directory nonexistent" —
# and the old shape, which seeded on the very first failed probe, exited the
# whole `up` on that. The resolver was fine one second later. So: keep probing
# for a while (the instance coming up is the usual cure), seed only after the
# resolver has stayed dead for E2E_DNS_SEED_AFTER probes, never let a failed
# seed end the run (the final probe decides), and fail loud if DNS never
# answers.
#   E2E_DNS_POLL_SECONDS  seconds between probes            (default 1)
#   E2E_DNS_SEED_AFTER    failed probes before seeding      (default 10)
#   E2E_DNS_WAIT_PROBES   total probes before giving up     (default 40)
e2e_dns_guard() {
  local project=$1 i seeded=0
  local poll=${E2E_DNS_POLL_SECONDS:-1} seed_after=${E2E_DNS_SEED_AFTER:-10} probes=${E2E_DNS_WAIT_PROBES:-40}
  dns_ok() { incus exec "$project" -- getent hosts deb.debian.org >/dev/null 2>&1; }
  for ((i = 1; i <= probes; i++)); do
    dns_ok && return 0
    if ((seeded == 0 && i >= seed_after)); then
      echo "$project: resolver not answering after $i probes; seeding 1.1.1.1 (dnsmasq race, #12129)" >&2
      # REPLACE the file rather than append (#1963): through a still-dangling
      # symlink an append cannot create its target. Only the instance's own
      # resolv.conf is touched, and a nameserver already seeded is left alone.
      incus exec "$project" -- sh -c 'grep -q "^nameserver 1.1.1.1$" /etc/resolv.conf 2>/dev/null || { rm -f /etc/resolv.conf && echo "nameserver 1.1.1.1" > /etc/resolv.conf; }' ||
        echo "$project: could not write the fallback resolver (/etc/resolv.conf); the final probe decides" >&2
      seeded=1
    fi
    sleep "$poll"
  done
  dns_ok || { echo "$project: DNS not answering after seeding; refusing to continue (incus network check next)" >&2; return 1; }
}
