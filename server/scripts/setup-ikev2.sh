#!/usr/bin/env bash
# setup-ikev2.sh — IKEv2/IPSec alongside WireGuard, for phones.
#
# Why a second protocol at all: no phone can dial WireGuard from its own
# Settings screen. iOS and Android both speak IKEv2 natively, so this is what
# lets a phone connect with nothing installed — no app, no sideloaded APK, no
# store account. WireGuard stays the better protocol and stays the default
# everywhere it can be used.
#
# Run as root on the VPS, after setup-wg.sh:
#   sudo ./setup-ikev2.sh --domain vpn.example.com
#
# Safe to re-run: the shared secret is generated once and reused, and every
# file is written only when it differs from what is already there.
#
# Identity model, unchanged from the rest of this server: one shared username
# and password, the same way one invite code serves every device. The server
# does not learn who connected — there is no per-person credential to look up,
# and the logging below is turned down so there is no record either.

set -euo pipefail

DOMAIN=""
POOL="10.9.0.0/24"
DNS="1.1.1.1,1.0.0.1"
EAP_USER="vpn"
WAN_IF=""
FORCE_SECRET=0

CERT_DIR="/etc/letsencrypt/live"
SECRET_FILE="/etc/ipsec.d/vpn-eap.secret"

log()  { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m  ok\033[0m %s\n' "$*"; }
skip() { printf '\033[0;90m  --\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m  !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --pool)       POOL="$2"; shift 2 ;;
    --dns)        DNS="$2"; shift 2 ;;
    --user)       EAP_USER="$2"; shift 2 ;;
    --wan)        WAN_IF="$2"; shift 2 ;;
    --new-secret) FORCE_SECRET=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root"
[[ -n "$DOMAIN" ]] || die "--domain is required (it must match the TLS certificate)"

# ---------------------------------------------------------------------------
# 1. Certificate
# ---------------------------------------------------------------------------
# The phone verifies the server the same way a browser does, against the
# certificate already issued for this domain. That is the whole reason to
# reuse it rather than mint a private CA: a self-signed setup would need a
# profile installed on every phone, which is exactly the friction this is
# meant to remove.
log "certificate for $DOMAIN"
LIVE="$CERT_DIR/$DOMAIN"
[[ -s "$LIVE/fullchain.pem" ]] ||
  die "no certificate at $LIVE — issue one first (certbot), then re-run this"
ok "using $LIVE"

# ---------------------------------------------------------------------------
# 2. Packages
# ---------------------------------------------------------------------------
log "packages"
if command -v ipsec >/dev/null 2>&1 && [[ -d /etc/ipsec.d ]]; then
  skip "strongswan already installed"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # extauth-plugins carries eap-mschapv2, which is what iOS and Android ask
  # for; without it the phone gets as far as the certificate and then fails
  # with a message that says nothing useful.
  apt-get install -y -qq strongswan libcharon-extauth-plugins iptables >/dev/null
  ok "strongswan"
fi

# ---------------------------------------------------------------------------
# 3. Shared secret
# ---------------------------------------------------------------------------
log "shared credential"
if [[ -s "$SECRET_FILE" && $FORCE_SECRET -eq 0 ]]; then
  skip "reusing the existing secret (pass --new-secret to rotate)"
else
  install -d -m 700 /etc/ipsec.d
  # Crockford-ish: no look-alike characters, because this gets typed on a
  # phone keyboard by someone reading it off a terminal.
  head -c 32 /dev/urandom | base64 | tr -dc '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnpqrstvwxyz' | head -c 20 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  ok "generated"
fi
EAP_PASS="$(cat "$SECRET_FILE")"

# ---------------------------------------------------------------------------
# 4. strongSwan configuration
# ---------------------------------------------------------------------------
log "ipsec.conf"

# Cipher suites, strongest first, with the older ones kept because a phone
# that cannot negotiate simply fails to connect and says nothing about why.
IKE="aes256gcm16-prfsha384-ecp384,aes256-sha256-modp2048,aes256-sha1-modp1024"
ESP="aes256gcm16-ecp384,aes256-sha256,aes256-sha1"

