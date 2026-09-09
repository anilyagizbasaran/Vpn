# Architecture

This file explains **why** the system is shaped this way. How to deploy it is
in [GO-LIVE.md](GO-LIVE.md); tuning and troubleshooting in [TUNING.md](TUNING.md).

## The principle

Compromising any one component should not be enough.

| Component | Knows | Does not know |
|---|---|---|
| Control plane (`server/`) | Hashed invite and device tokens, **public keys** | Private keys. It never touches WireGuard |
| Node agent (`vpn-node-agent`) | How to change the interface | Any token, or another node's peers |
| Client (`apps/client`) | Its device token | It never sees a private key — the daemon holds it |
| Desktop service (`vpnd`) | How to bring a tunnel up, and — on desktop — the device token and **the private key** | Anything but the one control plane it was pointed at |
| Extension (`extension/`) | Whether the tunnel is up | It cannot see or produce a config |

What follows from that:

- If the server's disk is taken, nobody can decrypt the traffic; the private
  keys are not there.
- If the control plane is taken, no command runs on any node; it never dials
  out.
- If a node is taken, other nodes are safe; the node token only sees that node's
  own peer set.
- If `vpnd` is taken you do get that machine's device token and key, which is
  the cost of letting the extension set a machine up without holding one. It
  buys nothing beyond that machine, and revoking the device ends it.
- If the extension is taken you get a status and a toggle. It holds no
  credential, which is why enrolment lives in the daemon.
- If the GUI is taken you do not get root.

**One computer is one device.** On desktop the daemon owns the machine's
identity: it generates the keypair, keeps the private half, and the app borrows
only the device token over the local socket. Whichever set the machine up — the
app or the browser extension — the other adopts what is already there. The
alternative, which this replaced, was two keypairs and two rows on the server
for one computer, and an invite code the user had to type twice.

The cost is plain: **lose the private key and the device cannot be recovered.**
There is no copy on the server. The app deals with it by revoking the device
and registering a new one.

## Two planes

```
CONTROL PLANE                            DATA PLANE
─────────────                            ──────────
Client ──HTTPS──> Caddy ──> Node         Client ──UDP 51820──> WireGuard
          :443           :3000                                  (wg0)
                           │                                      ▲
                        SQLite                                    │
                           ▲                              vpn-node-agent
                           └──── POST /node/sync ──────────────────┘
                                 (the agent pulls, every 10s)
```

Traffic never reaches the API. If the control plane goes down, existing tunnels
keep working — the agent holds the last peer set it saw.

## Layers

One rule: **an upper layer knows the layer below; the lower one never knows the
upper.**

```
L4  apps/client        extension/                  ← neither knows the other
    ────────────────────────────────────────────
L3  vpn_client    enrolment · device identity · rotation · region selection
L2  vpn_tunnel    the tunnel contract (pure Dart)
      └─ vpn_tunnel_desktop   vpnd IPC client
L1  vpn_api       HTTP + models       (no Flutter, no dart:io)
L0  vpn_crypto    X25519              (one dependency: package:cryptography)
```

Three boundaries were drawn deliberately:

1. **`SessionStore` / `DeviceStore`** — so `vpn_api` stays free of Flutter and
   `dart:io`. CI compiles `vpn_api` to JavaScript on every push to keep the
   boundary honest, since neither survives dart2js. It also puts the device
   private key architecturally out of reach of the API layer: `SessionStore`
   holds the device token and nothing else, so clearing a credential cannot
   destroy an identity the server cannot reissue.
2. **`TunnelStage`** — our own vocabulary instead of the plugin's enum.
   Replacing the plugin with a daemon client on desktop touched **one package**.
3. **`ApiClient` catches transport errors without `dart:io`** — required so it
   compiles for the web. A side effect is that it also covers TLS errors, which
   it used to miss.

## Data model

