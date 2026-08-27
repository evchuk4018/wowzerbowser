#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
unit_dir=${XDG_CONFIG_HOME:-/home/$(id -un)/.config}/systemd/user
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

if [ ! -x "$project_dir/docker/require-storage-mount.sh" ]; then
  echo "Refusing to install Caddy watchdog: the checked-out storage guard is missing." >&2
  exit 78
fi
if [ ! -f /srv/storage/caddy/Caddyfile ] || [ ! -f /srv/storage/caddy/docker-compose.yml ]; then
  echo "Refusing to install Caddy watchdog: the Caddy source files are unavailable." >&2
  exit 78
fi
if [ ! -S "$runtime_dir/bus" ]; then
  echo "Refusing to install Caddy watchdog: the user systemd bus is unavailable." >&2
  exit 78
fi

bash "$script_dir/apply-jellyfin-public-url.sh"

install -d -m 0700 "$unit_dir"
ln -sfn "$script_dir/caddy-watchdog.service" "$unit_dir/caddy-watchdog.service"

export XDG_RUNTIME_DIR="$runtime_dir"
systemctl --user daemon-reload
systemctl --user enable --now caddy-watchdog.service
printf 'Storage-gated Caddy watchdog installed and active.\n'
