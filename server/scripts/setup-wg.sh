#!/usr/bin/env bash
# setup-wg.sh — idempotent WireGuard server bootstrap for the control plane.
#
# Safe to re-run: existing keys are never regenerated, an existing wg0.conf is
# left alone unless --force is passed, and every sysctl/sudoers/systemd change
# is written only when it differs from what is already there.
#
# Run as root on the VPS:
#   sudo ./setup-wg.sh
#   sudo ./setup-wg.sh --endpoint vpn.example.com --port 51820 --pool 10.8.0.0/24
#
# On success it prints the block you paste into server/.env.

set -euo pipefail

WG_IF="wg0"
WG_PORT="51820"
WG_POOL="10.8.0.0/24"
WG_DNS="1.1.1.1, 1.0.0.1"
WG_ENDPOINT_HOST=""
WAN_IF=""
API_USER="wgapi"
FORCE_CONF=0

WG_DIR="/etc/wireguard"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m  ok\033[0m %s\n' "$*"; }
skip() { printf '\033[0;90m  --\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m  !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interface) WG_IF="$2"; shift 2 ;;
    --port)      WG_PORT="$2"; shift 2 ;;
    --pool)      WG_POOL="$2"; shift 2 ;;
    --dns)       WG_DNS="$2"; shift 2 ;;
    --endpoint)  WG_ENDPOINT_HOST="$2"; shift 2 ;;
    --wan)       WAN_IF="$2"; shift 2 ;;
    --api-user)  API_USER="$2"; shift 2 ;;
    --force)     FORCE_CONF=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *)           die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "must run as root (use sudo)"

# ---------------------------------------------------------------------------
# 0. Derived values
# ---------------------------------------------------------------------------
if [[ -z "$WAN_IF" ]]; then
  WAN_IF="$(ip -4 route show default | awk '{print $5; exit}')"
  [[ -n "$WAN_IF" ]] || die "could not auto-detect WAN interface; pass --wan <iface>"
fi

if [[ -z "$WG_ENDPOINT_HOST" ]]; then
  WG_ENDPOINT_HOST="$(ip -4 -o addr show "$WAN_IF" | awk '{print $4}' | cut -d/ -f1 | head -n1)"
  [[ -n "$WG_ENDPOINT_HOST" ]] || die "could not auto-detect public address; pass --endpoint <host>"
fi

# Server address = first usable host in the pool (e.g. 10.8.0.0/24 -> 10.8.0.1).
POOL_BASE="${WG_POOL%/*}"
POOL_PREFIX="${WG_POOL#*/}"
IFS='.' read -r o1 o2 o3 o4 <<<"$POOL_BASE"
SERVER_IP="${o1}.${o2}.${o3}.$((o4 + 1))"

log "interface=$WG_IF port=$WG_PORT pool=$WG_POOL wan=$WAN_IF endpoint=$WG_ENDPOINT_HOST"

