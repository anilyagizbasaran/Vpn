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
log "kernel network settings"
SYSCTL_FILE="/etc/sysctl.d/99-wireguard.conf"

# Forwarding is required; the rest is throughput tuning.
#
# The buffer sizes matter more than they look. A stock rmem_max is around
# 212 KB, which is not enough to hold a burst of encrypted packets while
# WireGuard decrypts them — the kernel drops them before WireGuard ever sees
# them, and the user experiences it as a fast link that stutters. 16 MB is the
# widely used figure for a gigabit tunnel.
read -r -d '' SYSCTL_WANT <<EOF || true
# Managed by setup-wg.sh — do not edit; re-run the script instead.

# Required: without this clients connect and then reach nothing.
net.ipv4.ip_forward = 1

# Socket buffers. The default is sized for a single host's own traffic, not
# for a box decrypting everyone else's.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.ipv4.udp_mem = 4096 131072 16777216

# Queue depth between the NIC and the kernel, and how long one NAPI poll may
# run. Both stop bursts being dropped on a busy interface.
net.core.netdev_max_backlog = 5000
net.core.netdev_budget = 600

# Every tunnelled flow takes a conntrack slot because of the NAT rule; the
# default table fills quietly and new connections then fail at random.
net.netfilter.nf_conntrack_max = 262144

# BBR with fq behaves far better than cubic on the long, lossy paths a VPN
# tends to produce. Harmless if the module is missing — sysctl skips it.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF

if [[ ! -f "$SYSCTL_FILE" ]] || ! diff -q <(printf '%s\n' "$SYSCTL_WANT") "$SYSCTL_FILE" >/dev/null 2>&1; then
  printf '%s\n' "$SYSCTL_WANT" > "$SYSCTL_FILE"
  ok "wrote $SYSCTL_FILE"
else
  skip "$SYSCTL_FILE already correct"
fi

# nf_conntrack_max only exists once the module is loaded, and BBR only once
# tcp_bbr is. Load them so the settings apply now rather than after a reboot.
modprobe nf_conntrack 2>/dev/null || true
modprobe tcp_bbr 2>/dev/null || true

# --system applies every file; ignore errors from keys this kernel lacks.
sysctl -q --system 2>/dev/null || sysctl --system 2>&1 | grep -v '^\*' | grep -i error || true

if [[ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" == "bbr" ]]; then
  ok "BBR congestion control active"
else
  warn "BBR is not active" "the kernel may not have tcp_bbr; cubic still works, just less well on lossy paths"
fi

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
# An existing config is left alone, with one exception: if it names a key this
# server no longer has, it is stale and must be replaced.
#
# That happens whenever the keypair is regenerated under a config that already
# exists — deleting the keys to start clean, or restoring /etc/wireguard from a
# partial backup. The failure it causes is quiet and misleading: the interface
# comes up, `wg show` reports a healthy server, and not one client can complete
# a handshake, because the public key everybody was given belongs to a private
# key that is gone.
CONF_STALE=0
if [[ -f "$CONF" ]]; then
  conf_key="$(sed -n 's/^PrivateKey *= *//p' "$CONF" | head -1)"
  disk_key="$(cat "$WG_DIR/server_private.key")"
  [[ "$conf_key" == "$disk_key" ]] || CONF_STALE=1
fi

if [[ -f "$CONF" && $FORCE_CONF -eq 0 && $CONF_STALE -eq 0 ]]; then
  skip "$CONF exists, leaving it alone (use --force to rewrite)"
else
  if [[ $CONF_STALE -eq 1 ]]; then
    warn "$CONF names a key this server no longer has"       "rewriting it; clients would otherwise never complete a handshake"
  fi
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
# 6. Unprivileged API user
# ---------------------------------------------------------------------------
# The control plane no longer touches WireGuard at all — the node agent applies
# peers, and that is the only thing on this box that needs CAP_NET_ADMIN. So
# the API user gets nothing: no sudo, no capabilities, no group membership.
log "API service user '$API_USER'"
if id -u "$API_USER" >/dev/null 2>&1; then
  skip "user $API_USER already exists"
else
  useradd --system --create-home --shell /usr/sbin/nologin "$API_USER"
  ok "created system user $API_USER"
fi

# Earlier versions of this script granted the API passwordless sudo to `wg`.
# Anyone who ran one still has that rule sitting in /etc/sudoers.d, and it is
# now pure standing privilege — nothing would ever use it. Remove it rather
# than leaving it for a later audit to find.
SUDOERS_FILE="/etc/sudoers.d/wgapi"
if [[ -f "$SUDOERS_FILE" ]]; then
  rm -f "$SUDOERS_FILE"
  ok "removed $SUDOERS_FILE — the API has not needed wg since the agent took over"
else
  skip "no stale sudoers rule for $API_USER"
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
    warn "    systemctl restart wg-quick@$WG_IF"
    warn "The node agent re-applies every active peer on its next sync."
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
-----------------------------------------------------------------------------
Run the API as '$API_USER'. It needs no privileges at all: not root, no sudo,
no capabilities. Applying peers to $WG_IF is the node agent's job — install it
next, or peers will exist in the database and nowhere else.
-----------------------------------------------------------------------------
EOF
