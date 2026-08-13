#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
secret_path=${WINDSCRIBE_CONF_PATH:-/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.conf}

if [ ! -f "$secret_path" ] || [ -L "$secret_path" ]; then
  echo "Install the WireGuard profile at $secret_path before enabling the service." >&2
  exit 78
fi
if [ "$(stat -c '%u:%g:%a' "$secret_path")" != "$(id -u):$(id -g):600" ]; then
  echo "The WireGuard profile must be owned by the service user with mode 0600: $secret_path" >&2
  exit 78
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 0700 "$unit_dir"
install -m 0644 \
  "$script_dir/wowzerbowser-download-vpn.service" \
  "$unit_dir/wowzerbowser-download-vpn.service"
install -m 0644 \
  "$script_dir/wowzerbowser-tailscale-exit.service" \
  "$unit_dir/wowzerbowser-tailscale-exit.service"
systemctl --user daemon-reload
systemctl --user enable --now wowzerbowser-download-vpn.service
systemctl --user enable --now wowzerbowser-tailscale-exit.service
