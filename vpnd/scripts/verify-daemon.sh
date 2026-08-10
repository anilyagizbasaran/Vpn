#!/usr/bin/env bash
# verify-daemon.sh — checks the desktop service after installing it.
#
# The GUI reports "The VPN service is not running" for every failure mode here,
# which is right for a user and useless for diagnosis. This tells them apart.
#
#   ./verify-daemon.sh
#   ./verify-daemon.sh --socket /run/vpnd/vpnd.sock --vpnctl ./bin/vpnctl

set -uo pipefail

SOCKET="/run/vpnd/vpnd.sock"
VPNCTL="vpnctl"
EXPECTED_PROTOCOL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --socket) SOCKET="$2"; shift 2 ;;
    --vpnctl) VPNCTL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[90m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
pass()    { printf '  %sPASS%s %s\n' "$GREEN" "$OFF" "$1"; PASS=$((PASS+1)); }
fail()    { printf '  %sFAIL%s %s\n' "$RED" "$OFF" "$1"; [[ -n "${2:-}" ]] && printf '       %s%s%s\n' "$DIM" "$2" "$OFF"; FAIL=$((FAIL+1)); }
warn()    { printf '  %sWARN%s %s\n' "$YELLOW" "$OFF" "$1"; [[ -n "${2:-}" ]] && printf '       %s%s%s\n' "$DIM" "$2" "$OFF"; WARN=$((WARN+1)); }

section "Service"

if systemctl is-active --quiet vpnd 2>/dev/null; then
  pass "vpnd is running"
elif pgrep -x vpnd >/dev/null 2>&1; then
  warn "vpnd is running but not under systemd" "it will not come back after a reboot"
else
  fail "vpnd is not running" "systemctl start vpnd, then journalctl -u vpnd -n 50"
fi

section "Socket"

if [[ -S "$SOCKET" ]]; then
  pass "the socket exists at $SOCKET"

  mode="$(stat -c '%a' "$SOCKET" 2>/dev/null || stat -f '%Lp' "$SOCKET")"
  owner="$(stat -c '%U:%G' "$SOCKET" 2>/dev/null || stat -f '%Su:%Sg' "$SOCKET")"

  if [[ "$mode" == "660" || "$mode" == "600" ]]; then
    pass "socket mode is $mode, owned by $owner"
  else
    fail "socket mode is $mode" "anything world-writable lets any local account drive the tunnel"
  fi

  # The desktop user must be able to open it, or the GUI can never connect.
  if [[ -w "$SOCKET" ]]; then
    pass "the current user can open the socket"
  else
    fail "the current user cannot open the socket" "add yourself to the vpn group and log out and back in"
  fi
else
  fail "no socket at $SOCKET" "the service is not running, or it was started with a different --socket"
fi

# The socket must be a filesystem socket, not a TCP port. A loopback listener
# is reachable by every process on the machine and by a web page.
if command -v ss >/dev/null 2>&1; then
  if ss -ltnp 2>/dev/null | grep -i vpnd | grep -q '127\.0\.0\.1\|0\.0\.0\.0'; then
    fail "vpnd is listening on TCP" "this is the Tailscale local-API vulnerability class; it must use AF_UNIX only"
  else
    pass "vpnd is not listening on any TCP port"
  fi
fi

section "Protocol"

if ! command -v "$VPNCTL" >/dev/null 2>&1 && [[ ! -x "$VPNCTL" ]]; then
  warn "vpnctl not found" "pass --vpnctl /path/to/vpnctl to run the protocol checks"
else
  version_json="$("$VPNCTL" -socket "$SOCKET" version 2>&1)"
  if grep -q '"ok": true' <<<"$version_json"; then
    pass "the daemon answers a version request"

    protocol="$(grep -o '"protocol": *[0-9]*' <<<"$version_json" | grep -o '[0-9]*$')"
    if [[ "$protocol" == "$EXPECTED_PROTOCOL" ]]; then
      pass "protocol version $protocol matches the app"
    else
      fail "protocol version $protocol, app expects $EXPECTED_PROTOCOL" "a partial upgrade left an old service behind"
    fi
  else
    fail "the daemon did not answer" "$version_json"
  fi

  status_json="$("$VPNCTL" -socket "$SOCKET" status 2>&1)"
  if grep -q '"stage"' <<<"$status_json"; then
    stage="$(grep -o '"stage": *"[a-z]*"' <<<"$status_json" | cut -d'"' -f4)"
    pass "status reports stage: $stage"
  else
    fail "status failed" "$status_json"
  fi

  # The control that stops a local user turning the daemon into a root shell.
  hostile="$(mktemp)"
  cat >"$hostile" <<'EOF'
[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=
Address = 10.8.0.5/32
PostUp = /bin/sh -c 'id > /tmp/vpnd-pwned'

[Peer]
PublicKey = c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=
AllowedIPs = 0.0.0.0/0
EOF

  rm -f /tmp/vpnd-pwned
  hostile_result="$("$VPNCTL" -socket "$SOCKET" -config "$hostile" up 2>&1)"

  if [[ -f /tmp/vpnd-pwned ]]; then
    fail "a PostUp hook EXECUTED" "this is arbitrary code execution as root — stop the service now"
    rm -f /tmp/vpnd-pwned
  elif grep -q '"ok": false' <<<"$hostile_result"; then
    pass "a config with a PostUp hook is rejected"
  else
    fail "a config with a PostUp hook was accepted" "$hostile_result"
  fi
  rm -f "$hostile"
fi

section "WireGuard tooling"

if command -v wg-quick >/dev/null 2>&1; then
  pass "wg-quick is installed"
else
  fail "wg-quick is not installed" "the daemon shells out to it: apt install wireguard-tools"
fi

if [[ -d /etc/wireguard ]]; then
  mode="$(stat -c '%a' /etc/wireguard 2>/dev/null || stat -f '%Lp' /etc/wireguard)"
  if [[ "$mode" =~ ^7[04]0$ ]]; then
    pass "/etc/wireguard is mode $mode"
  else
    warn "/etc/wireguard is mode $mode" "the tunnel config written there holds a private key"
  fi
fi

printf '\n%sSummary%s\n' "$BOLD" "$OFF"
printf '  %s%d passed%s  %d failed  %s%d warnings%s\n' \
  "$GREEN" "$PASS" "$OFF" "$FAIL" "$YELLOW" "$WARN" "$OFF"

(( FAIL > 0 )) && exit 1
exit 0
