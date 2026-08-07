#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_dir"

if [ -z "${DEPLOYMENT_ENV_FILE:-}" ] && [ -f /srv/storage/wowzerbowser/deployment.env ]; then
  export DEPLOYMENT_ENV_FILE=/srv/storage/wowzerbowser/deployment.env
fi

requires_storage_guard=0
requires_searxng_settings=0
if [ "$#" -eq 0 ]; then
  requires_storage_guard=1
else
  skip_option_value=0
  for argument in "$@"; do
    if [ "$skip_option_value" -eq 1 ]; then
      skip_option_value=0
      continue
    fi
    case "$argument" in
      --profile|--env-file|--project-name|--file)
        skip_option_value=1
        ;;
      --*) ;;
      up|start|restart|run|create)
        requires_storage_guard=1
        requires_searxng_settings=1
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

ensure_generated_searxng_settings() {
  application_root=/srv/storage/wowzerbowser
  config_root="$application_root/config"
  settings_dir="$config_root/searxng"
  settings_file="$settings_dir/settings.yml"
  baseline_file="$project_dir/docker/searxng/settings.yml"

  if [ -L "$config_root" ] || { [ -e "$config_root" ] && [ ! -d "$config_root" ]; }; then
    echo "Refusing to start: SearXNG config root is not a real directory: $config_root." >&2
    exit 78
  fi
  if [ -L "$settings_dir" ] || { [ -e "$settings_dir" ] && [ ! -d "$settings_dir" ]; }; then
    echo "Refusing to start: SearXNG settings directory is not a real directory: $settings_dir." >&2
    exit 78
  fi
  if [ -L "$settings_file" ]; then
    echo "Refusing to start: SearXNG settings file must not be a symlink: $settings_file." >&2
    exit 78
  fi

  if [ ! -e "$settings_dir" ]; then
    if ! (umask 027; mkdir -p -m 0750 -- "$settings_dir"); then
      echo "Refusing to start: could not create the SearXNG settings directory: $settings_dir." >&2
      exit 78
    fi
  fi

  if [ ! -e "$settings_file" ]; then
    if [ ! -f "$baseline_file" ] || [ -L "$baseline_file" ]; then
      echo "Refusing to start: checked-in SearXNG settings baseline is missing: $baseline_file." >&2
      exit 78
    fi

    bootstrap_tmp="$settings_file.bootstrap.$$"
    trap 'if [ -n "${bootstrap_tmp:-}" ]; then rm -f -- "$bootstrap_tmp"; fi' 0 1 2 15
    if ! (umask 027; cp -- "$baseline_file" "$bootstrap_tmp") || ! chmod 0640 -- "$bootstrap_tmp"; then
      echo "Refusing to start: could not stage the SearXNG settings baseline." >&2
      exit 78
    fi
    if ! ln -- "$bootstrap_tmp" "$settings_file" 2>/dev/null; then
      if [ -L "$settings_file" ] || [ ! -f "$settings_file" ]; then
        echo "Refusing to start: could not create the generated SearXNG settings file: $settings_file." >&2
        exit 78
      fi
    fi
    rm -f -- "$bootstrap_tmp"
    bootstrap_tmp=
    trap - 0 1 2 15
  fi

  if [ -L "$settings_file" ] || [ ! -f "$settings_file" ] || [ ! -s "$settings_file" ]; then
    echo "Refusing to start: generated SearXNG settings file is invalid: $settings_file." >&2
    exit 78
  fi
  if ! chmod 0640 -- "$settings_file" || [ ! -r "$settings_file" ] || [ ! -w "$settings_dir" ]; then
    echo "Refusing to start: generated SearXNG settings file is not readable or writable by the application owner." >&2
    exit 78
  fi
}

if [ "$requires_searxng_settings" -eq 1 ]; then
  ensure_generated_searxng_settings
fi

if [ -n "${DEPLOYMENT_ENV_FILE:-}" ]; then
  exec docker compose --env-file "$DEPLOYMENT_ENV_FILE" "$@"
fi

exec docker compose "$@"