read -r -d '' IPSEC_CONF <<EOF || true
# Managed by setup-ikev2.sh — do not edit; re-run the script instead.
config setup
    # No per-connection logging. The database keeps no history of who
    # connected and when; charon must not keep one either.
    charondebug="ike 0, knl 0, cfg 0, net 0, esp 0, dmn 0, mgr 0"
    strictcrlpolicy=no
    uniqueids=never

conn ikev2-phone
    auto=add
    compress=no
    type=tunnel
    keyexchange=ikev2
    # Phones roam between mobile data and wifi; fragmentation and forceencaps
    # are what keep that from stalling behind a NAT that drops large packets.
    fragmentation=yes
    forceencaps=yes
    dpdaction=clear
    dpddelay=300s
    rekey=no

    left=%any
    leftid=@$DOMAIN
    leftcert=fullchain.pem
    leftsendcert=always
    leftsubnet=0.0.0.0/0,::/0
    leftauth=pubkey

    right=%any
    rightid=%any
    rightauth=eap-mschapv2
    rightsourceip=$POOL
    rightdns=$DNS
    rightsendcert=never
    eap_identity=%identity

    ike=$IKE
    esp=$ESP
EOF

if [[ -f /etc/ipsec.conf ]] && diff -q <(printf '%s\n' "$IPSEC_CONF") /etc/ipsec.conf >/dev/null 2>&1; then
  skip "/etc/ipsec.conf already correct"
else
  [[ -f /etc/ipsec.conf ]] && cp -a /etc/ipsec.conf "/etc/ipsec.conf.bak.$(date +%s)"
  printf '%s\n' "$IPSEC_CONF" > /etc/ipsec.conf
  ok "wrote /etc/ipsec.conf"
fi

log "ipsec.secrets"

# The key type has to be named exactly, and Let's Encrypt issues ECDSA by
# default now. Naming the wrong one does not warn: strongSwan loads no secret
# at all, cannot authenticate itself, and every phone gets AUTH_FAILED after a
# handshake that looked like it was working.
#
# Checked against "NIST CURVE" rather than the first line: an EC key's own
# header just reads "Private-Key: (256 bit)", which contains nothing that says
# EC — the previous version of this check read that line and always concluded
# RSA. A 256-bit RSA key does not exist, so the size alone already gives it
# away; the curve line is the explicit confirmation.
if openssl pkey -in "$LIVE/privkey.pem" -noout -text 2>/dev/null | grep -qi 'NIST CURVE\|ASN1 OID'; then
  KEY_TYPE="ECDSA"
else
  KEY_TYPE="RSA"
fi
ok "server key is $KEY_TYPE"

umask 077
cat > /etc/ipsec.secrets <<EOF
# Managed by setup-ikev2.sh.
: $KEY_TYPE "privkey.pem"
$EAP_USER : EAP "$EAP_PASS"
EOF
chmod 600 /etc/ipsec.secrets
ok "wrote /etc/ipsec.secrets"

# Copied into strongSwan's own directories, not symlinked.
#
# A symlink is the obvious choice and it does not work: AppArmor confines
# charon to a small set of paths, and it evaluates the *resolved* path. A link
# from /etc/ipsec.d/private into /etc/letsencrypt/archive is denied, charon
# loads no key, and the only symptom a user sees is that every phone fails
# authentication — the log says "Permission denied" but only at raised debug,
# which this script deliberately turns off. Copies stay inside the profile.
#
# The renewal hook below re-copies, so this does not go stale.
log "certificate files"
install -d -m 755 /etc/ipsec.d/certs /etc/ipsec.d/cacerts
install -d -m 700 /etc/ipsec.d/private
rm -f /etc/ipsec.d/certs/fullchain.pem /etc/ipsec.d/cacerts/chain.pem       /etc/ipsec.d/private/privkey.pem
install -m 644 "$LIVE/fullchain.pem" /etc/ipsec.d/certs/fullchain.pem
install -m 644 "$LIVE/chain.pem"     /etc/ipsec.d/cacerts/chain.pem
install -m 600 "$LIVE/privkey.pem"   /etc/ipsec.d/private/privkey.pem
ok "copied into /etc/ipsec.d"

