#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_dir"

requires_storage_guard=0
if [ "$#" -eq 0 ]; then
  requires_storage_guard=1
else
  for argument in "$@"; do
    case "$argument" in
      --*) ;;
      up|start|restart|run|create)
        requires_storage_guard=1
        break
        ;;
      *)
        break
        ;;
    esac
  done
fi

if [ "$requires_storage_guard" -eq 1 ]; then
  "$script_dir/require-storage-mount.sh"
  export STORAGE_MOUNT_GUARD=verified
fi

exec docker compose "$@"
