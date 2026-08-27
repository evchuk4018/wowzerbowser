#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_ROOT=/srv/storage/wowzerbowser
readonly STORAGE_GUARD="$PROJECT_ROOT/docker/require-storage-mount.sh"
readonly CADDY_ROOT=/srv/storage/caddy
readonly CADDY_COMPOSE="$CADDY_ROOT/docker-compose.yml"
readonly CADDYFILE="$CADDY_ROOT/Caddyfile"
readonly CADDY_ADMIN_URL=http://127.0.0.1:2019/config/
readonly CHECK_INTERVAL=30
readonly RETRY_INTERVAL=15

compose=(/usr/bin/docker compose --project-directory "$CADDY_ROOT" --file "$CADDY_COMPOSE")
validated=0

log_line() {
  printf 'caddy-watchdog: %s\n' "$*"
}

wait_for_docker() {
  for _ in $(seq 1 60); do
    if /usr/bin/docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  log_line 'Docker did not become ready.' >&2
  return 1
}

storage_is_ready() {
  bash "$STORAGE_GUARD" >/dev/null 2>&1 || return 1
  [[ -f "$CADDYFILE" && -f "$CADDY_COMPOSE" ]]
}

caddy_state() {
  /usr/bin/docker inspect --format '{{.State.Status}}' caddy 2>/dev/null || printf 'missing'
}

start_caddy() {
  "${compose[@]}" up -d --no-build caddy
}

validate_caddy() {
  /usr/bin/docker exec caddy caddy validate \
    --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

admin_is_ready() {
  /usr/bin/curl --fail --silent --show-error --max-time 5 "$CADDY_ADMIN_URL" >/dev/null
}

ensure_caddy() {
  if ! storage_is_ready; then
    log_line 'Storage or Caddy configuration is not ready.' >&2
    return 1
  fi

  if [[ "$(caddy_state)" != running ]]; then
    log_line 'Starting the Caddy container.'
    start_caddy
    validated=0
  fi

  for _ in $(seq 1 30); do
    [[ "$(caddy_state)" == running ]] && break
    sleep 1
  done
  if [[ "$(caddy_state)" != running ]]; then
    log_line 'Caddy did not enter the running state.' >&2
    return 1
  fi

  if (( ! validated )); then
    if ! validate_caddy; then
      log_line 'Caddy configuration validation failed; leaving the container untouched.' >&2
      return 1
    fi
    validated=1
  fi

  if ! admin_is_ready; then
    log_line 'Caddy admin endpoint is unavailable; restarting the container.' >&2
    /usr/bin/docker restart caddy >/dev/null
    validated=0
    return 1
  fi
}

wait_for_docker
while :; do
  if ensure_caddy; then
    sleep "$CHECK_INTERVAL"
  else
    sleep "$RETRY_INTERVAL"
  fi
done
