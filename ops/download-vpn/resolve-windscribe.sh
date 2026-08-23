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

endpoint_ip=$(timeout 5s getent ahostsv4 "$endpoint_host" | awk 'NR == 1 {print $1; exit}' || true)
if [ -z "$endpoint_ip" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  # The tunnel cannot start until this host is resolved. Use HTTPS DNS when
  # the local resolver is unavailable, without weakening the tunnel firewall.
  endpoint_ip=$(
    curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
      --get --data-urlencode "name=$endpoint_host" --data-urlencode "type=A" \
      https://dns.google/resolve |
      jq -r --arg endpoint_host "$endpoint_host" '
        .Answer[]?
        | select(.type == 1)
        | select((.name | ascii_downcase) == (($endpoint_host | ascii_downcase) + "."))
        | .data
      ' |
      awk '/^[0-9]+(\.[0-9]+){3}$/ {print; exit}'
  ) || endpoint_ip=
fi
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
  function ipv4_values(value,    n, parts, i, token, result) {
    n = split(value, parts, /,[[:space:]]*/)
    result = ""
    for (i = 1; i <= n; i++) {
      token = parts[i]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", token)
      if (token != "" && token !~ /:/) {
        if (result != "") result = result ", "
        result = result token
      }
    }
    return result
  }
  BEGIN { replaced = 0 }
  {
    if (!replaced && $0 ~ /^[[:space:]]*[Ee]ndpoint[[:space:]]*=/) {
      sub(/=.*/, "= " replacement)
      replaced = 1
    }
    if ($0 ~ /^[[:space:]]*[Aa]ddress[[:space:]]*=/ || $0 ~ /^[[:space:]]*[Aa]llowed[Ii][Pp][Ss][[:space:]]*=/) {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/=.*/, "= " ipv4_values(value))
    }
    print
  }
' "$source_path" > "$tmp_path"
chmod 600 "$tmp_path"
mv -f -- "$tmp_path" "$resolved_path"
trap - EXIT HUP INT TERM
