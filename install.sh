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

TOKEN_PEPPER=$(gen 48 64)

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

# --- the vpn command ----------------------------------------------------------

step "Installing the vpn command"

# A wrapper rather than an alias, so it works from cron, from another user's
# shell, and from a session that never sourced a profile. It cds itself: the
# compose file is the only thing that says where anything lives.
cat > /usr/local/bin/vpn <<VPNEOF
#!/bin/sh
# Manage this VPN server. Installed by install.sh; safe to re-run.
set -e

# howmanydevice is answered by the interface, not the database. The control
# plane deliberately stores nothing that could answer it — no last-seen time,
# no byte counters — so the only honest source is the live handshake list, and
# that lives in the kernel on this machine rather than in the container.
#
# A peer that has not completed a handshake in three minutes is not connected:
# WireGuard is silent when idle, but PersistentKeepalive is 25 seconds, so a
# live peer is never quiet for that long.
if [ "\$1" = "howmanydevice" ]; then
  echo
  wg show wg0 latest-handshakes 2>/dev/null | awk -v now="\$(date +%s)" '
    { total++; if (\$2 > 0 && now - \$2 < 180) connected++ }
    END { printf "  %d connected right now, of %d enrolled\n", connected, total }'
  echo
  echo "  Counted from the interface, not from a log: nothing on this server"
  echo "  records who was connected, or when."
  echo
  exit 0
fi

cd "$INSTALL_DIR"

# update runs on the host, because pulling images and restarting the stack is
# something the container cannot do to itself.
#
# The shape is: back up, pull, restart, wait — and if it does not come back
# healthy, put the old image back. Rolling the database back is deliberately
# NOT automatic. Migrations only go forward, so an automatic restore would be
# the one command in here that can destroy data, and it would fire on a health
# check that failed for a reason as ordinary as a slow network. The backup path
# is printed instead.
if [ "\$1" = "update" ]; then
  SITE_ADDRESS="\${SITE_ADDRESS:-$DOMAIN}"
  export SITE_ADDRESS

  echo
  echo "  Backing up the database"
  BACKUP="\$(docker compose exec -T api node scripts/backup.mjs 2>/dev/null | tail -1)"
  if [ -n "\$BACKUP" ]; then
    echo "  saved \$BACKUP"
  else
    echo "  could not back up; not updating." >&2
    exit 1
  fi

  # The image currently running, so there is something to go back to. Captured
  # by id: the :latest tag is about to point somewhere else.
  PREVIOUS="\$(docker compose images -q api 2>/dev/null | head -1)"

  echo "  Fetching the new version"
  git pull --ff-only --quiet 2>/dev/null ||
    echo "  (compose file not updated; continuing with the one on disk)"

  if ! docker compose pull --quiet api caddy; then
    echo "  could not fetch the images; nothing changed." >&2
    exit 1
  fi

  echo "  Restarting"
  docker compose up -d --no-build api caddy >/dev/null 2>&1 || true

  state=starting
  for _ in \$(seq 1 60); do
    state="\$(docker inspect --format '{{.State.Health.Status}}' vpn-api-1 2>/dev/null || echo starting)"
    [ "\$state" = "healthy" ] && break
    sleep 2
  done

  if [ "\$state" = "healthy" ]; then
    echo
    echo "  Updated. Your code and your devices are untouched."
    echo
    exit 0
  fi

  echo
  echo "  The new version did not come up. Rolling back." >&2
  docker compose logs --tail 20 api >&2 || true

  if [ -n "\$PREVIOUS" ]; then
    docker tag "\$PREVIOUS" ghcr.io/anilyagizbasaran/vpn-control-plane:latest
    docker compose up -d --no-build api caddy >/dev/null 2>&1 || true
    echo "  Previous version restored." >&2
  else
    echo "  No previous image to restore." >&2
  fi

  echo "  The database was NOT rolled back. If the new version migrated it and" >&2
  echo "  the old one cannot read it, restore by hand from:" >&2
  echo "    \$BACKUP" >&2
  echo >&2
  exit 1
fi

# A terminal is passed through when there is one, so a command that asks
# before doing something destructive can actually be answered. Without this
# every run is -T, stdin is closed, and the prompt reads EOF — which would make
# a confirmation either useless or impossible to get past.
if [ -t 0 ] && [ -t 1 ]; then
  exec docker compose exec api node scripts/vpn.mjs "\$@"
fi
exec docker compose exec -T api node scripts/vpn.mjs "\$@"
VPNEOF
chmod 755 /usr/local/bin/vpn
ok "vpn status · vpn howmanydevice · vpn reset · vpn update"

# --- first code ---------------------------------------------------------------

step "Creating your invite code"
info "one code; every device you own uses it"

# `vpn status` mints one on first run and prints it. The structured logger
# shares stdout, so the code is picked out by shape rather than by trusting the
# whole stream: ten characters from Crockford's base32, alone on a line.
CODE="$(/usr/local/bin/vpn status 2>/dev/null |
  grep -oE '\b[0-9A-HJKMNP-TV-Z]{10}\b' | head -1)"

if [ -n "$CODE" ]; then
  ok "code created"
else
  info "could not read it back; run 'vpn reset' to see one"
fi

# --- done --------------------------------------------------------------------

cat <<EOF

${BOLD}Your VPN server is running.${RESET}

  Enter this in the app:

      ${BOLD}https://$DOMAIN${RESET}

  ...and this code:

      ${BOLD}${CODE:-run: vpn reset}${RESET}

  That is the whole setup. The same code works on every device you own — phone,
  desktop app, browser extension — and each one generates its own key, so the
  private half never reaches this server.

  Managing it, from this machine:
      ${BOLD}vpn status${RESET}          is a code set, and how many devices it enrolled
      ${BOLD}vpn howmanydevice${RESET}   how many are connected right now
      ${BOLD}vpn reset${RESET}           new code, devices stay connected
      ${BOLD}vpn reset --kick${RESET}    new code and remove every device
      ${BOLD}vpn update${RESET}          pull the latest version, roll back if it fails

  Installed at:   $INSTALL_DIR
  Update later:   ${BOLD}vpn update${RESET}

  Make sure your provider's firewall allows ${BOLD}$WG_PORT/udp${RESET} as well as 80 and 443.

EOF
