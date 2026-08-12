#!/usr/bin/env bash
#
# Installs a complete VPN server on a fresh Ubuntu or Debian machine.
#
#   curl -fsSL https://raw.githubusercontent.com/anilyagizbasaran/Vpn/main/install.sh | sudo bash
#
# It ends by printing one address. Paste that into the app and you are done.
#
# Options:
#   --domain <name>   use this hostname instead of one derived from the IP
#   --port <n>        WireGuard UDP port (default 51820)
#   --pool <cidr>     tunnel address pool (default 10.8.0.0/24)
#   --dir <path>      where to install (default /opt/vpn)
#
# Re-running is safe: every step checks before it changes anything.

set -euo pipefail

REPO_URL="https://github.com/anilyagizbasaran/Vpn.git"
INSTALL_DIR="/opt/vpn"
WG_PORT="51820"
WG_POOL="10.8.0.0/24"
DOMAIN=""

# --- output ------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[90m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
info() { printf '    %s\n' "$1"; }
skip() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()   { printf '    %s%s%s\n' "$GREEN" "$1" "$RESET"; }
die()  { printf '\n%serror:%s %s\n\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# --- arguments ---------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port)   WG_PORT="${2:-}"; shift 2 ;;
    --pool)   WG_POOL="${2:-}"; shift 2 ;;
    --dir)    INSTALL_DIR="${2:-}"; shift 2 ;;
    # Printed rather than read back out of $0: piped from curl there is no
    # file to read, and `--help` would fail in the one way people try first.
    -h|--help)
      cat <<'USAGE'
Installs a complete VPN server on Ubuntu or Debian.

  curl -fsSL https://raw.githubusercontent.com/anilyagizbasaran/Vpn/main/install.sh | sudo bash

  --domain <name>   use this hostname instead of one derived from the IP
  --port <n>        WireGuard UDP port (default 51820)
  --pool <cidr>     tunnel address pool (default 10.8.0.0/24)
  --dir <path>      where to install (default /opt/vpn)

Re-running is safe: every step checks before it changes anything.
USAGE
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# --- preflight ---------------------------------------------------------------
#
# Every check here is one the installer would otherwise fail on much later,
# after changing things, with a message about something else.

step "Checking this machine"

[ "$(id -u)" -eq 0 ] || die "run this as root: curl -fsSL ... | sudo bash"

command -v apt-get >/dev/null 2>&1 ||
  die "this installer is for Ubuntu and Debian; apt-get was not found"

[ "$(uname -m)" = "x86_64" ] || [ "$(uname -m)" = "aarch64" ] ||
  die "unsupported architecture: $(uname -m)"

# WireGuard is a kernel interface. A container host without the module — some
# OpenVZ and LXC providers — cannot run this at all, and finding that out after
# a full install is a waste of everyone's time.
if ! modprobe wireguard >/dev/null 2>&1 && [ ! -d /sys/module/wireguard ]; then
  if [ ! -e /dev/net/tun ]; then
    die "no WireGuard kernel support and no /dev/net/tun. Some cheap VPS plans
    (OpenVZ, some LXC) cannot run WireGuard. A KVM plan can."
  fi
fi
ok "$(. /etc/os-release && echo "$PRETTY_NAME") on $(uname -m)"

PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
[ -n "$PUBLIC_IP" ] || die "could not work out this machine's public address"
ok "public address $PUBLIC_IP"

# sslip.io resolves any address embedded in the hostname, so a self-hosted
# server gets a real name — and therefore a real certificate — without anyone
# buying a domain. Pass --domain to use your own instead.
if [ -z "$DOMAIN" ]; then
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  info "using $DOMAIN (no domain needed; pass --domain to use your own)"
else
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
  [ "$resolved" = "$PUBLIC_IP" ] ||
    die "$DOMAIN points at ${resolved:-nothing}, not $PUBLIC_IP.
    Point its A record here and wait for DNS before running this again."
  ok "$DOMAIN resolves here"
fi

for port in 80 443; do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$"; then
    die "port $port is already in use. The certificate cannot be issued while
    something else holds it. Stop that service, or install on a clean machine."
  fi
done

# --- packages ----------------------------------------------------------------

step "Installing packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard-tools iptables curl ca-certificates git >/dev/null
ok "wireguard-tools, git"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  skip "docker already installed"
else
  # Docker's own script rather than the distribution package: Ubuntu's docker.io
  # has no compose plugin, and this installer is built on compose.
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 ||
    die "docker installation failed; install it yourself and re-run this"
  ok "docker"
fi

# --- source ------------------------------------------------------------------

step "Fetching the server"

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --quiet --depth 1 origin main
  git -C "$INSTALL_DIR" reset --quiet --hard origin/main
  skip "updated $INSTALL_DIR"
else
  # Only the parts a server runs. The Flutter apps and the browser extension
  # are several times the size of everything here and are built elsewhere.
  git clone --quiet --filter=blob:none --no-checkout --depth 1 "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" sparse-checkout init --cone
  git -C "$INSTALL_DIR" sparse-checkout set server vpnd docs
  git -C "$INSTALL_DIR" checkout --quiet main
  ok "cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"
