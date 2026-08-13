#!/bin/sh
set -u

for container in \
  media-qbittorrent media-prowlarr media-radarr media-sonarr \
  media-jellyseerr media-flaresolverr hometube-worker musicplayer-worker
do
  docker stop --time 30 "$container" >/dev/null 2>&1 || true
done
