#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
unit_dir=${XDG_CONFIG_HOME:-/home/$(id -un)/.config}/systemd/user
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

if [ ! -d "$project_dir/ops/io-priority" ] || [ ! -x "$project_dir/ops/io-priority/apply.sh" ]; then
  echo "Refusing to install I/O policy: checked-out policy files are incomplete." >&2
  exit 78
fi
if [ ! -S "$runtime_dir/bus" ]; then
  echo "Refusing to install I/O policy: the user systemd bus is unavailable." >&2
  exit 78
fi

mkdir -p "$unit_dir"
ln -sfn "$project_dir/ops/io-priority/homelab-io-policy.service" "$unit_dir/homelab-io-policy.service"
ln -sfn "$project_dir/ops/io-priority/homelab-io-policy.timer" "$unit_dir/homelab-io-policy.timer"

export XDG_RUNTIME_DIR="$runtime_dir"
systemctl --user daemon-reload
systemctl --user enable --now homelab-io-policy.timer
"$project_dir/ops/io-priority/apply.sh" apply
printf 'Persistent user I/O policy installed and active.\n'