chmod +x server/scripts/*.sh

# --- wireguard ---------------------------------------------------------------

step "Setting up WireGuard"

./server/scripts/setup-wg.sh --port "$WG_PORT" --pool "$WG_POOL" --endpoint "$DOMAIN" >/tmp/wg-setup.log 2>&1 ||
  { tail -20 /tmp/wg-setup.log >&2; die "WireGuard setup failed; see /tmp/wg-setup.log"; }

SERVER_PUBKEY="$(cat /etc/wireguard/server_public.key)"
ok "interface up, public key ${SERVER_PUBKEY:0:12}…"

# --- configuration -----------------------------------------------------------

step "Writing configuration"

if [ -f server/.env ]; then
  skip "server/.env exists, leaving it alone"
else
  # Generated here rather than shipped: a default secret in a public repo is
  # the same as no secret.
  gen() { head -c "$1" /dev/urandom | base64 -w0 | tr -d '=+/' | head -c "$2"; }
  cat > server/.env <<EOF
NODE_ENV=production
PORT=3000
TRUST_PROXY=1
DATABASE_PATH=/data/vpn.db

JWT_ACCESS_SECRET=$(gen 48 64)
JWT_REFRESH_PEPPER=$(gen 48 64)
JWT_ACCESS_TTL=15m
REFRESH_TTL_DAYS=30

MAX_DEVICES_PER_USER=5
NODE_POLL_SECONDS=10

WG_INTERFACE=wg0
WG_LISTEN_PORT=$WG_PORT
WG_ADDRESS_POOL=$WG_POOL
WG_ENDPOINT=$DOMAIN:$WG_PORT
WG_SERVER_PUBLIC_KEY=$SERVER_PUBKEY
WG_SKIP_BOOTSTRAP_NODE=true
EOF
  chmod 600 server/.env
  ok "server/.env written with fresh secrets"
fi

# --- start -------------------------------------------------------------------

step "Starting the control plane"

# Pulled, not built. Building the web image needs the Flutter workspace and a
# 2 GB toolchain, which is not a reasonable thing to ask of a small VPS — and
# is why the sparse checkout above can leave those directories out.
SITE_ADDRESS="$DOMAIN" docker compose pull --quiet api caddy >/tmp/compose.log 2>&1 ||
  { tail -20 /tmp/compose.log >&2; die "could not fetch the images; see /tmp/compose.log"; }

SITE_ADDRESS="$DOMAIN" docker compose up -d --no-build api caddy >>/tmp/compose.log 2>&1 ||
  { tail -20 /tmp/compose.log >&2; die "the stack failed to start; see /tmp/compose.log"; }

for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' vpn-api-1 2>/dev/null || echo starting)"
  [ "$state" = "healthy" ] && break
  sleep 2
done
[ "$state" = "healthy" ] || { docker compose logs api | tail -20 >&2; die "the API never became healthy"; }
ok "api healthy"

step "Waiting for the certificate"
info "Let's Encrypt is being asked for $DOMAIN"

for _ in $(seq 1 45); do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then
    CERT_OK=1
    break
  fi
  sleep 2
done

if [ "${CERT_OK:-0}" = "1" ]; then
  ok "https://$DOMAIN answers"
else
  info "the certificate has not arrived yet. Caddy keeps trying; check with:"
  info "  docker compose -f $INSTALL_DIR/docker-compose.yml logs caddy"
fi

# --- node and agent ----------------------------------------------------------

step "Registering this machine as a node"

# The token is picked out by its prefix rather than by taking all of stdout:
# the server's structured logger writes there too, so "the output" is the token
# plus a JSON line about the database opening.
extract_token() { grep -oE 'vpnnode_[A-Za-z0-9_-]+' | head -1; }

if docker compose exec -T api node scripts/add-node.mjs --region default >/dev/null 2>&1; then
  skip "node already registered, issuing a fresh agent token"
  TOKEN="$(docker compose exec -T api node scripts/add-node.mjs \
    --region default --rotate-token --token-only 2>/dev/null | extract_token)"
else
  TOKEN="$(docker compose exec -T api node scripts/add-node.mjs \
    --region default --display "My server" \
    --endpoint "$DOMAIN:$WG_PORT" --public-key "$SERVER_PUBKEY" \
    --pool "$WG_POOL" --default --token-only 2>/dev/null | extract_token)"
fi

case "$TOKEN" in
  vpnnode_*) ok "node registered" ;;
  *) die "could not register the node: $TOKEN" ;;
esac

step "Starting the node agent"
info "without this, devices exist in the database and nowhere else"

cat > vpnd/.env <<EOF
VPN_CONTROL_PLANE=https://$DOMAIN
VPN_NODE_TOKEN=$TOKEN
VPN_INTERFACE=wg0
EOF
chmod 600 vpnd/.env

SITE_ADDRESS="$DOMAIN" docker compose --profile agent pull --quiet agent >>/tmp/compose.log 2>&1 ||
  { tail -20 /tmp/compose.log >&2; die "could not fetch the agent image; see /tmp/compose.log"; }

SITE_ADDRESS="$DOMAIN" docker compose --profile agent up -d --no-build agent >>/tmp/compose.log 2>&1 ||
  { tail -20 /tmp/compose.log >&2; die "the agent failed to start; see /tmp/compose.log"; }

for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/ready" 2>/dev/null | grep -q '"online":true'; then
    AGENT_OK=1
    break
  fi
  sleep 2
done
[ "${AGENT_OK:-0}" = "1" ] && ok "agent syncing" || info "the agent has not reported yet; it keeps retrying"

# --- done --------------------------------------------------------------------

cat <<EOF

${BOLD}Your VPN server is running.${RESET}

  Enter this in the app:

      ${BOLD}https://$DOMAIN${RESET}

  Then create an account in the app — the first one is yours.

  Manage devices in a browser:  https://$DOMAIN/dashboard/
  Installed at:                 $INSTALL_DIR
  Update later:                 curl -fsSL $REPO_URL/raw/main/install.sh | sudo bash

  Make sure your provider's firewall allows ${BOLD}$WG_PORT/udp${RESET} as well as 80 and 443.

EOF
