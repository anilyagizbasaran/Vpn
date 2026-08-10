#!/usr/bin/env bash
# verify-tunnel.sh — proves the tunnel actually carries traffic, from a client.
#
# Everything else can pass while the tunnel is useless: the handshake completes
# but no packets flow, or packets flow but DNS still goes to the ISP, or IPv6
# quietly bypasses the whole thing. Those are the failures users notice and
# nothing else reports.
#
# Run on a Linux/macOS client *while connected*:
#
#   ./verify-tunnel.sh --expect-ip 203.0.113.10
#   ./verify-tunnel.sh --interface vpn0 --expect-ip 203.0.113.10
#
# --expect-ip is the VPS public address. Without it the script reports what it
# sees but cannot tell you whether it is right.

set -uo pipefail

WG_IF=""
EXPECT_IP=""
BEFORE_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interface) WG_IF="$2"; shift 2 ;;
    --expect-ip) EXPECT_IP="$2"; shift 2 ;;
    --before-ip) BEFORE_IP="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[90m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
pass()    { printf '  %sPASS%s %s\n' "$GREEN" "$OFF" "$1"; PASS=$((PASS+1)); }
fail()    { printf '  %sFAIL%s %s\n' "$RED" "$OFF" "$1"; [[ -n "${2:-}" ]] && printf '       %s%s%s\n' "$DIM" "$2" "$OFF"; FAIL=$((FAIL+1)); }
warn()    { printf '  %sWARN%s %s\n' "$YELLOW" "$OFF" "$1"; [[ -n "${2:-}" ]] && printf '       %s%s%s\n' "$DIM" "$2" "$OFF"; WARN=$((WARN+1)); }
info()    { printf '  %sinfo%s %s\n' "$DIM" "$OFF" "$1"; }

need() { command -v "$1" >/dev/null 2>&1; }

# Auto-detect the interface if not given: whichever wg interface is up.
if [[ -z "$WG_IF" ]]; then
  if need wg; then
    WG_IF="$(wg show interfaces 2>/dev/null | awk '{print $1; exit}')"
  fi
  WG_IF="${WG_IF:-wg0}"
fi

# ---------------------------------------------------------------------------
section "Interface"
# ---------------------------------------------------------------------------

if ! need wg; then
  warn "the wg tool is not installed" "interface checks will be skipped"
else
  if wg show "$WG_IF" >/dev/null 2>&1; then
    pass "$WG_IF is up"
  else
    fail "$WG_IF is not up" "connect first, then re-run"
  fi

  handshake="$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk '{print $2; exit}')"
  if [[ -n "$handshake" && "$handshake" != "0" ]]; then
    age=$(( $(date +%s) - handshake ))
    if (( age < 180 )); then
      pass "handshake completed ${age}s ago"
    else
      # WireGuard rehandshakes about every 2 minutes while traffic flows.
      warn "the last handshake was ${age}s ago" "the tunnel may be idle or the peer unreachable"
    fi
  else
    fail "no handshake" "the server has not accepted this key: wrong key, wrong endpoint, or UDP blocked"
  fi

  transfer="$(wg show "$WG_IF" transfer 2>/dev/null | awk '{print $2" "$3; exit}')"
  if [[ -n "$transfer" ]]; then
    rx="${transfer%% *}"; tx="${transfer##* }"
    info "received ${rx} bytes, sent ${tx} bytes"
    if [[ "$rx" == "0" ]]; then
      fail "nothing received from the server" "handshake without traffic usually means routing or MTU"
    else
      pass "traffic is flowing in both directions"
    fi
  fi
fi

# ---------------------------------------------------------------------------
section "Routing"
# ---------------------------------------------------------------------------

if need ip; then
  default_dev="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')"
  if [[ "$default_dev" == "$WG_IF" ]]; then
    pass "IPv4 traffic routes through $WG_IF"
  else
    fail "IPv4 traffic routes through $default_dev, not $WG_IF" "AllowedIPs is probably not 0.0.0.0/0"
  fi
