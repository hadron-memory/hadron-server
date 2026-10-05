#!/usr/bin/env bash
# Each name owns only its compose project / Incus container. No shared .env.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
action=${1:-}; name=${2:-}
if [[ ! "$action" =~ ^(up|down|check|logs)$ || ! "$name" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
  echo 'Usage: scripts/e2e/stack.sh {up|down|check|logs} NAME [API_PORT=18400] [PORTAL_PORT=18500]' >&2; exit 2
fi
export E2E_PORT=${3:-18400} E2E_PORTAL_PORT=${4:-18500}
for port in "$E2E_PORT" "$E2E_PORTAL_PORT"; do
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ && "$port" -ge 1024 && "$port" -le 65535 ]] || { echo 'Ports must be 1024..65535' >&2; exit 2; }
done
[[ "$E2E_PORT" != "$E2E_PORTAL_PORT" ]] || { echo 'API and portal ports must differ' >&2; exit 2; }
project="hadron-e2e-$name"
backend=${E2E_BACKEND:-auto}
if [[ "$backend" == auto ]]; then
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then backend=docker; else backend=incus; fi
fi
[[ "$backend" == docker || "$backend" == incus ]] || { echo 'E2E_BACKEND must be auto, docker or incus' >&2; exit 2; }
compose() {
  if [[ "$backend" == docker ]]; then
    docker compose --project-name "$project" --file "$ROOT/scripts/e2e/compose.yaml" "$@"
  else
    incus exec "$project" -- env E2E_PORT="$E2E_PORT" E2E_PORTAL_PORT="$E2E_PORTAL_PORT" E2E_BIND=0.0.0.0 \
      docker compose --project-name "$project" --file /opt/hadron/scripts/e2e/compose.yaml "$@"
  fi
}
case "$action" in
  up)
    # Refuse reuse: db push + seeding is deliberately fresh-only.
    if [[ "$backend" == incus ]]; then
      if incus info "$project" >/dev/null 2>&1; then echo "$project exists; down it first" >&2; exit 1; fi
      incus launch qa-docker "$project" -c security.nesting=true
      # Set an ownership marker; down refuses to delete an unmarked instance.
      incus config set "$project" user.hadron-e2e "$project"
      archive=$(mktemp)
      trap 'rm -f -- "$archive"' EXIT
      # Explicit tracked-file allowlist: never send .env, secrets, .git or deps.
      git -C "$ROOT" ls-files -z package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts tsconfig.json prisma src .dockerignore |
        tar -C "$ROOT" --null -T - -cf "$archive"
      tar -C "$ROOT" -rf "$archive" scripts/e2e
      incus file push "$archive" "$project/tmp/source.tar"
      incus exec "$project" -- sh -c 'mkdir -p /opt/hadron && tar -xf /tmp/source.tar -C /opt/hadron && rm -f /tmp/source.tar'
      for i in {1..30}; do incus exec "$project" -- docker info >/dev/null 2>&1 && break; sleep 1; done
    else
      if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
        echo "$project exists; down it first" >&2; exit 1
      fi
    fi
    compose up --build -d --wait --wait-timeout 300
    if [[ "$backend" == incus ]]; then
      address=$(incus exec "$project" -- ip -4 -o addr show dev eth0 | awk '{split($4,a,"/"); print a[1]}')
      state_dir="${XDG_RUNTIME_DIR:-/tmp}/hadron-e2e-$(id -u)"
      mkdir -p "$state_dir"; chmod 700 "$state_dir"
      nohup node "$ROOT/scripts/e2e/host-proxy.mjs" "$E2E_PORT" "$address" > "$state_dir/$project.log" 2>&1 < /dev/null &
      proxy_pid=$!
      incus config set "$project" user.hadron-e2e.api-port "$E2E_PORT"
      incus config set "$project" user.hadron-e2e.proxy-script "$ROOT/scripts/e2e/host-proxy.mjs"
      printf '%s\n' "$proxy_pid" > "$state_dir/$project.pid"
      sleep 1
      kill -0 "$proxy_pid" || { echo 'Loopback forwarder failed' >&2; exit 1; }
    fi
    compose exec -T app pnpm tsx scripts/e2e/seed.ts --check
    echo "Server: http://localhost:$E2E_PORT (GraphQL /graphql, MCP /mcp)"
    echo "Local portal origin: http://localhost:$E2E_PORTAL_PORT"
    echo 'Disposable credentials (save privately; rotate by down/up):'
    compose exec -T app cat /fixtures/credentials.json
    ;;
  down)
    if [[ "$backend" == incus ]]; then
      marker=$(incus config get "$project" user.hadron-e2e)
      [[ "$marker" == "$project" ]] || { echo 'Refusing to delete an unmarked Incus instance' >&2; exit 1; }
      state_dir="${XDG_RUNTIME_DIR:-/tmp}/hadron-e2e-$(id -u)"
      if [[ -f "$state_dir/$project.pid" ]]; then
        proxy_pid=$(cat "$state_dir/$project.pid")
        # Check the entire argv before signalling: PID reuse must not target a peer.
        script_path=$(incus config get "$project" user.hadron-e2e.proxy-script)
        api_port=$(incus config get "$project" user.hadron-e2e.api-port)
        address=$(incus exec "$project" -- ip -4 -o addr show dev eth0 | awk '{split($4,a,"/"); print a[1]}')
        if [[ "$proxy_pid" =~ ^[0-9]+$ && -r "/proc/$proxy_pid/cmdline" ]]; then
          mapfile -d '' -t argv < "/proc/$proxy_pid/cmdline"
          if [[ ${#argv[@]} -eq 4 && "${argv[0]}" == node && "${argv[1]}" == "$script_path" && "${argv[2]}" == "$api_port" && "${argv[3]}" == "$address" ]]; then
            kill "$proxy_pid"
          fi
        fi
        rm -f "$state_dir/$project.pid" "$state_dir/$project.log"
      fi
      incus delete "$project" --force
    else
      compose down --volumes --remove-orphans
    fi
    ;;
  check)
    compose exec -T app pnpm tsx scripts/e2e/seed.ts --check
    compose exec -T app node scripts/e2e/verify.mjs
    ;;
  logs) compose logs --tail 150 ;;
esac
