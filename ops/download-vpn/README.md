# Download-only Windscribe gateway

This directory defines the isolated network namespace for services whose
purpose is acquiring external media. It does not change the host default
route and it does not route Tailscale, SSH, Drive, Jellyfin, Navidrome, their
databases, or the normal Wowzer Bowser services through Windscribe.

The `download-vpn` Gluetun container owns the network namespace. Its built-in
firewall remains enabled even when the WireGuard tunnel is down, so containers
using `network_mode: container:download-vpn` cannot fall back to the host WAN.
The gateway is attached to the existing media, HomeTube, Wowzer Bowser, and
music bridges only so local service and database names continue to resolve.

## Secret location

Install the generated profile, without changing its contents, at:

```text
/srv/storage/wowzerbowser/secrets/windscribe-philadelphia.conf
```

It must be a regular file owned by the service user with mode `0600`. It is never
stored in Git, Compose environment variables, or logs. Rotate it by installing
the replacement at the same path, checking its ownership/mode, and restarting
`wowzerbowser-download-vpn.service`.

Gluetun requires a numeric WireGuard endpoint. At startup,
`resolve-windscribe.sh` resolves only the profile's endpoint hostname and
creates the runtime-only `windscribe-philadelphia.resolved.conf` beside the
source profile, also mode `0600`. The source profile remains authoritative and
is never rewritten or displayed. Because the existing VPN namespace is
IPv4-only, the derived copy also removes IPv6 interface-address and peer-route
entries; IPv6 Internet traffic is blocked rather than sent outside Windscribe.

## Startup and operations

The system unit is installed with:

```bash
/srv/storage/wowzerbowser/ops/download-vpn/install-systemd.sh
```

It starts after Docker and the storage mount. The supervisor starts the VPN
gateway first, waits for Gluetun's actual healthcheck, then starts the isolated
media/HomeTube/music workers. On a VPN health failure it stops those workers;
normal services continue independently.

Useful checks:

```bash
systemctl status wowzerbowser-download-vpn.service
docker inspect --format '{{.State.Health.Status}}' download-vpn
docker compose -p wowzerbowser-download-vpn -f /srv/storage/wowzerbowser/ops/download-vpn/compose.yaml ps
systemctl --user status wowzerbowser-tailscale-exit.service
tailscale status --json
ip rule show
ip route show table 51820
```

To add a future downloader, put it in the appropriate overlay with:

```yaml
network_mode: "container:download-vpn"
networks: !reset []
dns:
  - 127.0.0.1
```

If it needs a web UI, add its port to the gateway's `ports` and
`FIREWALL_INPUT_PORTS`. If it needs a local service, attach the gateway to
that existing bridge and add only the required bridge CIDR to
`FIREWALL_OUTBOUND_SUBNETS`. Verify its exit IP from the shared namespace and
repeat the kill-switch test before enabling downloads.

To remove a service from VPN routing, remove its overlay entry, stop it, and
start it with its original Compose file. Do not remove the gateway's firewall
or attach a downloader directly to a normal bridge.

The Tailscale exit-node path is separate from the media sidecars. The gateway
also owns the fixed bridge `wowzerbowser-download-vpn-exit` at
`172.24.0.0/28`; host traffic arriving on `tailscale0` is sent there only when
the gateway health check is green. The host policy table `51820` uses a
blackhole default when it is not green. Tailscale-to-Tailscale, LAN, and
Docker-local destinations remain on their direct routes. IPv6 Internet
forwarding from `tailscale0` is dropped; Tailnet IPv6 destinations remain on
Tailscale.

## Rollback

Backups of the externally managed Compose files are created beside each file
before applying the overlays. To roll back, stop the supervisor, stop the
isolated services, restore the exact pre-change Compose files from those
backups, and start each original project using its original Compose command.
The persistent config directories and volumes are not removed, and no
`docker compose down -v` or global prune is used.
