#!/bin/sh
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deployment_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
apply_script="$script_dir/exit-node-apply.sh"

gateway_healthy() {
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' download-vpn 2>/dev/null || true)" = healthy ]
}

shutdown() {
  "$apply_script" down >/dev/null 2>&1 || true
  exit 0
}
trap shutdown INT TERM

while :; do
  if "$deployment_root/docker/require-storage-mount.sh" >/dev/null 2>&1 && gateway_healthy; then
    "$apply_script" up >/dev/null 2>&1 || "$apply_script" down >/dev/null 2>&1 || true
  else
    "$apply_script" down >/dev/null 2>&1 || true
  fi
  sleep 15
done
