import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("download gateway uses the supplied WireGuard file and a hard kill switch", async () => {
  const compose = await read("ops/download-vpn/compose.yaml");
  assert.match(compose, /image: qmcgaw\/gluetun:v3\.40\.4/);
  assert.match(compose, /container_name: download-vpn/);
  assert.match(compose, /target: \/gluetun\/wireguard\/wg0\.conf/);
  assert.match(compose, /windscribe-philadelphia\.resolved\.conf/);
  assert.match(compose, /name: wowzerbowser-download-vpn-exit/);
  assert.match(compose, /ipv4_address: 172\.24\.0\.2/);
  assert.match(compose, /subnet: 172\.24\.0\.0\/28/);
  assert.match(compose, /VPN_SERVICE_PROVIDER: custom/);
  assert.match(compose, /VPN_TYPE: wireguard/);
  assert.match(compose, /FIREWALL: on/);
  assert.match(compose, /FIREWALL_INPUT_PORTS: "8080,5055,7878,8989,9696,8191,4000"/);
  assert.match(compose, /FIREWALL_OUTBOUND_SUBNETS: .*172\.24\.0\.0\/28/);
  assert.match(compose, /hometube:\r?\n\s+ipv4_address: 172\.22\.0\.3/);
  assert.match(compose, /DNS_UPSTREAM_IPV6: off/);
  assert.match(compose, /test: \["CMD", "\/gluetun-entrypoint", "healthcheck"\]/);
  assert.doesNotMatch(compose, /PrivateKey|PresharedKey|WIREGUARD_PRIVATE_KEY/u);
});

test("VPN overlays remove direct network escape paths", async () => {
  const media = await read("ops/download-vpn/media-compose.vpn.yaml");
  for (const service of ["jellyseerr", "radarr", "sonarr", "qbittorrent", "prowlarr", "flaresolverr"]) {
    const start = media.indexOf(`  ${service}:`);
    const relativeNext = media.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:/u);
    const end = relativeNext < 0 ? media.length : start + 1 + relativeNext;
    const block = media.slice(start, end);
    assert.match(block, /network_mode: "container:download-vpn"/);
    assert.match(block, /!reset \[\]/);
  }
  const hometube = await read("ops/download-vpn/hometube-compose.vpn.yaml");
  assert.match(hometube, /worker:\r?\n    network_mode: "container:download-vpn"/);
  assert.match(hometube, /hometube-postgres/);
  const music = await read("ops/download-vpn/music-compose.vpn.yaml");
  assert.match(music, /worker:\r?\n    network_mode: "container:download-vpn"/);
  assert.match(music, /music-postgres/);
  assert.match(music, /music-navidrome/);
});

test("boot supervision requires a restrictive secret and keeps normal services outside", async () => {
  const supervisor = await read("ops/download-vpn/supervise.sh");
  const unit = await read("ops/download-vpn/wowzerbowser-download-vpn.service");
  assert.match(supervisor, /\/srv\/storage\/wowzerbowser\/secrets\/windscribe-philadelphia\.conf/);
  assert.match(supervisor, /expected_secret_mode/);
  assert.match(supervisor, /env_value HOMETUBE_POSTGRES_PASSWORD/);
  assert.match(supervisor, /env_value POSTGRES_PASSWORD/);
  assert.match(supervisor, /resolve-windscribe\.sh/);
  assert.match(supervisor, /gateway_health.*unhealthy/s);
  assert.match(supervisor, /restart_gateway/);
  assert.match(supervisor, /remove_targets/);
  assert.match(supervisor, /docker rm/);
  assert.match(supervisor, /stop_targets/);
  assert.match(supervisor, /start_vpn_targets/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /RequiresMountsFor=\/srv\/storage\/wowzerbowser/);
});

test("Tailscale exit routing is fail-closed and persistent", async () => {
  const host = await read("ops/download-vpn/host-network.sh");
  assert.match(host, /iif tailscale0 lookup "\$route_table_v4"/);
  assert.match(host, /blackhole default table "\$route_table_v4"/);
  assert.match(host, /blackhole default table "\$route_table_v6"/);
  assert.match(host, /-i tailscale0 -j DROP/);
  assert.match(host, /-o "\$exit_bridge" -j ACCEPT/);
  assert.match(host, /ip6tables -A FORWARD -j ts-forward/);
  assert.match(host, /WOWZERBOWSER_TS_EXIT/);
  const apply = await read("ops/download-vpn/exit-node-apply.sh");
  assert.match(apply, /br-wzvpnexit/);
  const unit = await read("ops/download-vpn/wowzerbowser-tailscale-exit.service");
  assert.match(unit, /advertise-exit-node=true/);
  assert.match(unit, /netfilter-mode=nodivert/);
  assert.match(unit, /exit-node-apply\.sh down/);
  const resolver = await read("ops/download-vpn/resolve-windscribe.sh");
  assert.match(resolver, /getent ahostsv4/);
  assert.match(resolver, /chmod 600/);
  assert.match(resolver, /ipv4_values/);
  assert.match(resolver, /\[Aa\]llowed\[Ii\]\[Pp\]\[Ss\]/);
});
