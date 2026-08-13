# WireGuard VPN — control plane, clients, and daemon

A self-hosted WireGuard VPN service: an API that hands out invite codes and
devices, a Flutter app for every platform, a privileged desktop daemon, a
browser extension, and the agent that puts peers onto the interface.

There are no accounts. You run the server, it gives you a code, you type the
code and the address into the app. That is the whole setup.

The design goal is that **compromising any one component is not enough**.

| Component | Knows | Cannot |
|---|---|---|
| Control plane (`server/`) | Hashed invite and device tokens, **public keys** | Touch WireGuard. Holds no private keys and no privileges |
| Node agent (`vpn-node-agent`) | How to edit the interface | Read a token, or learn another node's peers |
| Client (`apps/client`) | Its device token, **the private key** | Touch the network interface (on desktop) |
| Desktop daemon (`vpnd`) | How to bring a tunnel up; on desktop, the device token and **the private key** | Anything beyond the one control plane it was pointed at |
| Extension (`extension/`) | Whether the tunnel is up | See, hold or produce key material |

The private key is generated on the device and never leaves it. The server
stores only the public key, so a full disk compromise of the control plane
decrypts nothing. The cost is stated plainly: **lose the device, lose the key** —
there is no copy to restore, and the app handles it by enrolling again with an
invite code.

## Install

On a fresh Ubuntu or Debian VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/anilyagizbasaran/Vpn/main/install.sh | sudo bash
```

It installs WireGuard, the control plane, a certificate and the node agent,
then prints an address and an invite code. Paste both into the app and you have
a VPN.

**No domain needed.** The installer derives a hostname from the machine's own
address through [sslip.io](https://sslip.io), which is enough for Let's Encrypt
to issue a certificate. Pass `--domain vpn.example.com` to use your own instead.

Then download the app from
[Releases](https://github.com/anilyagizbasaran/Vpn/releases) and enter the
address and the code. Nothing else: no email, no password, no account to
recover.

One code, every device. Manage it from the server:

```bash
vpn status          # is a code set, and how many devices are on it
vpn devices         # one line per device: what it is, when, how much traffic
vpn revoke 3        # cut off one device; its address returns to the pool
vpn reset           # new code, devices stay connected
vpn reset --kick    # new code and remove every device
```

The code is ten characters from Crockford's base32 — no I, L, O or U, so
nothing has to be guessed from a font. It is shown once and stored only as an
HMAC, so `vpn status` can say a code exists but never what it is; if you lose
it, `vpn reset` issues a new one without disturbing anything already
connected.

There is no device quota. What bounds enrolment is the address pool, and what
answers a leaked code is `vpn reset --kick`.

## How it works

```
CONTROL PLANE                            DATA PLANE
─────────────                            ──────────
Client ──HTTPS──> Caddy ──> API          Client ──UDP 51820──> WireGuard
          :443           :3000                                  (wg0)
                           │                                      ▲
                        SQLite                                    │
                           ▲                              vpn-node-agent
                           └──── POST /node/sync ──────────────────┘
                                 (the agent pulls, every 10s)
```

Traffic never passes through the API. Nodes **pull** their peer set; the control
plane never dials out, so it needs no credential that would grant root on any
node, and nodes expose nothing but the WireGuard port. The cost of that choice
is equally clear: a revocation propagates within one poll interval rather than
instantly.

Multi-node support is built and unused — the schema, the node protocol, and
client-side region selection are all in place, but one node is running. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why each of these decisions
went the way it did.

### What the extension is for

It cannot open a tunnel — no browser extension can — so it shows the desktop
app's tunnel and toggles it. That would not be worth installing on its own.
What makes it worth having is the leak the tunnel **cannot** close:

- **WebRTC.** It hands page JavaScript the real adapter address, whatever the
  tunnel is doing. Only the browser can stop that, and it is on by default here.
- **A kill switch** that blocks browsing while the tunnel is down.
- **Ad and tracker blocking** — 77 third-party domains in two toggleable lists,
  with a per-site exemption for the pages that break without them.

None of it costs a network permission. The lists ship with the extension rather
than being fetched, and `declarativeNetRequest` blocking needs no host access,
so the extension still cannot read a page or see a request.

## Repository layout

```
server/            Control plane — Node + Express + TypeScript (127 tests)
  scripts/         Idempotent server setup and verification (bash)
  deploy/          systemd unit, Caddyfile, Dockerfile
