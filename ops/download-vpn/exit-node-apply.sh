#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=qmcgaw/gluetun:v3.40.4
network_name=wowzerbowser-download-vpn-exit
gateway_ip=172.24.0.2
action=${1:-down}

case "$action" in
  up|down) ;;
  *) echo "Usage: $0 up|down" >&2; exit 64 ;;
esac

exit_bridge=''
if exit_bridge=$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$network_name" 2>/dev/null); then
  case "$exit_bridge" in
    br-wzvpnexit) ;;
    *) echo "Unexpected Docker bridge name: $exit_bridge" >&2; exit 78 ;;
  esac
else
  if [ "$action" = up ]; then
    echo "Missing Docker network: $network_name" >&2
    exit 78
  fi
  exit_bridge=br-wzvpnexit
fi

docker run --rm --privileged --network host --pid host \
  --mount "type=bind,src=$script_dir/host-network.sh,dst=/run/host-network.sh,ro" \
  --entrypoint /bin/sh "$image" /run/host-network.sh "$action" "$exit_bridge" "$gateway_ip"
