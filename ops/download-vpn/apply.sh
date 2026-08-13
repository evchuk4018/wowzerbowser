#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployment_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
media_root=/opt/media-stack
secret_path=${WINDSCRIBE_CONF_PATH:-/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.conf}
stamp=$(date -u +%Y%m%dT%H%M%SZ)

env_value() {
  key=$1
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$deployment_root/deployment.env"
}

if [ ! -f "$secret_path" ] || [ -L "$secret_path" ]; then
  echo "Install the WireGuard profile at $secret_path before applying the gateway." >&2
  exit 78
fi
expected_secret_mode="$(id -u):$(id -g):600"
if [ "$(stat -c '%u:%g:%a' "$secret_path")" != "$expected_secret_mode" ]; then
  echo "The WireGuard profile must be owned by the service user with mode 0600: $secret_path" >&2
  exit 78
fi

"$deployment_root/docker/require-storage-mount.sh"

hometube_postgres_password=$(env_value HOMETUBE_POSTGRES_PASSWORD)
if [ -z "$hometube_postgres_password" ]; then
  hometube_postgres_password=$(env_value POSTGRES_PASSWORD)
fi
if [ -z "$hometube_postgres_password" ]; then
  echo "HomeTube Compose requires an existing PostgreSQL password in deployment.env" >&2
  exit 78
fi

backup_file() {
  source_path=$1
  if [ ! -f "$source_path" ]; then
    echo "Missing expected Compose file: $source_path" >&2
    exit 78
  fi
  backup_path="${source_path}.vpn-backup-${stamp}"
  cp -p -- "$source_path" "$backup_path"
  chmod --reference="$source_path" -- "$backup_path"
  printf 'vpn-backup\t%s\n' "$backup_path"
}

backup_file "$media_root/compose.yml"
backup_file "$deployment_root/hometube/docker-compose.yml"
backup_file "$deployment_root/files/musicplayer/docker-compose.yml"
backup_file "$deployment_root/files/home music/deploy/homelab/docker-compose.musicplayer.override.yml"

vpn_compose="${deployment_root}/ops/download-vpn/compose.yaml"
docker compose -p wowzerbowser-download-vpn --env-file "$deployment_root/deployment.env" \
  -f "$vpn_compose" config >/dev/null
docker compose -p media-stack --project-directory "$media_root" --env-file "$media_root/.env" \
  -f "$media_root/compose.yml" -f "$deployment_root/ops/download-vpn/media-compose.vpn.yaml" \
  config >/dev/null
HOMETUBE_POSTGRES_PASSWORD="$hometube_postgres_password" docker compose -p hometube --project-directory "$deployment_root/hometube" \
  --env-file "$deployment_root/deployment.env" -f "$deployment_root/hometube/docker-compose.yml" \
  -f "$deployment_root/ops/download-vpn/hometube-compose.vpn.yaml" config >/dev/null
docker compose -p musicplayer --project-directory "$deployment_root/files/musicplayer" \
  --env-file "$deployment_root/files/musicplayer/.env" \
  -f "$deployment_root/files/musicplayer/docker-compose.yml" \
  -f "$deployment_root/files/home music/deploy/homelab/docker-compose.musicplayer.override.yml" \
  -f "$deployment_root/ops/download-vpn/music-compose.vpn.yaml" config >/dev/null

"$script_dir/install-systemd.sh"
systemctl --user restart wowzerbowser-download-vpn.service
