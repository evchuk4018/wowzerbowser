#!/bin/sh
set -eu

storage_root=/srv/storage
expected_label=homelab-storage
application_root="$storage_root/wowzerbowser"

if [ ! -d "$storage_root" ]; then
  echo "Storage directory is missing: $storage_root" >&2
  exit 70
fi

if ! command -v findmnt >/dev/null 2>&1 || ! command -v mountpoint >/dev/null 2>&1; then
  echo "Refusing to start: findmnt and mountpoint are required for the storage guard." >&2
  exit 71
fi

if ! mountpoint -q -- "$storage_root"; then
  echo "Refusing to start: $storage_root is not a mountpoint." >&2
  exit 72
fi

mount_target=$(findmnt -n -o TARGET --target "$storage_root")
mount_source=$(findmnt -n -o SOURCE --target "$storage_root")
mount_label=$(findmnt -n -o LABEL --target "$storage_root")
root_source=$(findmnt -n -o SOURCE --target /)

if [ "$mount_target" != "$storage_root" ]; then
  echo "Refusing to start: resolved storage target is $mount_target, not $storage_root." >&2
  exit 73
fi

if [ "$mount_source" = "$root_source" ]; then
  echo "Refusing to start: storage resolves to the root filesystem ($root_source)." >&2
  exit 74
fi

if [ "$mount_label" != "$expected_label" ]; then
  echo "Refusing to start: expected filesystem label $expected_label, found ${mount_label:-<none>}." >&2
  exit 75
fi

if [ ! -d "$application_root" ] || [ ! -d "$storage_root/media" ]; then
  echo "Refusing to start: expected application and media directories are missing." >&2
  exit 76
fi

if [ ! -w "$application_root" ]; then
  echo "Refusing to start: $application_root is not writable by the deployment user." >&2
  exit 77
fi

printf 'Storage guard passed: %s mounted from %s (label %s).\n' "$storage_root" "$mount_source" "$mount_label"