# ---------------------------------------------------------------------------
# 1. Packages
# ---------------------------------------------------------------------------
log "checking packages"
missing=()
command -v wg       >/dev/null 2>&1 || missing+=("wireguard-tools")
command -v wg-quick >/dev/null 2>&1 || missing+=("wireguard-tools")
command -v iptables >/dev/null 2>&1 || missing+=("iptables")
if ((${#missing[@]})); then
  log "installing: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${missing[@]}"
  ok "packages installed"
else
  skip "wireguard-tools and iptables already present"
fi

# ---------------------------------------------------------------------------
# 2. IP forwarding (persistent)
# ---------------------------------------------------------------------------
log "enabling IPv4 forwarding"
SYSCTL_FILE="/etc/sysctl.d/99-wireguard.conf"
SYSCTL_WANT="net.ipv4.ip_forward = 1"
if [[ ! -f "$SYSCTL_FILE" ]] || ! grep -qxF "$SYSCTL_WANT" "$SYSCTL_FILE"; then
  printf '%s\n' "$SYSCTL_WANT" > "$SYSCTL_FILE"
  ok "wrote $SYSCTL_FILE"
else
  skip "$SYSCTL_FILE already correct"
fi
sysctl -q --system

# ---------------------------------------------------------------------------
# 3. Server keypair (never regenerated)
# ---------------------------------------------------------------------------
log "server keypair"
install -d -m 700 "$WG_DIR"
if [[ -s "$WG_DIR/server_private.key" ]]; then
  skip "reusing existing $WG_DIR/server_private.key"
else
  umask 077
  wg genkey > "$WG_DIR/server_private.key"
  ok "generated new server private key"
fi
chmod 600 "$WG_DIR/server_private.key"
wg pubkey < "$WG_DIR/server_private.key" > "$WG_DIR/server_public.key"
chmod 644 "$WG_DIR/server_public.key"
SERVER_PUBKEY="$(cat "$WG_DIR/server_public.key")"
ok "public key: $SERVER_PUBKEY"

# ---------------------------------------------------------------------------
# 4. NAT helper + wg0.conf
# ---------------------------------------------------------------------------
log "installing NAT helper"
install -m 750 "$SCRIPT_DIR/wg-nat.sh" "$WG_DIR/wg-nat.sh"
ok "$WG_DIR/wg-nat.sh"

CONF="$WG_DIR/$WG_IF.conf"
log "interface config $CONF"
if [[ -f "$CONF" && $FORCE_CONF -eq 0 ]]; then
  skip "$CONF exists, leaving it alone (use --force to rewrite)"
else
  [[ -f "$CONF" ]] && cp -a "$CONF" "$CONF.bak.$(date +%s)"
  umask 077
  cat > "$CONF" <<EOF
# Managed by setup-wg.sh. Peers are NOT stored here — the control plane's
# database is the source of truth and re-applies peers on boot via \`wg set\`.
# SaveConfig MUST stay false so wg-quick never overwrites this file.
[Interface]
Address = $SERVER_IP/$POOL_PREFIX
ListenPort = $WG_PORT
PrivateKey = $(cat "$WG_DIR/server_private.key")
SaveConfig = false
MTU = 1420

PostUp   = $WG_DIR/wg-nat.sh up %i $WG_POOL $WAN_IF
PostDown = $WG_DIR/wg-nat.sh down %i $WG_POOL $WAN_IF
EOF
  chmod 600 "$CONF"
  ok "wrote $CONF"
fi

# ---------------------------------------------------------------------------
# 5. Firewall (only if ufw is active)
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  log "ufw is active — allowing $WG_PORT/udp"
  if ufw status | grep -q "^$WG_PORT/udp"; then
    skip "$WG_PORT/udp already allowed"
  else
    ufw allow "$WG_PORT/udp" >/dev/null
    ok "allowed $WG_PORT/udp"
  fi
else
  skip "ufw not active — make sure $WG_PORT/udp is open at your provider"
fi

# ---------------------------------------------------------------------------
# 6. Unprivileged API user + narrow sudoers rule
# ---------------------------------------------------------------------------
# The Node process must never run as root. It only needs `wg` (to add/remove
# peers and read the dump), so it gets exactly that one binary via sudo.
log "API service user '$API_USER'"
if id -u "$API_USER" >/dev/null 2>&1; then
  skip "user $API_USER already exists"
else
  useradd --system --create-home --shell /usr/sbin/nologin "$API_USER"
  ok "created system user $API_USER"
fi

WG_BIN="$(command -v wg)"
SUDOERS_FILE="/etc/sudoers.d/wgapi"
SUDOERS_WANT="$API_USER ALL=(root) NOPASSWD: $WG_BIN"
if [[ -f "$SUDOERS_FILE" ]] && grep -qxF "$SUDOERS_WANT" "$SUDOERS_FILE"; then
  skip "$SUDOERS_FILE already correct"
else
  printf '%s\n' "$SUDOERS_WANT" > "$SUDOERS_FILE.tmp"
  chmod 440 "$SUDOERS_FILE.tmp"
  visudo -cqf "$SUDOERS_FILE.tmp" || { rm -f "$SUDOERS_FILE.tmp"; die "generated sudoers file is invalid"; }
  mv "$SUDOERS_FILE.tmp" "$SUDOERS_FILE"
  ok "wrote $SUDOERS_FILE (only '$WG_BIN' is permitted)"
fi

# ---------------------------------------------------------------------------
# 7. Bring the interface up
# ---------------------------------------------------------------------------
log "starting wg-quick@$WG_IF"
systemctl enable "wg-quick@$WG_IF" >/dev/null 2>&1
if systemctl is-active --quiet "wg-quick@$WG_IF"; then
  # Deliberately NOT `wg syncconf`: this config file carries no [Peer] sections
  # (the control plane's database is the source of truth), so syncing the live
  # interface against it would remove every connected peer.
  #
  # Only the NAT rules are re-applied here, and wg-nat.sh checks each rule with
  # `iptables -C` before adding it, so this is a no-op when they already exist.
  "$WG_DIR/wg-nat.sh" up "$WG_IF" "$WG_POOL" "$WAN_IF"
  skip "$WG_IF already up — peers left untouched, NAT rules re-applied"

  if [[ $FORCE_CONF -eq 1 ]]; then
    warn "$CONF was rewritten, but $WG_IF is still running the previous settings."
    warn "Apply them (this drops live tunnels for a moment) with:"
    warn "    systemctl restart wg-quick@$WG_IF && systemctl restart vpn-api"
    warn "vpn-api re-applies every active peer from the database when it starts."
  fi
else
  systemctl start "wg-quick@$WG_IF"
  ok "$WG_IF is up"
fi

# ---------------------------------------------------------------------------
# 8. Report
# ---------------------------------------------------------------------------
cat <<EOF

$(wg show "$WG_IF" 2>/dev/null || true)

-----------------------------------------------------------------------------
Paste this into server/.env (values the control plane needs):
-----------------------------------------------------------------------------
WG_INTERFACE=$WG_IF
WG_SERVER_PUBLIC_KEY=$SERVER_PUBKEY
WG_ENDPOINT=$WG_ENDPOINT_HOST:$WG_PORT
WG_LISTEN_PORT=$WG_PORT
WG_ADDRESS_POOL=$WG_POOL
WG_SERVER_ADDRESS=$SERVER_IP
WG_DNS=$WG_DNS
WG_REGION=de-fra
WG_SUDO=true
WG_MOCK=false
-----------------------------------------------------------------------------
Run the API as '$API_USER'. It is NOT root and can only invoke: $WG_BIN
-----------------------------------------------------------------------------
EOF