```
invites            label · token_hash · device_limit · revoked_at
 └─ devices        one keypair · what the quota counts · what the user sees
      └─ peers     the address allocation binding a device to a server
           └─ peer_usage
servers (nodes)    agent_token_hash · status · last_seen_at · reported_public_key
```

**Why an invite and not an account:** registering, signing in and rotating
refresh tokens is a lot of machinery to decide something the operator already
knows — whether this person is allowed on. An invite says that and nothing
more. It removed the `users` and `refresh_tokens` tables, password hashing,
session expiry and reuse detection, and with them every bug those can have.

**Why `devices` and `peers` are separate:** originally the peer *was* the
device. That breaks on the second server — a device needs an address on every
server it can reach, and counting those against a five-device limit would mean
three regions exhaust the quota from one phone.

**Why one key across many servers:** WireGuard authenticates per (client,
server) pair, so the same client key matching several servers is normal. That
is what makes switching region a single line in a config rather than a round
trip. It is Mullvad's model.

> Multi-node is not in use. The schema, the node protocol and client-side
> region selection are ready; adding a second node is `npm run node:add` plus
> an agent install.

## End to end

```
1. ENROL       The client generates an X25519 pair; the private key goes to
               secure storage and never leaves it
               POST /enroll {inviteToken, publicKey, platform}
               Control plane: quota → an address from every active node's pool → DB
               ← a .conf with PrivateKey = <PRIVATE_KEY>, plus a device token

               One call. There is no registration step before it and no sign-in
               after it — the device token is the whole session, and it does
               not expire.

2. PROPAGATION The agent pulls the peer set with POST /node/sync (≤10s)
               and applies it in a single `wg set`

3. TUNNEL      The client substitutes its own key for the placeholder
               phones:   not this path at all — native IKEv2, below
               desktop:  handed to vpnd over an AF_UNIX socket

4. ROTATION    If the key is older than 7 days, POST /device/rotate
               The device id, its label and **all its addresses** stay the same
```

No route carries a device id. `GET /device`, `/device/config`, `/device/rotate`
and `DELETE /device` all mean *this* device, because a device token names
exactly one and cannot name another. That is not a shortcut — it is why there
is no ownership check to get wrong.

## Why these decisions

**The control plane never touches WireGuard.** The client generates the keys,
the PSK is 32 random bytes, and agents apply the peers. Nothing is left that
needs `wg` — the API is unprivileged, containerisable, and runs on a machine
with no WireGuard installed.

**Nodes pull; the control plane never dials out.** A push model would need a
credential on the control plane that grants root on every node, and would
require every node to be reachable from it. Pulling means a node exposes
nothing but the WireGuard port.

**The cost of that:** revocation is **not instant**, it propagates within one
poll interval (`NODE_POLL_SECONDS`, default 10s). A deliberate trade.

**The agent keeps no state.** Whatever the control plane answers is the truth;
a node that was offline for an hour converges on its first successful sync.
There is no separate recovery path after a reboot — it is the same path.

**A failed sync leaves the peer table alone.** Turning a control-plane outage
into a total outage is the wrong direction.

**The client stores its public key too.** On connect it compares against the
server's; on a mismatch (an interrupted rotation, a restore from backup) it
rotates. Without that, the tunnel would sit at "connecting" forever with no
error shown anywhere.

**A privileged daemon on desktop.** Running the GUI elevated would put
Flutter's entire attack surface at root. Mullvad and Tailscale split the same
way.

**`vpnd` allowlists config keys.** wg-quick runs `PostUp` lines as root, and an
unprivileged process can reach the socket; without the allowlist any local user
would have a root shell. An allowlist rather than a blocklist, so that a key
added to wg-quick later that runs something is refused by default.

**The socket is AF_UNIX, not loopback TCP.** Every process on the machine can
reach localhost TCP, no ACL applies, and a browser can POST to it — which is
exactly how Tailscale's Windows client got a vulnerability. Dart's AF_UNIX
support on Windows was measured, not assumed
(`packages/vpn_tunnel/tool/af_unix_probe.dart`).

