# Architecture

This file explains **why** the system is shaped this way. How to deploy it is
in [GO-LIVE.md](GO-LIVE.md); tuning and troubleshooting in [TUNING.md](TUNING.md).

## The principle

Compromising any one component should not be enough.

| Component | Knows | Does not know |
|---|---|---|
| Control plane (`server/`) | Hashed invite and device tokens, **public keys** | Private keys. It never touches WireGuard |
| Node agent (`vpn-node-agent`) | How to change the interface | Any token, or another node's peers |
| Client (`apps/client`) | Its device token; on mobile also **the private key** | On desktop it never sees a private key — the daemon holds it |
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
      ├─ vpn_tunnel_mobile    wireguard_flutter_plus
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
               mobile:   straight to VpnService / NetworkExtension
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

**The extension cannot send a config.** The bridge permits exactly four
actions: status, connect, disconnect, enroll. "Connect" re-applies the config
the daemon already accepted in this session, or fetches a fresh one if this
machine has enrolled.

**The extension cannot read a credential or erase one.** `identity` and
`forget` exist on the daemon socket, which is local and ACL-protected, and are
kept off the bridge: the first hands out a device token, the second is
destructive and machine-wide. `cmd/vpn-browser-host` asserts both in a test —
the allowlist is the boundary, so it is checked rather than trusted.

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
4. **iOS Network Extension** — needs an entitlement application, which takes
   weeks. Apply early.
5. **A desktop kill switch** — the daemon can write firewall rules but does not.
   Android uses the OS's built-in one. The browser extension has its own, which
   only covers the browser.
6. **Region picker UI** — `VpnController.selectServer()` is ready and has no
   button. It arrives when a second node does.
