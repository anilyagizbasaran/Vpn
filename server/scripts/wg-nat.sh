#!/usr/bin/env bash
# wg-nat.sh — idempotent NAT/forward rules for a WireGuard interface.
#
# Called from wg0.conf PostUp/PostDown. Every rule is added with a "-C" check
# first, so running it twice is a no-op instead of duplicating rules, and
# removing a rule that is already gone is not an error.
#
# Usage: wg-nat.sh up|down <interface> <pool-cidr> [wan-interface]

set -euo pipefail

ACTION="${1:?usage: wg-nat.sh up|down <iface> <pool-cidr> [wan]}"
WG_IF="${2:?missing wireguard interface}"
POOL="${3:?missing pool cidr}"
WAN_IF="${4:-}"

if [[ -z "$WAN_IF" ]]; then
  WAN_IF="$(ip -4 route show default | awk '{print $5; exit}')"
fi

if [[ -z "$WAN_IF" ]]; then
  echo "wg-nat: could not determine WAN interface" >&2
  exit 1
fi

# rule <table> <chain> <args...>
add_rule() {
  local table="$1" chain="$2"; shift 2
  iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -A "$chain" "$@"
}

del_rule() {
  local table="$1" chain="$2"; shift 2
  while iptables -t "$table" -C "$chain" "$@" 2>/dev/null; do
    iptables -t "$table" -D "$chain" "$@"
  done
}

apply() {
  local fn="$1"
  # Masquerade tunnel traffic leaving through the public NIC.
  "$fn" nat POSTROUTING -s "$POOL" -o "$WAN_IF" -j MASQUERADE
  # Allow traffic in/out of the tunnel.
  "$fn" filter FORWARD -i "$WG_IF" -j ACCEPT
  "$fn" filter FORWARD -o "$WG_IF" -j ACCEPT
  # Clamp TCP MSS so PMTU blackholes do not silently break HTTPS.
  "$fn" mangle FORWARD -p tcp --tcp-flags SYN,RST SYN -o "$WG_IF" -j TCPMSS --clamp-mss-to-pmtu
  "$fn" mangle FORWARD -p tcp --tcp-flags SYN,RST SYN -i "$WG_IF" -j TCPMSS --clamp-mss-to-pmtu
}

case "$ACTION" in
  up)   apply add_rule ;;
  down) apply del_rule ;;
  *)    echo "wg-nat: unknown action '$ACTION' (expected up|down)" >&2; exit 1 ;;
esac