vpnd/              Desktop service and node agent — Go
  cmd/             vpnd · vpnctl · vpn-browser-host · vpn-node-agent
packages/          Shared Dart layers (90 tests)
  vpn_crypto/          L0  X25519, one dependency: package:cryptography
  vpn_api/             L1  HTTP + models (no Flutter, no dart:io)
  vpn_tunnel/          L2  platform-agnostic tunnel contract
  vpn_tunnel_mobile/   L2  Android / iOS
  vpn_tunnel_desktop/  L2  vpnd IPC client
  vpn_client/          L3  controllers, storage, rotation policy
apps/
  client/          L4  Flutter app — Android, iOS, Windows, macOS, Linux
extension/         Companion browser extension (MV3)
website/           Download page
docs/              ARCHITECTURE.md · GO-LIVE.md · TUNING.md
```

Dependencies run one way: a layer may only import from the layers above it in
that list, and nothing in `packages/` may import from `apps/`. That boundary is
enforced rather than documented — CI compiles `vpn_api` to JavaScript on every
push, which fails the moment anyone adds Flutter or `dart:io` to a layer that
must not have either.

## Quick start

No WireGuard needed on a development machine: the control plane never invokes
it.

```bash
cd server
cp .env.example .env      # then: npm run keygen, paste the two secrets
npm install
npm test                  # 128 tests
npm run dev               # http://localhost:3000
```

With `WG_SKIP_BOOTSTRAP_NODE=true` and no node defined, `/ready` answers 503 and
enrolment returns 422 — that is correct, not a failure. Add a node with
`npm run node:add`, then see the code with `npm run vpn -- status`.

Flutter side — one `pub get` at the workspace root resolves everything:

```bash
dart pub get
cd apps/client
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
```

Desktop also needs the daemon, which can run without configuring a real tunnel:

```bash
cd vpnd
go build -o bin/vpnd ./cmd/vpnd
./bin/vpnd -mock -socket /tmp/vpnd.sock
```

> **Windows, once:** workspace path dependencies make Flutter create symlinks,
> which requires Developer Mode — `start ms-settings:developers`. Until it is
> on, `flutter build` fails.

## Deploying

[docs/GO-LIVE.md](docs/GO-LIVE.md) is the ordered runbook, with a verification
step after each stage. Do not skip ahead when one is red: every later failure
surfaces as the same vague symptom ("connecting…") and tracing it backwards
costs hours.

The short version — WireGuard on the host, then the control plane either way:

```bash
# 1. On the VPS, as root
./server/scripts/setup-wg.sh --endpoint vpn.example.com --port 51820

# 2a. systemd
sudo systemctl enable --now vpn-api

# 2b. or Docker (brings Caddy with it)
docker compose up -d

# 3. Register the node, then run the agent on it
npm run node:add -- --region de-fra --endpoint vpn.example.com:51820 \
  --public-key "$(sudo cat /etc/wireguard/server_public.key)" \
  --pool 10.8.0.0/24 --default
