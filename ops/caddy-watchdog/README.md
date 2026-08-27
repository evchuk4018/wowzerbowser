# Caddy and Jellyfin host protection

This directory owns the reverse-proxy startup guard that is installed on the
homelab user systemd instance. It waits for the storage mount and Docker,
starts Caddy only when its bind-mounted files are regular files, and checks
Caddy's local admin endpoint every 30 seconds.

The installer also migrates the external media stack to advertise
`https://jellyfin.wowzerbowser.xyz` instead of the direct HTTP Tailscale port.
It preserves `TAILSCALE_HOST` because other media services use that value for
their private direct URLs.

Run the installer from the deployed checkout with:

```sh
bash /srv/storage/wowzerbowser/ops/caddy-watchdog/install-systemd.sh
```
