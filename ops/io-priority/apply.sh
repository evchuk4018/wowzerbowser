#!/usr/bin/env bash
set -euo pipefail

# Apply the host-wide policy without requiring root. The deployment user is in
# the docker group, and Docker applies --blkio-weight to the container's cgroup
# on the host's cgroup v2 io controller.

readonly DEFAULT_WEIGHT=200
readonly INTERACTIVE_WEIGHT=1000
readonly USER_WORK_WEIGHT=650
readonly BACKGROUND_WEIGHT=250
readonly BULK_WEIGHT=100

declare -A CONTAINER_WEIGHTS=(
  # Interactive applications and their durable state.
  [app-web-1]="$INTERACTIVE_WEIGHT"
  [app-postgres-1]="$INTERACTIVE_WEIGHT"
  [hometube-web-1]="$INTERACTIVE_WEIGHT"
  [hometube-postgres-1]="$INTERACTIVE_WEIGHT"
  [wowzerbowser-web-1]="$INTERACTIVE_WEIGHT"
  [wowzerbowser-postgres-1]="$INTERACTIVE_WEIGHT"
  [media-jellyfin]="$INTERACTIVE_WEIGHT"
  [media-jellyseerr]="$INTERACTIVE_WEIGHT"

  # Explicit media requests and user-triggered background work.
  # qBittorrent is the write path for explicitly requested media. Its own
  # queueing system keeps the torrent set bounded, so it can receive the top
  # weight without allowing every background service to compete with it.
  [media-qbittorrent]="$INTERACTIVE_WEIGHT"
  [media-radarr]="$USER_WORK_WEIGHT"
  [media-sonarr]="$USER_WORK_WEIGHT"
  [hometube-worker-1]="$USER_WORK_WEIGHT"
  [wowzerbowser-background-worker-1]="$USER_WORK_WEIGHT"
  [wowzerbowser-discord-1]="$USER_WORK_WEIGHT"

  # Useful but deferrable processing.
  [wowzerbowser-python-worker-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-opendataloader-hybrid-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-searxng-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-miniflux-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-miniflux-postgres-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-firecrawl-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-firecrawl-postgres-1]="$BACKGROUND_WEIGHT"
  [wowzerbowser-firecrawl-playwright-1]="$BACKGROUND_WEIGHT"

  # Indexer, resolver, and queue infrastructure should never crowd out a
  # requested download or an interactive application.
  [media-prowlarr]="$BULK_WEIGHT"
  [media-flaresolverr]="$BULK_WEIGHT"
  [wowzerbowser-firecrawl-redis-1]="$BULK_WEIGHT"
  [wowzerbowser-firecrawl-rabbitmq-1]="$BULK_WEIGHT"
)

dry_run=0
status_only=0
case "${1:-apply}" in
  apply) ;;
  --dry-run) dry_run=1 ;;
  status) status_only=1 ;;
  -h|--help)
    printf 'Usage: %s [apply|status|--dry-run]\n' "$0"
    exit 0
    ;;
  *)
    printf 'Unknown command: %s\n' "$1" >&2
    exit 2
    ;;
esac

if ! docker info >/dev/null 2>&1; then
  printf 'Docker is unavailable; I/O policy was not applied.\n' >&2
  exit 1
fi

if [[ ! -r /sys/fs/cgroup/cgroup.controllers ]] || ! grep -qw io /sys/fs/cgroup/cgroup.controllers; then
  printf 'The host does not expose the cgroup v2 io controller; refusing a false-success policy.\n' >&2
  exit 1
fi

mapfile -t containers < <(docker ps -a --format '{{.Names}}' | sort)

known_weight() {
  local name="$1"
  if [[ -n "${CONTAINER_WEIGHTS[$name]+set}" ]]; then
    printf '%s' "${CONTAINER_WEIGHTS[$name]}"
  else
    printf '%s' "$DEFAULT_WEIGHT"
  fi
}

print_status() {
  local name="$1" desired current state
  desired="$(known_weight "$name")"
  current="$(docker inspect --format '{{.HostConfig.BlkioWeight}}' "$name" 2>/dev/null || printf 'missing')"
  state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || printf 'missing')"
  printf '%-42s state=%-10s weight=%s desired=%s\n' "$name" "$state" "$current" "$desired"
}

if (( status_only )); then
  for container in "${containers[@]}"; do
    print_status "$container"
  done
  exit 0
fi

changed=0
for container in "${containers[@]}"; do
  desired="$(known_weight "$container")"
  current="$(docker inspect --format '{{.HostConfig.BlkioWeight}}' "$container" 2>/dev/null || printf 'missing')"
  if [[ "$current" == "$desired" ]]; then
    continue
  fi
  if (( dry_run )); then
    printf 'would set %-42s %s -> %s\n' "$container" "$current" "$desired"
    continue
  fi
  docker update --blkio-weight "$desired" "$container" >/dev/null
  printf 'set %-42s %s -> %s\n' "$container" "$current" "$desired"
  changed=$((changed + 1))
done

if (( ! dry_run )); then
  printf 'I/O policy applied; changed %s container weight(s).\n' "$changed"
fi
