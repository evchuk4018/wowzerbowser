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
  lan_ip=${MEDIA_LAN_IP:-}
  if [ -z "$lan_ip" ]; then
    lan_ip=$(env_value MEDIA_LAN_IP)
  fi
  if [ -z "$lan_ip" ]; then
    lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)
  fi
  lan_ip=${lan_ip:-127.0.0.1}
  MEDIA_LAN_IP="$lan_ip" WINDSCRIBE_RESOLVED_CONF_PATH="$resolved_secret_path" docker compose -p wowzerbowser-download-vpn --env-file "$deployment_root/deployment.env" \
    -f "$vpn_file" "$@"
}

vpn_target_refs() {
  for service in jellyseerr radarr sonarr qbittorrent prowlarr flaresolverr; do
    docker ps -aq \
      --filter "label=com.docker.compose.project=media-stack" \
      --filter "label=com.docker.compose.service=$service"
  done
  docker ps -aq \
    --filter "label=com.docker.compose.project=hometube" \
    --filter "label=com.docker.compose.service=worker"
  docker ps -aq \
    --filter "label=com.docker.compose.project=musicplayer" \
    --filter "label=com.docker.compose.service=worker"
}

vpn_target_isolated() {
  project=$1
  service=$2
  containers=$(docker ps -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service")
  [ -n "$containers" ] || return 1
  for container in $containers; do
    network_mode=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null || true)
    [ "$network_mode" = "container:download-vpn" ] || return 1
  done
}

vpn_targets_are_isolated() {
  for service in jellyseerr radarr sonarr qbittorrent prowlarr flaresolverr; do
    vpn_target_isolated media-stack "$service" || return 1
  done
  vpn_target_isolated hometube worker || return 1
  vpn_target_isolated musicplayer worker || return 1
}

stop_targets() {
  vpn_target_refs | while IFS= read -r container; do
    [ -n "$container" ] || continue
    docker stop --time 30 "$container" >/dev/null 2>&1 || true
  done
}

remove_targets() {
  vpn_target_refs | while IFS= read -r container; do
    [ -n "$container" ] || continue
    docker rm "$container" >/dev/null 2>&1 || true
  done
}

remove_gateway() {
  vpn_compose rm -f download-vpn >/dev/null 2>&1 || true
}

restart_gateway() {
  stop_targets
  remove_targets
  vpn_compose stop download-vpn >/dev/null 2>&1 || true
  remove_gateway
  if ! "$resolver_script"; then
    echo "Download VPN endpoint resolution failed; will retry." >&2
    return 1
  fi
  if ! vpn_compose up -d download-vpn; then
    echo "Download VPN gateway failed to start; will retry." >&2
    return 1
  fi
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
remove_targets
remove_gateway
if ! vpn_compose up -d download-vpn; then
  echo "Download VPN gateway failed to start; will retry." >&2
fi
if ! start_normal_targets; then
  echo "Normal download-adjacent services failed to start; will retry." >&2
fi
last_healthy=0

while :; do
  gateway_state=$(docker inspect --format '{{.State.Status}}' download-vpn 2>/dev/null || true)
  gateway_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' download-vpn 2>/dev/null || true)
  if [ "$gateway_state" != running ] || [ "$gateway_health" = unhealthy ]; then
    restart_gateway
    last_healthy=0
  fi

  if vpn_health; then
    if [ "$last_healthy" -eq 0 ] || ! vpn_targets_are_isolated; then
      last_healthy=0
      if start_vpn_targets; then
        last_healthy=1
      else
        echo "VPN targets failed to start in the isolated network; will retry." >&2
      fi
    fi
  else
    stop_targets
    last_healthy=0
  fi
  sleep 15
done