fi

# ---------------------------------------------------------------------------
section "Public address"
# ---------------------------------------------------------------------------

fetch_ip() {
  if need curl; then
    curl -4 -s --max-time 10 "$1" 2>/dev/null | tr -d '[:space:]'
  fi
}

public_ip="$(fetch_ip https://api.ipify.org)"
[[ -z "$public_ip" ]] && public_ip="$(fetch_ip https://ifconfig.me/ip)"

if [[ -z "$public_ip" ]]; then
  warn "could not determine the public address" "no network, or both lookup services are blocked"
else
  info "public address: $public_ip"

  if [[ -n "$EXPECT_IP" ]]; then
    if [[ "$public_ip" == "$EXPECT_IP" ]]; then
      pass "traffic exits through the VPN server"
    else
      fail "traffic exits through $public_ip, expected $EXPECT_IP" "the tunnel is up but not carrying your traffic"
    fi
  elif [[ -n "$BEFORE_IP" ]]; then
    if [[ "$public_ip" != "$BEFORE_IP" ]]; then
      pass "the public address changed after connecting"
    else
      fail "the public address is unchanged" "traffic is not going through the tunnel"
    fi
  else
    warn "nothing to compare against" "pass --expect-ip <vps-address> to make this a real check"
  fi
fi

# ---------------------------------------------------------------------------
section "Leaks"
# ---------------------------------------------------------------------------

# IPv6 is the classic leak: an IPv4-only tunnel leaves IPv6 on the ISP, and
# every dual-stack site then sees the real address.
if need curl; then
  v6="$(curl -6 -s --max-time 6 https://api64.ipify.org 2>/dev/null | tr -d '[:space:]')"
  if [[ -z "$v6" ]]; then
    pass "no IPv6 connectivity outside the tunnel"
  elif [[ "$v6" == "$EXPECT_IP" ]]; then
    pass "IPv6 also exits through the VPN server"
  else
    fail "IPv6 leaks to $v6" "the client config needs ::/0 in AllowedIPs, or disable IPv6"
  fi
fi

if need resolvectl; then
  dns_servers="$(resolvectl status "$WG_IF" 2>/dev/null | awk '/DNS Servers/{$1="";$2="";print;exit}' | xargs)"
  if [[ -n "$dns_servers" ]]; then
    pass "DNS on $WG_IF: $dns_servers"
  else
    warn "no DNS configured on $WG_IF" "queries may go to the ISP resolver"
  fi
elif [[ -r /etc/resolv.conf ]]; then
  info "resolv.conf nameservers: $(awk '/^nameserver/{print $2}' /etc/resolv.conf | paste -sd' ' -)"
  warn "cannot verify which resolver is actually used" "check with a DNS leak test in a browser"
fi

# ---------------------------------------------------------------------------
section "MTU"
# ---------------------------------------------------------------------------

if need ip; then
  mtu="$(ip link show "$WG_IF" 2>/dev/null | grep -o 'mtu [0-9]*' | awk '{print $2}')"
  [[ -n "$mtu" ]] && info "$WG_IF MTU is $mtu"
fi

if need ping; then
  # A large payload that must not be fragmented. Failure here is the classic
  # "ping works, HTTPS hangs" symptom.
  payload=$(( ${mtu:-1420} - 28 - 20 ))
  if ping -c 2 -W 3 -M do -s "$payload" 1.1.1.1 >/dev/null 2>&1; then
    pass "large packets pass without fragmentation"
  else
    warn "large packets do not pass" "lower WG_CLIENT_MTU (try 1380) if HTTPS stalls while ping works"
  fi
fi

# ---------------------------------------------------------------------------
printf '\n%sSummary%s\n' "$BOLD" "$OFF"
printf '  %s%d passed%s  %d failed  %s%d warnings%s\n' \
  "$GREEN" "$PASS" "$OFF" "$FAIL" "$YELLOW" "$WARN" "$OFF"

(( FAIL > 0 )) && exit 1
exit 0