**The extension cannot send a config.** The bridge permits exactly six
actions: status, connect, disconnect, enroll, and the two that switch
browser-only mode on and off. "Connect" re-applies the config the daemon
already accepted in this session, or fetches a fresh one if this machine has
enrolled. Every one of them is a verb with no configuration attached — what
comes back is a stage, or a loopback port number.

**The extension cannot read a credential or erase one.** `identity` and
`forget` exist on the daemon socket, which is local and ACL-protected, and are
kept off the bridge: the first hands out a device token, the second is
destructive and machine-wide. `cmd/vpn-browser-host` asserts both in a test —
the allowlist is the boundary, so it is checked rather than trusted.

**Browser-only mode is a separate binary, and a separate module.** It needs a
WireGuard implementation that terminates in userspace, which means a userspace
network stack: eighty-odd third-party modules against `vpnd`'s deliberate one.
Linking them into the daemon would put that much unaudited code, parsing
hostile packets, inside a process running as root or LocalSystem. It needs no
privileges of its own, so it gets none — `vpnd/browserproxy` is its own Go
module built into `vpn-browser-proxy`, which the daemon starts after dropping
to an unprivileged account on Unix and onto a restricted token on Windows. The
configuration goes down its stdin, never an argument, because arguments are
readable by every process on the machine and this one contains a private key.

That pipe then stays open. It is how the helper learns the daemon has gone: if
`vpnd` is killed rather than asked to stop, nothing sends a signal, but the
operating system closes the pipe — the difference between a tunnel that ends
with the daemon and one left running that nothing can take down.

**Browser-only mode resolves names inside the tunnel.** A proxy that carries
the connection but leaves the lookup to the browser leaks every site visited to
the local network's DNS, while each page loads over something that looks
private. So Chrome is configured with the `socks5` scheme — which sends
hostnames to the proxy rather than resolving them first — and the proxy dials
the tunnel's own DNS servers through the netstack. The SOCKS server refuses
UDP ASSOCIATE rather than half-implementing it, and the extension forces
`disable_non_proxied_udp` while the mode is on, because the UDP that WebRTC
would otherwise open is the one path out that a TCP proxy cannot cover.

**The two modes exclude each other.** Enforced in the daemon, not the UI: two
tunnels to the same peer would be two paths for the same traffic, and nothing
on the machine could say which one carried a request. The app and the extension
both grey the choice out while either is running, which is how a user finds
out; the daemon refusing is what makes it true whatever is calling.

**Nothing writes down who connected, or when.** The database was stripped to a
key and an address per device, which is only half the promise: a proxy that
logs a line per request, or a dated backup series, puts the history back where
the schema refuses to keep it. So Caddy logs failures only, with `remote_ip`,
`client_ip`, `remote_port` and every request header filtered out; the API logs
only responses of 400 and above; and `vpn update` takes exactly one backup,
overwritten each time and deleted the moment the update succeeds. With one
person behind one invite code, an activity timeline is nearly an identity, so
"anonymous but timestamped" is not good enough. Connection counts come from
`wg show latest-handshakes`, which the kernel keeps for live peers only and
never writes down.

**IPv6 is routed into the tunnel and dropped there, on purpose.** This server
does not carry IPv6 — the provider does not route it — so `::/0` in AllowedIPs
looks like dead weight. It is the opposite. It sends the client's IPv6 traffic
into a tunnel with no IPv6 address, where it fails immediately and the client
falls back to IPv4. Remove it and that traffic leaves over the ordinary
connection, from the user's real address, on every site with an AAAA record.
Carrying IPv6 properly needs egress on the server first; until then, dropping
it is the protected behaviour and `configRenderer.test.ts` pins it.