```

Step 3 is required even for a single server. The control plane no longer
configures WireGuard — that is exactly what lets it run unprivileged — so
without an agent, peers exist in the database and nowhere else.

WireGuard is not containerised. `wg0` is a host kernel interface that outlives
every rebuild, so `docker compose down` does not disturb a live tunnel.

## Verification scripts

Unit tests prove the code is right. These prove the **installation** is right —
the class of problem that works on a laptop and fails silently on a server.

| Script | Runs on | Catches |
|---|---|---|
| `server/scripts/verify-deploy.sh` | VPS (root) | Forwarding off, missing NAT rule, API running as root, placeholder secrets in `.env`, buffer and conntrack settings |
| `server/scripts/acceptance.mjs` | Anywhere | End-to-end API: enrolment, key rotation, token confusion between invites and devices, quota. With `--check-wg`, the "API says the peer exists but the interface disagrees" case |
| `server/scripts/verify-tunnel.sh` | Client, while connected | **IPv6 leaks**, where DNS actually goes, MTU (ping works, HTTPS hangs) |
| `vpnd/scripts/verify-daemon.{sh,ps1}` | Desktop | Whether the socket listens on TCP, ACLs, protocol mismatch, and whether a `PostUp` payload is really rejected |

```bash
cd server
npm run vpn -- status                                   # the code
npm run acceptance -- https://api.example.com ABCD123456 --check-wg
```

Every device the acceptance run enrols removes itself at the end, and
`vpn reset --kick` cuts off anything it missed, so it is safe against
production. The daemon script genuinely submits a hostile config
containing `PostUp` and then checks whether the file it names was written — if
it had been, that would be code execution as root.

## Security model

Stated explicitly, including where the edges are:

- **Address allocation** hands out the lowest free address in the pool.
  Predictability is harmless: peers are authenticated by public key, never by
  address.
- **Addresses are recycled immediately.** A revoked peer's address returns to
  the pool and may go to a different user. That is safe because the key leaves
  the interface in the same transaction — but if you keep abuse logs, **record
  timestamps**, because "who was 10.8.0.5" has more than one answer over time.
- **Concurrent allocation** is resolved by a partial unique index in the
  database, not by application logic. Two simultaneous `POST /enroll` may
  compute the same address; the loser retries up to six times.
- **The desktop daemon enrols, and that is a deliberate trade.** The browser
  extension sets a machine up by handing `vpnd` an address and an invite code;
  `vpnd` generates the keypair, calls the API and keeps the key. It is the most
  privileged component and it now makes outbound calls, which it did not
  before. The alternative was worse: an extension that enrolled itself would
  keep a private key in `chrome.storage.local`, in the clear, readable by
  anything that can read the browser profile. The reach is narrowed instead —
  HTTPS only, one host, no redirects, a timeout and a response size cap.
- **The desktop daemon keeps a key and a token on disk**, mode 0600, beside the
  tunnel config. Previously the config was written on connect and deleted on
  disconnect, so key material lived on disk only while the tunnel was up; now
  it persists. That is what makes the extension work after a reboot. An
  attacker who can read that file can connect as that device until it is
  revoked — which they could already do while the tunnel was up.
- **The control plane holds no privileges.** Clients generate keys, presharing
  uses 32 random bytes, and agents apply peers. No `sudo`, no `CAP_NET_ADMIN`,
  no `wg` binary — it runs in a container with an empty capability set.
- **Revocation is not instant.** It propagates within `NODE_POLL_SECONDS`
  (default 10). This is the price of never holding a credential that grants root
  on a node.
- **The agent keeps no state.** Whatever the control plane answers is the truth,
  so a node that was offline for an hour converges on its first successful sync.
  There is no separate recovery path after a reboot — it is the same path.
- **A failed sync leaves the peer table alone.** Turning a control-plane outage
  into a total outage is the wrong direction.
- **There are no accounts, and that removes a whole class of bug.** No password
  to reset, no email to enumerate, no session to expire, no refresh token to
  rotate and no reuse detection to get subtly wrong. An invite says one thing —
  this person may enrol devices — and revoking it says the opposite.
- **The invite code is ten characters — 50 bits — and that is deliberate.** It
  has to be read off a terminal and typed into a phone, and 32 random bytes
  does not survive that. Fifty bits is enough *because the code can only be
  attacked online*: `POST /enroll` is rate limited to 30 attempts an hour per
  address, which puts a single attacker at ~10^13 hours. The rate limiter is
  not a convenience here, it is the whole argument — remove it and the code
  becomes weak. Device tokens, which nobody types, stay at 32 random bytes.
- **Both are stored only as an HMAC.** A database leak yields no usable
  credential, and a code is shown once.
- **The two token kinds are hashed with different domain separators**
  (`invite:`, `device:`, `node:`), so a token of one kind can never be presented
  as another. Without that, a device token would be an invite — a stolen phone
  could enrol more devices.
- **A device token is a lookup, not a claim.** It names exactly one device, and
  no route takes a device id, so there is no ownership check to get wrong: the
  only device a token can reach is its own. That is why the client never
  retries a 401 — nothing about it can go stale, so a 401 means revoked.
- **Revoking a code does not, on its own, disconnect anybody.** The devices
  already enrolled hold their own tokens. `vpn reset --kick` is the operation
  that does both, and it is the only one offered for a leak, precisely so the
  half-measure is not something an operator can pick by accident.
- **The agent validates config before it reaches argv.** The control plane is
  trusted over TLS, but not trusted enough to inject arguments into a command
  running as root on every node.
- **IPv6 is out of scope.** The pool is IPv4. Clients carry `::/0` in
  `AllowedIPs`, so IPv6 traffic enters the tunnel and is dropped rather than
  leaking — but there is no IPv6 egress.

### Rate limits

| Scope | Window | Limit |
|---|---|---|
| `/health`, `/ready` (per IP) | 1 min | 120 |
| Global (per IP) | 15 min | 300 |
| `POST /enroll`, `POST /device/rotate`, `DELETE /device` (per IP) | 1 hour | 30 |
| `POST /node/sync` (per node) | 1 min | 120 |

Guessing an invite code is not feasible — 32 random bytes — but an unlimited
enrolment endpoint is an unlimited device-creation endpoint for anyone holding
one valid code. Probes are mounted **before** the global
limiter and on a separate budget: an uptime monitor pinging every five seconds
would otherwise consume 180 of the 300 requests in the window and hand real
users a 429. `express.json()` runs **after** the limiter, so a request destined
for a 429 never gets to parse 32 KB of JSON first.

## Status

| Part | State | Verified by |
|---|---|---|
| Control plane | Done | 128 tests; acceptance suite green against a live server |
| Dart layers | Done | 90 tests, `dart analyze` clean |
| Mobile app | Done | `flutter build apk --release` — 58 MB |
| Desktop daemon | Done | **Real tunnel, end to end**; Windows service start is broken (below) |
| Desktop GUI | Code done | Build unverified — needs the Visual Studio C++ workload |
| Browser extension | Done | Native host verified against a real daemon; toggles a live tunnel |
| Docker | Done | Site and API from one origin; `compose up` healthy |
| Website | Code done | The download grid stays empty until a release is published |
| CI | Done | Five jobs green, including a start-and-health-check of the API image |

**The tunnel is real.** A client generated a keypair, the control plane
allocated an address, the node agent applied the peer, and traffic left through
the VPS — verified from a container and from a Windows desktop, with no DNS
leak and no MTU stall.

One thing is worth knowing: the Windows service integration is new. The daemon
now speaks the service control protocol, and the same binary still runs from a
console — but the service path has been verified by cross-compiling and by
running it as a console process, not yet by a full install-and-start cycle.

## Not built, on purpose

1. **Code signing** — procurement, not code. A Windows OV certificate is
   $200–400/year, Apple Developer is $99/year plus notarisation. Releases are
   unsigned and the download page says so.
2. **Email verification** — choosing an SMTP provider is a product decision, and
   half a flow is worse than none.
3. **Payment and subscriptions** — everyone who registers gets five devices.
4. **iOS Network Extension** — needs an entitlement application, which takes
   weeks. Apply early.
5. **Desktop kill switch** — the daemon can write firewall rules but does not.
   Android uses the OS's built-in one.
6. **Region picker UI** — `VpnController.selectServer()` is ready and has no
   button. It arrives when a second node does.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — why the system is shaped
  this way, and the trust boundaries in full
- **[docs/GO-LIVE.md](docs/GO-LIVE.md)** — the deployment order, with a
  verification step after each stage
- **[docs/TUNING.md](docs/TUNING.md)** — drops, MTU, and throughput

> These three are written in Turkish; this README is not.

## License

[AGPL-3.0](LICENSE). Anyone who modifies this code and offers it **as a network
service** has to publish their changes. For a product consumed entirely as a
service, that is the clause a permissive licence leaves out.