cat > /etc/letsencrypt/renewal-hooks/deploy/10-reload-strongswan.sh <<HOOK
#!/bin/sh
# Copies the renewed certificate into strongSwan's own directories and reloads.
#
# Both halves are needed. The copy, because AppArmor will not let charon read
# /etc/letsencrypt at all — see setup-ikev2.sh. The reload, because charon
# reads the certificate once at start, so without it a renewal lands on disk
# and phones keep being offered the old one until something restarts the
# service, which on a machine left alone is nothing. The failure arrives about
# ninety days later as "every phone stopped connecting".
set -e
command -v ipsec >/dev/null 2>&1 || exit 0

LIVE="$LIVE"
[ -s "\$LIVE/privkey.pem" ] || exit 0

install -m 644 "\$LIVE/fullchain.pem" /etc/ipsec.d/certs/fullchain.pem
install -m 644 "\$LIVE/chain.pem"     /etc/ipsec.d/cacerts/chain.pem
install -m 600 "\$LIVE/privkey.pem"   /etc/ipsec.d/private/privkey.pem

ipsec rereadall >/dev/null 2>&1 || true
ipsec reload >/dev/null 2>&1 || true
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/10-reload-strongswan.sh
ok "renewal hook installed"

# ---------------------------------------------------------------------------
# 5. Routing and NAT for the phone pool
# ---------------------------------------------------------------------------
log "NAT for $POOL"
if [[ -z "$WAN_IF" ]]; then
  WAN_IF="$(ip -4 route show default | awk '{print $5; exit}')"
fi
[[ -n "$WAN_IF" ]] || die "could not determine the WAN interface (pass --wan)"

add_rule() {
  local table="$1" chain="$2"; shift 2
  iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -A "$chain" "$@"
}

add_rule nat POSTROUTING -s "$POOL" -o "$WAN_IF" -j MASQUERADE
add_rule filter FORWARD -s "$POOL" -j ACCEPT
add_rule filter FORWARD -d "$POOL" -j ACCEPT
# Same PMTU clamp WireGuard gets: without it large packets vanish silently and
# the symptom is "pages half load" rather than "no connection".
add_rule mangle FORWARD -p tcp --tcp-flags SYN,RST SYN -s "$POOL" -j TCPMSS --clamp-mss-to-pmtu
add_rule mangle FORWARD -p tcp --tcp-flags SYN,RST SYN -d "$POOL" -j TCPMSS --clamp-mss-to-pmtu
ok "masquerading $POOL out of $WAN_IF"

# Persisted so the rules survive a reboot. netfilter-persistent is the
# packaged way; without it the phone works until the machine restarts, which
# is the worst kind of "works".
if ! command -v netfilter-persistent >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
fi
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null 2>&1 && ok "rules persisted"
else
  warn "iptables rules are not persisted" "they will be lost on reboot; re-run this script after one"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  for port in 500 4500; do
    ufw status | grep -q "^$port/udp" || ufw allow "$port/udp" >/dev/null
  done
  ok "ufw allows 500/udp and 4500/udp"
else
  skip "ufw not active — make sure 500/udp and 4500/udp are open at your provider"
fi

# ---------------------------------------------------------------------------
# 6. Start
# ---------------------------------------------------------------------------
log "starting strongswan"
systemctl enable strongswan-starter >/dev/null 2>&1 || systemctl enable strongswan >/dev/null 2>&1 || true
systemctl restart strongswan-starter >/dev/null 2>&1 || systemctl restart strongswan >/dev/null 2>&1 ||
  die "strongswan failed to start; see: journalctl -u strongswan-starter -n 40"
sleep 2

if ipsec status >/dev/null 2>&1; then
  ok "strongswan running"
else
  die "strongswan is not answering; see: journalctl -u strongswan-starter -n 40"
fi

cat <<EOF

$(printf '\033[1m')Add this on the phone, from its own Settings — no app needed.$(printf '\033[0m')

  iPhone   Settings > General > VPN > Add VPN Configuration > IKEv2
  Android  Settings > Network > VPN > + > IKEv2/IPSec MSCHAPv2

  Server / Remote ID   $DOMAIN
  Username             $EAP_USER
  Password             $EAP_PASS

  Leave "Local ID" empty. There is no certificate to install: the phone
  verifies this server against the same certificate a browser would.

  The password is shared by every phone, exactly as the invite code is shared
  by every other device. Rotate it with: sudo ./setup-ikev2.sh --domain $DOMAIN --new-secret

EOF
