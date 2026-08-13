#!/bin/sh
set -eu

action=${1:?action is required}
exit_bridge=${2:-}
exit_gateway=${3:-172.24.0.2}
lan_cidr=192.168.0.0/24
tailnet_v4=100.64.0.0/10
tailnet_v6=fd7a:115c:a1e0::/48
docker_cidrs="172.17.0.0/16 172.18.0.0/16 172.19.0.0/16 172.20.0.0/16 172.21.0.0/16 172.22.0.0/16 172.23.0.0/16"
route_table_v4=51820
route_table_v6=51821
chain_v4=WOWZERBOWSER_TS_EXIT
chain_v6=WOWZERBOWSER_TS_EXIT6

ensure_nat_rule() {
  if ! iptables -t nat -C POSTROUTING "$@" 2>/dev/null; then
    iptables -t nat -I POSTROUTING 1 "$@"
  fi
}

remove_nat_rule() {
  while iptables -t nat -C POSTROUTING "$@" 2>/dev/null; do
    iptables -t nat -D POSTROUTING "$@"
  done
}

case "$action" in
  up|down) ;;
  *) echo "Unknown action: $action" >&2; exit 64 ;;
esac

lan_iface=$(ip -4 route show "$lan_cidr" | sed -n '1s/.* dev \([^ ]*\).*/\1/p')
[ -n "$lan_iface" ] || lan_iface=none

iptables -N "$chain_v4" 2>/dev/null || true
iptables -F "$chain_v4"
while iptables -C FORWARD -j "$chain_v4" 2>/dev/null; do
  iptables -D FORWARD -j "$chain_v4"
done
iptables -I FORWARD 1 -j "$chain_v4"

# Direct Tailnet traffic remains on tailscale0. LAN access is retained, but
# all other forwarded Tailnet traffic must use the dedicated VPN bridge.
iptables -A "$chain_v4" -i tailscale0 -o tailscale0 -j ACCEPT
if [ "$lan_iface" != none ]; then
  iptables -A "$chain_v4" -i tailscale0 -s "$tailnet_v4" -d "$lan_cidr" -o "$lan_iface" -j ACCEPT
  iptables -A "$chain_v4" -i "$lan_iface" -o tailscale0 -d "$tailnet_v4" \
    -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
fi
for docker_cidr in $docker_cidrs; do
  docker_iface=$(ip -4 route show "$docker_cidr" | sed -n '1s/.* dev \([^ ]*\).*/\1/p')
  if [ -n "$docker_iface" ]; then
    iptables -A "$chain_v4" -i tailscale0 -s "$tailnet_v4" -d "$docker_cidr" -o "$docker_iface" -j ACCEPT
    ensure_nat_rule -s "$tailnet_v4" -d "$docker_cidr" -o "$docker_iface" -j MASQUERADE
  fi
done
iptables -A "$chain_v4" -i br-+ -o tailscale0 -d "$tailnet_v4" \
  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
if [ -n "$exit_bridge" ] && [ "$action" = up ]; then
  iptables -A "$chain_v4" -i tailscale0 -s "$tailnet_v4" -o "$exit_bridge" -j ACCEPT
  iptables -A "$chain_v4" -i "$exit_bridge" -o tailscale0 \
    -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ensure_nat_rule -s "$tailnet_v4" -o "$exit_bridge" -j ACCEPT
else
  remove_nat_rule -s "$tailnet_v4" -o "$exit_bridge" -j ACCEPT
fi
ensure_nat_rule -s "$tailnet_v4" -d "$tailnet_v4" -o tailscale0 -j ACCEPT
if [ "$lan_iface" != none ]; then
  ensure_nat_rule -s "$tailnet_v4" -d "$lan_cidr" -o "$lan_iface" -j MASQUERADE
fi
iptables -A "$chain_v4" -i tailscale0 -j DROP

# Tailscale's own chains are retained, but the forward hook is after this
# fail-closed chain so it cannot accept Internet traffic first.
if iptables -L ts-input >/dev/null 2>&1; then
  while iptables -C INPUT -j ts-input 2>/dev/null; do
    iptables -D INPUT -j ts-input
  done
  iptables -I INPUT 1 -j ts-input
