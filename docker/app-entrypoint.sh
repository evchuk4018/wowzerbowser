#!/bin/sh
set -eu

if [ "${STORAGE_MOUNT_GUARD:-unverified}" != "verified" ]; then
  echo "Refusing to start: run ./docker/compose.sh after verifying /srv/storage is mounted." >&2
  exit 64
fi

storage_root=${APP_STORAGE_ROOT:-/srv/storage/wowzerbowser}
if [ ! -d "$storage_root" ]; then
  echo "Refusing to start: application storage is missing at $storage_root." >&2
  exit 65
fi

if [ -e /srv/storage/media ]; then
  echo "Refusing to start: /srv/storage/media is visible inside the application container." >&2
  exit 66
fi

if ! node /app/lib/runtime-preflight.mjs --startup; then
  echo "Refusing to start: runtime configuration or application storage preflight failed." >&2
  exit 68
fi

if [ "${SKIP_DATABASE_MIGRATION_CHECK:-0}" != "1" ]; then
  if ! node /app/scripts/migrate.mjs --check; then
    echo "Refusing to start: local PostgreSQL migrations are not current." >&2
    exit 67
  fi
fi

exec "$@"
