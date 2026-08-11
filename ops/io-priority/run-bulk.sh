#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf 'Usage: %s command [argument ...]\n' "$0" >&2
  exit 2
fi

# Idle I/O plus a lower CPU niceness keeps ad-hoc backups, scans, and cache
# generation from competing with a user request. The cgroup policy handles
# containers; this wrapper handles host-native bulk commands.
exec ionice -c 3 nice -n 19 -- "$@"
