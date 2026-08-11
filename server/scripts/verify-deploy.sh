#!/usr/bin/env bash
# verify-deploy.sh — checks the VPS itself, not the API.
#
# Run on the server after setup-wg.sh and after installing the control plane.
# Everything here is something that is fine on a laptop and silently wrong on
# a server: forwarding disabled, NAT rules missing, the API running as root,
# the database on a filesystem it cannot write.
#
#   sudo ./verify-deploy.sh
#   sudo ./verify-deploy.sh --interface wg0 --port 51820 --api-user wgapi

set -uo pipefail   # no -e: a failing check must not abort the report

WG_IF="wg0"
WG_PORT="51820"
API_USER="wgapi"
API_PORT="3000"
DATA_DIR="/opt/vpn-control-plane"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interface) WG_IF="$2"; shift 2 ;;
    --port)      WG_PORT="$2"; shift 2 ;;
    --api-user)  API_USER="$2"; shift 2 ;;
    --api-port)  API_PORT="$2"; shift 2 ;;
    --dir)       DATA_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[90m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
pass()    { printf '  %sPASS%s %s\n' "$GREEN" "$OFF" "$1"; PASS=$((PASS+1)); }
fail()    { printf '  %sFAIL%s %s\n' "$RED" "$OFF" "$1"; [[ -n "${2:-}" ]] && printf '       %s%s%s\n' "$DIM" "$2" "$OFF"; FAIL=$((FAIL+1)); }
warn()    { printf '  %sWARN%s %s\n' "$YELLOW" "$OFF" "$1"; [[ -n "${2:-}" ]] && printf '       %s%s%s\n' "$DIM" "$2" "$OFF"; WARN=$((WARN+1)); }

[[ $EUID -eq 0 ]] || { echo "run as root: some checks read /etc/wireguard and systemd state" >&2; exit 2; }

# ---------------------------------------------------------------------------
section "WireGuard interface"
# ---------------------------------------------------------------------------

if ip link show "$WG_IF" >/dev/null 2>&1; then
  pass "$WG_IF exists"
else
  fail "$WG_IF does not exist" "run setup-wg.sh, then: systemctl start wg-quick@$WG_IF"
fi

if wg show "$WG_IF" >/dev/null 2>&1; then
  pass "wg can read $WG_IF"

  listen_port="$(wg show "$WG_IF" listen-port 2>/dev/null)"
  if [[ "$listen_port" == "$WG_PORT" ]]; then
    pass "listening on $WG_PORT/udp"
  else
    fail "listening on $listen_port, expected $WG_PORT" "WG_LISTEN_PORT in .env must match wg0.conf"
  fi

  peer_count="$(wg show "$WG_IF" peers 2>/dev/null | grep -c . || true)"
  printf '  %sinfo%s %s peer(s) currently configured\n' "$DIM" "$OFF" "$peer_count"
else
  fail "wg cannot read $WG_IF"
fi

if systemctl is-enabled --quiet "wg-quick@$WG_IF" 2>/dev/null; then
  pass "wg-quick@$WG_IF starts on boot"
else
  fail "wg-quick@$WG_IF is not enabled" "systemctl enable wg-quick@$WG_IF — otherwise a reboot leaves the tunnel down"
fi

# SaveConfig would let wg-quick overwrite the file on shutdown, discarding the
# PostUp hooks and writing whatever peers happened to be live.
if grep -qiE '^\s*SaveConfig\s*=\s*true' "/etc/wireguard/$WG_IF.conf" 2>/dev/null; then
  fail "SaveConfig = true in $WG_IF.conf" "the database is the source of truth; this must be false"
else
  pass "SaveConfig is off"
fi

if [[ -f "/etc/wireguard/$WG_IF.conf" ]]; then
  mode="$(stat -c '%a' "/etc/wireguard/$WG_IF.conf")"
  if [[ "$mode" == "600" ]]; then
    pass "$WG_IF.conf is mode 600"
  else
    fail "$WG_IF.conf is mode $mode" "it contains the server private key: chmod 600"
  fi
fi

# ---------------------------------------------------------------------------
section "Routing and NAT"
# ---------------------------------------------------------------------------

if [[ "$(sysctl -n net.ipv4.ip_forward)" == "1" ]]; then
  pass "IPv4 forwarding is on"
else
  fail "IPv4 forwarding is off" "clients will connect and then reach nothing: sysctl -w net.ipv4.ip_forward=1"
fi

if [[ -f /etc/sysctl.d/99-wireguard.conf ]]; then
  pass "forwarding survives a reboot"
else
  warn "forwarding is not persisted" "it will be off after the next reboot"
fi

# A stock rmem_max is ~212 KB, which drops bursts before WireGuard decrypts
# them. Users see a fast link that stutters.
rmem="$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)"
if (( rmem >= 8388608 )); then
  pass "socket buffers are tuned (rmem_max = $rmem)"
else
  warn "rmem_max is $rmem" "too small for a busy tunnel; re-run setup-wg.sh"
fi

# Every tunnelled flow takes a conntrack slot because of the NAT rule. A full
# table fails new connections at random, which is the hardest symptom to
# diagnose from a user report.
ct_max="$(sysctl -n net.netfilter.nf_conntrack_max 2>/dev/null || echo 0)"
ct_now="$(sysctl -n net.netfilter.nf_conntrack_count 2>/dev/null || echo 0)"
if (( ct_max > 0 )); then
  if (( ct_now * 100 / ct_max > 80 )); then
    fail "conntrack is ${ct_now}/${ct_max}" "over 80% full; new connections will start failing"
  else
    pass "conntrack has room (${ct_now}/${ct_max})"
  fi
fi

if [[ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" == "bbr" ]]; then
  pass "BBR congestion control is active"
else
  warn "congestion control is $(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" "BBR behaves better on the lossy paths a VPN produces"
fi

if iptables -t nat -C POSTROUTING -s 10.8.0.0/24 -o "$(ip -4 route show default | awk '{print $5; exit}')" -j MASQUERADE 2>/dev/null; then
  pass "MASQUERADE rule is present"
else
  # Do not guess the pool: report what is there.
  if iptables -t nat -S POSTROUTING | grep -q MASQUERADE; then
    warn "a MASQUERADE rule exists but not the expected one" "$(iptables -t nat -S POSTROUTING | grep MASQUERADE | head -1)"
  else
    fail "no MASQUERADE rule" "clients get an address but no internet; check PostUp in $WG_IF.conf"
  fi
fi

if iptables -S FORWARD | grep -q -- "-i $WG_IF -j ACCEPT"; then
  pass "FORWARD accepts tunnel traffic"
else
  warn "no explicit FORWARD accept for $WG_IF" "fine if the FORWARD policy is ACCEPT, fatal if it is DROP"
fi

if iptables -t mangle -S FORWARD | grep -q TCPMSS; then
  pass "TCP MSS clamping is in place"
else
  warn "no MSS clamping" "large packets can be blackholed: ping works, HTTPS stalls"
fi

# ---------------------------------------------------------------------------
section "Firewall"
# ---------------------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ufw status | grep -q "^$WG_PORT/udp"; then
    pass "ufw allows $WG_PORT/udp"
  else
    fail "ufw is active but $WG_PORT/udp is not allowed" "ufw allow $WG_PORT/udp"
  fi
else
  warn "ufw is not active" "check your provider's firewall allows $WG_PORT/udp inbound"
fi

if ss -lun | grep -q ":$WG_PORT"; then
  pass "something is listening on $WG_PORT/udp"
else
  fail "nothing is listening on $WG_PORT/udp"
fi

# ---------------------------------------------------------------------------
section "Control plane"
# ---------------------------------------------------------------------------

if systemctl is-active --quiet vpn-api 2>/dev/null; then
  pass "vpn-api is running"

  api_pid="$(systemctl show -p MainPID --value vpn-api)"
  api_owner="$(ps -o user= -p "$api_pid" 2>/dev/null | tr -d ' ')"
  if [[ "$api_owner" == "root" ]]; then
    fail "vpn-api runs as root" "it only needs CAP_NET_ADMIN; run it as $API_USER"
  elif [[ -n "$api_owner" ]]; then
    pass "vpn-api runs as $api_owner, not root"
  fi
else
  fail "vpn-api is not running" "journalctl -u vpn-api -n 50"
fi

if systemctl is-enabled --quiet vpn-api 2>/dev/null; then
  pass "vpn-api starts on boot"
else
  warn "vpn-api is not enabled" "systemctl enable vpn-api"
fi

if ss -ltn | grep -qE "127\.0\.0\.1:$API_PORT|\[::1\]:$API_PORT"; then
  pass "the API listens on loopback only"
elif ss -ltn | grep -q ":$API_PORT"; then
  warn "the API is listening on a public interface" "it should sit behind the reverse proxy on 127.0.0.1"
else
  fail "nothing is listening on $API_PORT"
fi

if [[ -f "$DATA_DIR/.env" ]]; then
  env_mode="$(stat -c '%a' "$DATA_DIR/.env")"
  if [[ "$env_mode" =~ ^6[04]0$ ]]; then
    pass ".env is mode $env_mode"
  else
    fail ".env is mode $env_mode" "it holds the JWT secrets: chmod 600"
  fi

  if grep -q 'CHANGE_ME' "$DATA_DIR/.env"; then
    fail ".env still contains placeholder secrets" "npm run keygen, then paste the values in"
  else
    pass ".env has no placeholder secrets"
  fi

  # The control plane stopped touching WireGuard when the node agent took over,
  # so a sudoers rule here is left over from an older install. It is standing
  # privilege nothing uses, which is the kind that survives for years.
  if [[ -f /etc/sudoers.d/wgapi ]]; then
    fail "/etc/sudoers.d/wgapi still grants the API sudo" "re-run setup-wg.sh, which now removes it"
  else
    pass "the API holds no sudo rule"
  fi

  if grep -qE '^\s*TRUST_PROXY\s*=\s*0' "$DATA_DIR/.env"; then
    warn "TRUST_PROXY=0 behind a proxy" "every request buckets as 127.0.0.1 and rate limiting hits everyone at once"
  fi
else
  warn "no .env at $DATA_DIR" "pass --dir if the control plane lives elsewhere"
fi

if [[ -d "$DATA_DIR/data" ]]; then
  if sudo -u "$API_USER" test -w "$DATA_DIR/data" 2>/dev/null; then
    pass "$API_USER can write the database directory"
  else
    fail "$API_USER cannot write $DATA_DIR/data" "chown -R $API_USER $DATA_DIR/data"
  fi
fi

# ---------------------------------------------------------------------------
section "Privileges"
# ---------------------------------------------------------------------------

if id -u "$API_USER" >/dev/null 2>&1; then
  pass "the service user $API_USER exists"

  # One of these has to work or peer creation fails at runtime with a 502.
  if sudo -u "$API_USER" sudo -n wg show "$WG_IF" >/dev/null 2>&1; then
    pass "$API_USER can run wg via sudo"
  elif systemctl show -p AmbientCapabilities --value vpn-api 2>/dev/null | grep -q cap_net_admin; then
    pass "vpn-api has CAP_NET_ADMIN"
  else
    fail "$API_USER cannot manage the interface" "peer creation will fail with 502; grant CAP_NET_ADMIN or the sudoers rule"
  fi

  if [[ -f /etc/sudoers.d/wgapi ]]; then
    if grep -qE 'ALL\s*$|NOPASSWD:\s*ALL' /etc/sudoers.d/wgapi; then
      fail "the sudoers rule grants more than wg" "$(cat /etc/sudoers.d/wgapi)"
    else
      pass "the sudoers rule is limited to the wg binary"
    fi
  fi
else
  warn "no $API_USER user" "the API may be running as something else"
fi

# ---------------------------------------------------------------------------
section "Reverse proxy"
# ---------------------------------------------------------------------------

if systemctl is-active --quiet caddy 2>/dev/null; then
  pass "caddy is running"
elif systemctl is-active --quiet nginx 2>/dev/null; then
  pass "nginx is running"
else
  warn "no reverse proxy is running" "the API must not be exposed without TLS"
fi

# ---------------------------------------------------------------------------
printf '\n%sSummary%s\n' "$BOLD" "$OFF"
printf '  %s%d passed%s  %d failed  %s%d warnings%s\n' \
  "$GREEN" "$PASS" "$OFF" "$FAIL" "$YELLOW" "$WARN" "$OFF"

if (( FAIL > 0 )); then
  printf '\n%sFix the failures before pointing clients at this server.%s\n' "$RED" "$OFF"
  exit 1
fi
printf '\n%sInfrastructure looks right. Now run the API acceptance test:%s\n' "$DIM" "$OFF"
printf '  node scripts/acceptance.mjs https://your-domain --check-wg\n'
