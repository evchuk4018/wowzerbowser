#!/bin/sh
set -eu

source_path=${WINDSCRIBE_CONF_PATH:-/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.conf}
resolved_path=${WINDSCRIBE_RESOLVED_CONF_PATH:-/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.resolved.conf}

if [ ! -f "$source_path" ] || [ -L "$source_path" ]; then
  echo "Missing regular Windscribe profile: $source_path" >&2
  exit 78
fi
if [ "$(stat -c '%u:%g:%a' "$source_path")" != "$(id -u):$(id -g):600" ]; then
  echo "The Windscribe profile must be owned by the service user with mode 0600: $source_path" >&2
  exit 78
fi

endpoint=$(sed -nE 's/^[[:space:]]*[Ee]ndpoint[[:space:]]*=[[:space:]]*([^[:space:]]+).*/\1/p' "$source_path" | head -n 1)
if [ -z "$endpoint" ]; then
  echo "The Windscribe profile has no WireGuard endpoint: $source_path" >&2
  exit 78
fi

endpoint_port=${endpoint##*:}
endpoint_host=${endpoint%:*}
case "$endpoint_port" in
  ''|*[!0-9]*) echo "The Windscribe endpoint port is invalid." >&2; exit 78 ;;
esac

endpoint_ip=$(getent ahostsv4 "$endpoint_host" | awk 'NR == 1 {print $1; exit}')
if [ -z "$endpoint_ip" ]; then
  echo "Could not resolve the Windscribe WireGuard endpoint." >&2
  exit 75
fi

resolved_dir=$(dirname -- "$resolved_path")
install -d -m 700 "$resolved_dir"
umask 077
tmp_path="${resolved_path}.tmp.$$"
trap 'rm -f -- "$tmp_path"' EXIT HUP INT TERM

awk -v replacement="$endpoint_ip:$endpoint_port" '
  BEGIN { replaced = 0 }
  {
    if (!replaced && $0 ~ /^[[:space:]]*[Ee]ndpoint[[:space:]]*=/) {
      sub(/=.*/, "= " replacement)
      replaced = 1
    }
    print
  }
' "$source_path" > "$tmp_path"
chmod 600 "$tmp_path"
mv -f -- "$tmp_path" "$resolved_path"
trap - EXIT HUP INT TERM
