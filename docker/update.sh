#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_dir"

if [ "$(git branch --show-current)" != "main" ]; then
  echo "Refusing update: the deployment checkout must be on main." >&2
  exit 70
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing update: tracked deployment changes are present; preserve them before updating." >&2
  exit 71
fi
"$script_dir/require-storage-mount.sh"
export STORAGE_MOUNT_GUARD=verified

echo "deployment-update\tpull"
git pull --ff-only origin main

compose="$script_dir/compose.sh"
echo "deployment-update\tvalidate-compose"
"$compose" config >/dev/null

echo "deployment-update\tbuild"
"$compose" build web background-worker opendataloader-hybrid

echo "deployment-update\tstart-dependencies"
"$compose" up -d postgres opendataloader-hybrid

echo "deployment-update\tstart-search-stack"
"$compose" up -d searxng redlib miniflux-postgres miniflux firecrawl-redis firecrawl-rabbitmq firecrawl-postgres firecrawl-playwright firecrawl

echo "deployment-update\tapply-migrations"
"$compose" run --rm --no-deps -T -e SKIP_DATABASE_MIGRATION_CHECK=1 web node scripts/migrate.mjs --initialize

echo "deployment-update\trestart-app"
"$compose" up -d --force-recreate web background-worker opendataloader-hybrid

echo "deployment-update\tprovision-miniflux-feeds"
if ! "$compose" run --rm --no-deps -T web node scripts/provision-miniflux-feeds.mjs; then
  echo "deployment-update\tminiflux-feed-provisioning-warning" >&2
fi

if [ "${ENABLE_DISCORD_PROFILE:-0}" = "1" ]; then
  echo "deployment-update\trestart-discord"
  "$compose" --profile discord up -d --force-recreate discord
fi

echo "deployment-update\tstatus"
"$compose" ps