fi
if iptables -L ts-forward >/dev/null 2>&1; then
  while iptables -C FORWARD -j ts-forward 2>/dev/null; do
    iptables -D FORWARD -j ts-forward
  done
  iptables -A FORWARD -j ts-forward
fi
if iptables -t nat -L ts-postrouting >/dev/null 2>&1; then
  while iptables -t nat -C POSTROUTING -j ts-postrouting 2>/dev/null; do
    iptables -t nat -D POSTROUTING -j ts-postrouting
  done
  iptables -t nat -A POSTROUTING -j ts-postrouting
fi

ip6tables -N "$chain_v6" 2>/dev/null || true
ip6tables -F "$chain_v6"
while ip6tables -C FORWARD -j "$chain_v6" 2>/dev/null; do
  ip6tables -D FORWARD -j "$chain_v6"
done
ip6tables -I FORWARD 1 -j "$chain_v6"
ip6tables -A "$chain_v6" -i tailscale0 -o tailscale0 -j ACCEPT
ip6tables -A "$chain_v6" -i tailscale0 -j DROP
if ip6tables -L ts-input >/dev/null 2>&1; then
  while ip6tables -C INPUT -j ts-input 2>/dev/null; do
    ip6tables -D INPUT -j ts-input
  done
  ip6tables -I INPUT 1 -j ts-input
fi
if ip6tables -L ts-forward >/dev/null 2>&1; then
  while ip6tables -C FORWARD -j ts-forward 2>/dev/null; do
    ip6tables -D FORWARD -j ts-forward
  done
  ip6tables -A FORWARD -j ts-forward
fi
if ip6tables -t nat -L ts-postrouting >/dev/null 2>&1; then
  while ip6tables -t nat -C POSTROUTING -j ts-postrouting 2>/dev/null; do
    ip6tables -t nat -D POSTROUTING -j ts-postrouting
  done
  ip6tables -t nat -A POSTROUTING -j ts-postrouting
fi

sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null
sysctl -w net.ipv4.conf.default.rp_filter=2 >/dev/null
sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null

ip rule del pref 90 iif tailscale0 lookup "$route_table_v4" 2>/dev/null || true
ip rule add pref 90 iif tailscale0 lookup "$route_table_v4"
ip rule del pref 89 to "$tailnet_v4" lookup 52 2>/dev/null || true
ip rule add pref 89 to "$tailnet_v4" lookup 52
ip -4 route flush table "$route_table_v4" 2>/dev/null || true
if ip link show tailscale0 >/dev/null 2>&1; then
  ip -4 route replace "$tailnet_v4" dev tailscale0 table "$route_table_v4"
fi
if [ "$lan_iface" != none ]; then
  ip -4 route replace "$lan_cidr" dev "$lan_iface" table "$route_table_v4"
fi
for docker_cidr in $docker_cidrs; do
  docker_iface=$(ip -4 route show "$docker_cidr" | sed -n '1s/.* dev \([^ ]*\).*/\1/p')
  if [ -n "$docker_iface" ]; then
    ip -4 route replace "$docker_cidr" dev "$docker_iface" table "$route_table_v4"
  fi
done
if [ "$action" = up ] && [ -n "$exit_bridge" ] && ip link show "$exit_bridge" >/dev/null 2>&1; then
  ip -4 route replace 172.24.0.0/28 dev "$exit_bridge" scope link table "$route_table_v4"
  ip -4 route replace default via "$exit_gateway" dev "$exit_bridge" table "$route_table_v4"
else
  ip -4 route replace blackhole default table "$route_table_v4"
fi

ip -6 rule del pref 91 iif tailscale0 lookup "$route_table_v6" 2>/dev/null || true
ip -6 rule add pref 91 iif tailscale0 lookup "$route_table_v6"
ip -6 rule del pref 89 to "$tailnet_v6" lookup 52 2>/dev/null || true
ip -6 rule add pref 89 to "$tailnet_v6" lookup 52
ip -6 route flush table "$route_table_v6" 2>/dev/null || true
if ip link show tailscale0 >/dev/null 2>&1; then
  ip -6 route replace "$tailnet_v6" dev tailscale0 table "$route_table_v6"
fi
ip -6 route replace blackhole default table "$route_table_v6"
