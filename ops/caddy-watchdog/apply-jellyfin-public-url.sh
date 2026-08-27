#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
readonly MEDIA_ROOT=${MEDIA_STACK_ROOT:-/opt/media-stack}
readonly MEDIA_COMPOSE="$MEDIA_ROOT/compose.yml"
readonly MEDIA_ENV="$MEDIA_ROOT/.env"
readonly PATCH_FILE="$SCRIPT_DIR/media-stack-jellyfin-public-url.patch"

if [[ ! -f "$MEDIA_COMPOSE" || ! -f "$MEDIA_ENV" || ! -f "$PATCH_FILE" ]]; then
  printf 'Jellyfin URL migration requires the media Compose files and patch.\n' >&2
  exit 78
fi

readonly OLD_COMPOSE_LINE='      JELLYFIN_PublishedServerUrl: http://${TAILSCALE_HOST}:${JELLYFIN_HOST_PORT}'
readonly NEW_COMPOSE_LINE='      JELLYFIN_PublishedServerUrl: ${JELLYFIN_PUBLISHED_SERVER_URL:-https://jellyfin.wowzerbowser.xyz}'
readonly NEW_ENV_LINE='JELLYFIN_PUBLISHED_SERVER_URL=https://jellyfin.wowzerbowser.xyz'
changed=0

if grep -Fq "$NEW_COMPOSE_LINE" "$MEDIA_COMPOSE" && grep -Fq "$NEW_ENV_LINE" "$MEDIA_ENV"; then
  printf 'Jellyfin published URL is already canonical.\n'
else
  if ! grep -Fq "$OLD_COMPOSE_LINE" "$MEDIA_COMPOSE"; then
    printf 'Refusing to patch an unexpected Jellyfin Compose definition.\n' >&2
    exit 78
  fi
  if grep -Fq 'JELLYFIN_PUBLISHED_SERVER_URL=' "$MEDIA_ENV"; then
    printf 'Refusing to overwrite an existing Jellyfin published URL.\n' >&2
    exit 78
  fi

  (CDPATH= cd -- "$MEDIA_ROOT" && patch --dry-run --batch --forward --strip=0 < "$PATCH_FILE")

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  compose_backup="$MEDIA_COMPOSE.bak-jellyfin-public-url-$timestamp"
  env_backup="$MEDIA_ENV.bak-jellyfin-public-url-$timestamp"
  cp --preserve=mode,ownership,timestamps "$MEDIA_COMPOSE" "$compose_backup"
  cp --preserve=mode,ownership,timestamps "$MEDIA_ENV" "$env_backup"
  (CDPATH= cd -- "$MEDIA_ROOT" && patch --batch --forward --strip=0 < "$PATCH_FILE")
  changed=1
  printf 'Updated Jellyfin published URL; backups: %s and %s\n' "$compose_backup" "$env_backup"
fi

compose=(/usr/bin/docker compose -p media-stack --project-directory "$MEDIA_ROOT" --env-file "$MEDIA_ENV" --file "$MEDIA_COMPOSE")
"${compose[@]}" config -q

container_env=$(/usr/bin/docker inspect media-jellyfin --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
if (( changed )) || ! grep -Fq 'JELLYFIN_PublishedServerUrl=https://jellyfin.wowzerbowser.xyz' <<< "$container_env"; then
  "${compose[@]}" up -d --no-deps --force-recreate --wait jellyfin
  printf 'Jellyfin was recreated with the canonical published URL.\n'
else
  printf 'Jellyfin is already running with the canonical published URL.\n'
fi
