#!/usr/bin/env bash
# Each name owns only its recorded backend, project, instance and forwarder.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
action=${1:-}; name=${2:-}
if [[ ! "$action" =~ ^(up|down|check|logs)$ || ! "$name" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo 'Usage: scripts/e2e/stack.sh {up|down|check|logs} NAME [API_PORT=18400] [PORTAL_PORT=18500]' >&2; exit 2
fi
[[ "${E2E_BIND:-127.0.0.1}" == 127.0.0.1 ]] || { echo 'Host publication must bind 127.0.0.1' >&2; exit 2; }
project="hadron-e2e-$name"
. "$ROOT/scripts/e2e/dns-guard.sh"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/hadron-e2e"
state_dir="$state_root/$project"
requested_backend=${E2E_BACKEND:-auto}
[[ "$requested_backend" =~ ^(auto|docker|incus)$ ]] || { echo 'E2E_BACKEND must be auto, docker or incus' >&2; exit 2; }
if [[ "$action" == up ]]; then
  export E2E_PORT=${3:-18400} E2E_PORTAL_PORT=${4:-18500}
  backend=$requested_backend
  if [[ "$backend" == auto ]]; then
    if command -v docker >/dev/null && docker info >/dev/null 2>&1; then backend=docker; else backend=incus; fi
  fi
else
  [[ -r "$state_dir/backend" ]] || { echo "No recorded stack $project; refusing to guess a backend" >&2; exit 1; }
  read -r backend < "$state_dir/backend"
  [[ "$backend" == docker || "$backend" == incus ]] || { echo 'Invalid recorded backend' >&2; exit 1; }
  [[ "$requested_backend" == auto || "$requested_backend" == "$backend" ]] || { echo 'Backend differs from recorded stack' >&2; exit 1; }
  read -r E2E_PORT < "$state_dir/api-port"
  read -r E2E_PORTAL_PORT < "$state_dir/portal-port"
  export E2E_PORT E2E_PORTAL_PORT
  [[ "${3:-$E2E_PORT}" == "$E2E_PORT" && "${4:-$E2E_PORTAL_PORT}" == "$E2E_PORTAL_PORT" ]] || { echo 'Ports differ from recorded stack' >&2; exit 1; }
fi
for port in "$E2E_PORT" "$E2E_PORTAL_PORT"; do
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ && "$port" -ge 1024 && "$port" -le 65535 ]] || { echo 'Ports must be 1024..65535' >&2; exit 2; }
done
[[ "$E2E_PORT" != "$E2E_PORTAL_PORT" ]] || { echo 'API and portal ports must differ' >&2; exit 2; }
compose() {
  if [[ "$backend" == docker ]]; then
    E2E_BIND=127.0.0.1 docker compose --project-name "$project" --file "$ROOT/scripts/e2e/compose.yaml" "$@"
  else
    incus exec "$project" -- env E2E_PORT="$E2E_PORT" E2E_PORTAL_PORT="$E2E_PORTAL_PORT" E2E_BIND=0.0.0.0 \
      docker compose --project-name "$project" --file /opt/hadron/scripts/e2e/compose.yaml "$@"
  fi
}
check_published() {
  local base="http://127.0.0.1:$E2E_PORT" body status
  body=$(curl --fail --silent --show-error --connect-timeout 2 --max-time 10 "$base/health")
  [[ "$body" == '{"ok":true}' ]] || { echo 'Published health response is not the Hadron stack' >&2; return 1; }
  status=$(curl --silent --show-error --connect-timeout 2 --max-time 10 -o /dev/null -w '%{http_code}' "$base/auth/dev/login?email=shared@e2e.test")
  [[ "$status" == 302 ]] || { echo "Published login handoff failed ($status)" >&2; return 1; }
  echo 'Published health and dev-login handoff PASS'
}
case "$action" in
  up)
    # Refuse reuse: db push + seeding is deliberately fresh-only.
    [[ ! -e "$state_dir" ]] || { echo "$project state exists; down it first" >&2; exit 1; }
    if [[ "$backend" == incus ]]; then
      if incus info "$project" >/dev/null 2>&1; then echo "$project exists; refusing to adopt it" >&2; exit 1; fi
    elif [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
      echo "$project exists; refusing to adopt it" >&2; exit 1
    fi
    mkdir -p "$state_root"; chmod 700 "$state_root"
    mkdir -m 700 "$state_dir"
    printf '%s\n' "$backend" > "$state_dir/backend"
    printf '%s\n' "$E2E_PORT" > "$state_dir/api-port"
    printf '%s\n' "$E2E_PORTAL_PORT" > "$state_dir/portal-port"
    if [[ "$backend" == incus ]]; then
      # Ownership metadata exists even if creation succeeds but boot fails.
      incus launch qa-docker "$project" -c security.nesting=true -c "user.hadron-e2e=$project"
      # DNS guard (#12129/#12157; boot race, hadron-server#2051): see dns-guard.sh.
      e2e_dns_guard "$project" || exit 1
      archive=$(mktemp)
      trap 'rm -- "$archive"' EXIT
      # Staged/tracked files only; never ship untracked notes or secrets.
      git -C "$ROOT" ls-files -z package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts tsconfig.json prisma src .dockerignore scripts/e2e |
        tar -C "$ROOT" --null -T - -cf "$archive"
      # Not /tmp (#2858): the instance mounts a tmpfs there shortly after
      # launch, which would hide an archive pushed before it.
      incus file push "$archive" "$project/opt/hadron-source.tar"
      incus exec "$project" -- sh -c 'mkdir -p /opt/hadron && tar -xf /opt/hadron-source.tar -C /opt/hadron && rm -f /opt/hadron-source.tar'
      for i in {1..30}; do incus exec "$project" -- docker info >/dev/null 2>&1 && break; sleep 1; done
    fi
    compose up --build -d --wait --wait-timeout 300
    if [[ "$backend" == incus ]]; then
      address=$(incus exec "$project" -- ip -4 -o addr show dev eth0 | awk '{split($4,a,"/"); print a[1]}')
      [[ -n "$address" ]] || { echo 'No QA bridge address' >&2; exit 1; }
      printf '%s\n' "$address" > "$state_dir/proxy-address"
      # Detach from the invoking terminal/process group, including agent hosts
      # that reap a completed command's remaining children.
      node "$ROOT/scripts/e2e/start-forwarder.mjs" "$state_dir" "$E2E_PORT" "$address"
      read -r proxy_pid < "$state_dir/proxy.pid"
      sleep 1
      kill -0 "$proxy_pid" || { echo 'Loopback forwarder failed' >&2; exit 1; }
    fi
    check_published
    compose exec -T app pnpm tsx scripts/e2e/seed.ts --check
    echo "Server: http://localhost:$E2E_PORT (GraphQL /graphql, MCP /mcp)"
    echo "Local portal origin: http://localhost:$E2E_PORTAL_PORT"
    echo 'Disposable credentials (save privately; rotate by down/up):'
    compose exec -T app cat /fixtures/credentials.json
    ;;
  down)
    if [[ "$backend" == incus ]]; then
      instance_exists=false
      # A failed launch may leave only recorded state. A successful list proves
      # absence; a daemon/permission failure must preserve state for recovery.
      instances=$(incus list --format csv -c n)
      while IFS= read -r instance; do
        [[ "$instance" != "$project" ]] || instance_exists=true
      done <<< "$instances"
      if [[ "$instance_exists" == true ]]; then
        marker=$(incus config get "$project" user.hadron-e2e)
        [[ "$marker" == "$project" ]] || { echo 'Refusing to delete an unmarked Incus instance' >&2; exit 1; }
      fi
      if [[ -r "$state_dir/proxy.pid" ]]; then
        read -r proxy_pid < "$state_dir/proxy.pid"
        read -r script_path < "$state_dir/proxy-script"
        read -r address < "$state_dir/proxy-address"
        # All expected argv values are cached; stopped instances need no exec.
        # A process exiting during the /proc read must not strand teardown.
        if [[ "$proxy_pid" =~ ^[0-9]+$ ]] && mapfile -d '' -t argv 2>/dev/null < "/proc/$proxy_pid/cmdline"; then
          if [[ ${#argv[@]} -eq 4 && "${argv[0]}" == node && "${argv[1]}" == "$script_path" && "${argv[2]}" == "$E2E_PORT" && "${argv[3]}" == "$address" ]]; then
            kill "$proxy_pid" 2>/dev/null || true
          fi
        fi
      fi
      if [[ "$instance_exists" == true ]]; then incus delete "$project" --force; fi
    else
      compose down --volumes --remove-orphans --rmi local
    fi
    # Only these known files belong to the lifecycle script.
    for file in backend api-port portal-port proxy.pid proxy-script proxy-address proxy.log; do
      [[ ! -e "$state_dir/$file" ]] || rm -- "$state_dir/$file"
    done
    rmdir "$state_dir"
    ;;
  check)
    check_published
    compose exec -T app pnpm tsx scripts/e2e/seed.ts --check
    compose exec -T app pnpm tsx scripts/e2e/verify.mjs
    ;;
  logs) compose logs --tail 150 ;;
esac