**The kill switch is per platform, and Windows already has one.**
`wireguard.exe` installs WFP filters that drop untunneled traffic whenever the
config has one peer, no `Table` key and a default route — all three are pinned
by `internal/tunnel/config_test.go`, because relaxing any of them here would
switch off leak protection on every Windows client without touching a line of
firewall code. Linux has nothing equivalent: wg-quick sets up policy routing
but no filtering, so `--kill-switch` installs an nftables table that denies by
default. It is off by default, it carves out loopback, DHCP, the LAN, the
WireGuard endpoint and the control plane, and vpnd clears any leftover block at
startup — a daemon that crashed with the rules installed would otherwise leave
a machine with no network and nothing on screen to explain it.

**Unknown is not "off".** The extension badge shows `?` when it cannot reach the
daemon, and a node whose liveness is unknown reports `online: false`. Saying
"off" while unprotected is correct; saying "off" while unknown is misleading.

## Phones: IKEv2 from the Settings screen

No phone can dial WireGuard from its own Settings, and shipping an app costs a
store account, a yearly fee and — on iOS — an entitlement application. So
phones take a different door: `server/scripts/setup-ikev2.sh` puts strongSwan
beside WireGuard, and a phone connects natively with a server name, a username
and a password typed into its own VPN settings. Nothing is installed.

The identity model is the same one the invite code uses: one shared secret for
every phone, so the server cannot tell phones apart and has nothing per-person
to hand over. `charondebug` is zeroed for the same reason the access logs are —
the database keeps no connection history, and the IKE daemon must not quietly
keep one instead. The phone verifies the server against the same Let's Encrypt
certificate a browser would, so there is no CA profile to install, and a
certbot deploy hook reloads strongSwan on renewal so the certificate on port
4500 cannot silently age out of step with the one on 443.

One sharp edge, learned the slow way: `ipsec.secrets` must name the server
key's actual type, and Let's Encrypt issues ECDSA by default now. Name it RSA
and strongSwan loads no key at all — the handshake runs right up to
authentication and every phone gets a useless AUTH_FAILED. The setup script
detects the type from the key itself.

WireGuard remains the protocol everywhere else; IKEv2 exists only because it
is the one protocol phones speak natively. The two share nothing but the
machine: separate address pools, separate credentials, separate daemons.

## Test strategy

We test the real paths, not mocked copies of them:

| What | How |
|---|---|
| The `wg` CLI (agent) | `Runner` injection — the exact argv is asserted |
| `flutter_secure_storage` | The platform channel is mocked; the real `SecureStore` runs |
| vpnd IPC | A fake daemon over a real AF_UNIX socket, from the Dart side |
| The node protocol | Real HTTP, two nodes, isolation and concurrent allocation |
| Key derivation | **RFC 7748 §6.1 test vectors** — not self-consistency |
| Native messaging | A stdio round trip with real framing |
| The browser-only helper | A real child process, compiled by the test, spawned and killed |

Why key derivation is pinned to vectors: a wrong derivation produces a tunnel
that never handshakes and never reports an error. A self-consistent test misses
it entirely.

`acceptance.mjs --check-wg` catches the one thing no mock can: it creates a
device and **waits for the key to appear in `wg show`**, exercising the whole
API → database → agent → `wg` chain.

## Deliberately not built

1. **Code signing** — procurement, not code. A Windows OV certificate is
   $200–400/year, Apple Developer $99/year plus notarisation.
2. **Email verification** — choosing an SMTP provider is a product decision, and
   half a flow is worse than none.
3. **Payment and subscriptions** — everyone who registers gets five devices.
4. **Mobile apps** — removed deliberately. Phones connect over IKEv2 from
   their own Settings screen (see below), which costs nothing to distribute,
   needs no store account or entitlement, and is maintained by Apple and
   Google rather than by this repository.
6. **Region picker UI** — `VpnController.selectServer()` is ready and has no
   button. It arrives when a second node does.
