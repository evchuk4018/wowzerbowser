#!/bin/sh
set -u

deployment_root=/srv/storage/wowzerbowser
media_root=/opt/media-stack
secret_path=${WINDSCRIBE_CONF_PATH:-/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.conf}
resolved_secret_path=${WINDSCRIBE_RESOLVED_CONF_PATH:-/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.resolved.conf}
resolver_script="${deployment_root}/ops/download-vpn/resolve-windscribe.sh"
vpn_file="${deployment_root}/ops/download-vpn/compose.yaml"
media_compose="${media_root}/compose.yml"
media_overlay="${deployment_root}/ops/download-vpn/media-compose.vpn.yaml"
hometube_compose="${deployment_root}/hometube/docker-compose.yml"
hometube_overlay="${deployment_root}/ops/download-vpn/hometube-compose.vpn.yaml"
music_root="${deployment_root}/files/musicplayer"
music_compose="${music_root}/docker-compose.yml"
music_homelab_override="${deployment_root}/files/home music/deploy/homelab/docker-compose.musicplayer.override.yml"
music_overlay="${deployment_root}/ops/download-vpn/music-compose.vpn.yaml"

env_value() {
  key=$1
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$deployment_root/deployment.env"
}

hometube_postgres_password=$(env_value HOMETUBE_POSTGRES_PASSWORD)
if [ -z "$hometube_postgres_password" ]; then
  hometube_postgres_password=$(env_value POSTGRES_PASSWORD)
fi
if [ -z "$hometube_postgres_password" ]; then
  echo "HomeTube Compose requires an existing PostgreSQL password in deployment.env" >&2
  exit 78
fi

vpn_compose() {
  WINDSCRIBE_RESOLVED_CONF_PATH="$resolved_secret_path" docker compose -p wowzerbowser-download-vpn --env-file "$deployment_root/deployment.env" \
    -f "$vpn_file" "$@"
}

stop_targets() {
  "$deployment_root/ops/download-vpn/stop.sh"
}

start_normal_targets() {
  docker compose -p media-stack --project-directory "$media_root" --env-file "$media_root/.env" \
    -f "$media_compose" up -d jellyfin || return 1
  HOMETUBE_POSTGRES_PASSWORD="$hometube_postgres_password" docker compose -p hometube --project-directory "$deployment_root/hometube" \
    --env-file "$deployment_root/deployment.env" -f "$hometube_compose" \
    up -d postgres web || return 1
  docker compose -p musicplayer --project-directory "$music_root" --env-file "$music_root/.env" \
    -f "$music_compose" -f "$music_homelab_override" up -d postgres navidrome web || return 1
}

start_vpn_targets() {
  docker compose -p media-stack --project-directory "$media_root" --env-file "$media_root/.env" \
    -f "$media_compose" -f "$media_overlay" up -d \
    jellyseerr radarr sonarr qbittorrent prowlarr flaresolverr || return 1
  HOMETUBE_POSTGRES_PASSWORD="$hometube_postgres_password" docker compose -p hometube --project-directory "$deployment_root/hometube" \
    --env-file "$deployment_root/deployment.env" -f "$hometube_compose" \
    -f "$hometube_overlay" up -d worker || return 1
  docker compose -p musicplayer --project-directory "$music_root" --env-file "$music_root/.env" \
    -f "$music_compose" -f "$music_homelab_override" -f "$music_overlay" \
    up -d worker || return 1
}

vpn_health() {
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' download-vpn 2>/dev/null || true)
  [ "$status" = healthy ]
}

gateway_running() {
  [ "$(docker inspect --format '{{.State.Status}}' download-vpn 2>/dev/null || true)" = running ]
}

shutdown() {
  stop_targets
  vpn_compose stop download-vpn >/dev/null 2>&1 || true
  exit 0
}
trap shutdown INT TERM

if ! "$deployment_root/docker/require-storage-mount.sh" >/dev/null; then
  exit 78
fi
if [ ! -f "$deployment_root/deployment.env" ]; then
  echo "Download VPN supervisor requires $deployment_root/deployment.env" >&2
  exit 78
fi
if [ ! -f "$secret_path" ] || [ -L "$secret_path" ]; then
  echo "Download VPN secret is missing or a symlink: $secret_path" >&2
  exit 78
fi
secret_mode=$(stat -c '%u:%g:%a' "$secret_path" 2>/dev/null || true)
expected_secret_mode="$(id -u):$(id -g):600"
if [ "$secret_mode" != "$expected_secret_mode" ]; then
  echo "Download VPN secret must be owned by the service user with mode 0600: $secret_path" >&2
  exit 78
fi
if ! "$resolver_script" >/dev/null; then
  exit 78
fi

stop_targets
vpn_compose up -d download-vpn >/dev/null 2>&1 || true
start_normal_targets >/dev/null 2>&1 || true
last_healthy=0

while :; do
  if ! gateway_running; then
    stop_targets
    if "$resolver_script" >/dev/null 2>&1; then
      vpn_compose up -d download-vpn >/dev/null 2>&1 || true
    fi
    last_healthy=0
  fi

  if vpn_health; then
    if [ "$last_healthy" -eq 0 ]; then
      if start_vpn_targets; then
        last_healthy=1
      fi
    fi
  else
    stop_targets
    last_healthy=0
  fi
  sleep 15
done
