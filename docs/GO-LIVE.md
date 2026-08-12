# Going live, in order

Every step ends with a check. When one is red, do not move on — every later
failure surfaces as the same vague symptom ("connecting…"), and tracing it
backwards costs hours.

> **The short way.** On a fresh Ubuntu or Debian VPS,
> `curl -fsSL https://raw.githubusercontent.com/anilyagizbasaran/Vpn/main/install.sh | sudo bash`
> does all of steps 1 to 3 and prints the address to paste into the app. What
> follows is the same thing by hand, which is what to read when the installer
> stops somewhere.

## 0. Before you start

```bash
# Locally, the last check before deploying
cd server && npm test && npm run typecheck
cd vpnd   && go test ./... && go vet ./...
dart pub get && dart analyze packages apps
```

## 1. The WireGuard server

```bash
# On the VPS (Ubuntu/Debian, as root)
sed -i 's/\r$//' scripts/*.sh          # if you copied these from Windows
chmod +x scripts/*.sh
./scripts/setup-wg.sh --endpoint vpn.example.com --port 51820
```

**Check:**

```bash
sudo ./scripts/verify-deploy.sh
```

The control plane does not exist yet, so "vpn-api is not running" is expected.
What must not be red: the interface, forwarding, MASQUERADE, the port.

## 2. The control plane

Two ways, same result. `.env` is the same file either way: the `WG_*` values
`setup-wg.sh` printed, plus the output of `npm run keygen`, plus
`NODE_ENV=production`, `TRUST_PROXY=1`, `WG_SKIP_BOOTSTRAP_NODE=true`.

**a) systemd**

```bash
sudo systemctl enable --now vpn-api
sudo systemctl reload caddy
```

**b) Docker** — brings Caddy with it

```bash
SITE_ADDRESS=vpn.example.com docker compose up -d
docker compose ps        # api should be "healthy"
```

`SITE_ADDRESS` is the only thing that differs between a laptop and production:
set it and Caddy fetches a Let's Encrypt certificate on boot; leave it and it
serves plain HTTP on :80 without touching ACME.

What makes this possible is that the control plane needs no privileges at all:
the container runs with `cap_drop: ALL`, `read_only` and `no-new-privileges`,
and the database volume is the only thing it writes.

WireGuard is **not** containerised. `wg0` is a host kernel interface brought up
by `setup-wg.sh`, and it survives everything including `docker compose down`.
Peers are not lost when the containers are rebuilt.

**Check:**

```bash
sudo ./scripts/verify-deploy.sh   # no agent yet, so the node warning is normal
```

The acceptance run comes after the agent — at the end of the next step.

## 3. The node agent

> **Required even on a single server.** The control plane no longer touches
> WireGuard — that is exactly what lets it run unprivileged. Without an agent,
> peers exist in the database and nowhere else.

With the control plane up, define the node and then connect the agent:

```bash
cd /opt/vpn-control-plane
npm run node:add -- --region de-fra --display "Frankfurt" \
  --endpoint vpn.example.com:51820 \
  --public-key "$(sudo cat /etc/wireguard/server_public.key)" \
  --pool 10.8.0.0/24 --default

# The same command under Docker:
docker compose exec api node scripts/add-node.mjs --region de-fra \
  --display "Frankfurt" --endpoint vpn.example.com:51820 \
  --public-key "$(sudo cat /etc/wireguard/server_public.key)" \
  --pool 10.8.0.0/24 --default
```

The token is printed once. On the node:

```bash
sudo install -m 755 vpn-node-agent /usr/local/bin/
sudo tee /etc/vpn-node-agent.env >/dev/null <<'EOF'
VPN_CONTROL_PLANE=https://vpn.example.com
VPN_NODE_TOKEN=<the token node:add printed>
VPN_INTERFACE=wg0
EOF
sudo chmod 600 /etc/vpn-node-agent.env
sudo cp deploy/vpn-node-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vpn-node-agent
```

Docker works too, but **systemd is preferred.** The agent needs host networking
to see `wg0` and `CAP_NET_ADMIN` to change it; together those give the
container the same reach the systemd unit has, without that unit's sandboxing
(`ProtectSystem`, `ProtectKernelTunables`, `RestrictNamespaces`). If you want
it anyway:

```bash
cp vpnd/.env.example vpnd/.env    # paste the token
docker compose --profile agent up -d agent
```

**Check:**

```bash
sudo journalctl -u vpn-node-agent -n 20    # expect "peers reconciled"
curl -s https://vpn.example.com/ready | jq '.nodes'
```

`online: false` means the agent cannot reach the API. `agentProvisioned: false`
means no token was ever minted.

The whole chain is up, so now run it end to end:

```bash
node scripts/acceptance.mjs https://vpn.example.com --check-wg
```

Run on the server *itself*, `--check-wg` creates a device and **waits for the
key to appear in `wg show`** — exercising the API, the database, the agent and
`wg`. It is the one thing no mock can test. It also checks the inverse of
rotation: that the old key **leaves** the interface.

The script creates and deletes its own accounts, so it is safe against
production. Add `--rate-limits` to exercise the limiter too — it **locks the IP
you run it from out for 15 minutes**.

## 4. The mobile client

```bash
cd apps/client
flutter run --release --dart-define=API_BASE_URL=https://vpn.example.com
```

**Check:** connect on the phone, then on the VPS:

```bash
sudo wg show wg0 latest-handshakes    # a timestamp other than zero
sudo wg show wg0 transfer             # bytes in both directions
```

On the phone, `whatismyip` should show the VPS's address.

For something more thorough on a Linux or macOS client:

```bash
./server/scripts/verify-tunnel.sh --expect-ip <VPS-IP>
```

That checks three things which are hard to notice by hand: **IPv6 leaks** (the
classic on an IPv4-only tunnel), where DNS actually goes, and MTU (ping working
while HTTPS hangs).

## 5. The desktop client

```bash
# Linux
sudo install -m 755 vpnd /usr/local/bin/vpnd
sudo groupadd -f vpn && sudo usermod -aG vpn "$USER"   # then log out and back in
sudo cp deploy/vpnd.service /etc/systemd/system/
sudo systemctl enable --now vpnd

# Windows (administrator PowerShell)
.\deploy\install-windows.ps1 -BinaryPath .\bin\vpnd.exe
```

> The same binary is both a service and a console program;
> `svc.IsWindowsService()` tells them apart. Started as a service it reports
> running to the SCM, and on a stop request it brings the tunnel down before
> exiting.
>
> To run it without installing a service while developing:
>
> ```powershell
> Start-Process .\bin\vpnd.exe -Verb RunAs
> ```

**Check:**

```bash
./scripts/verify-daemon.sh                 # Linux/macOS
.\scripts\verify-daemon.ps1                # Windows
```

That script tries the two things that matter most: that the socket is **not
listening on TCP**, and that a config containing `PostUp` is **refused**. The
second genuinely attempts to write a file — if it worked, that would be code
execution as root or SYSTEM.

## 6. The browser extension

[extension/README.md](../extension/README.md) — you need the extension's ID for
the native host manifest, and Chrome has to be restarted afterwards.

**Check:** the badge shows `ON` and Disconnect works from the popup.

## 7. The dashboard and download page

Under Docker both are already inside the `caddy` image, served at `/` and
`/dashboard/`. By hand:

```bash
cd apps/dashboard && flutter build web --release --base-href /dashboard/
# copy build/web to wherever Caddy serves from
```

`--base-href` matters: Flutter writes `<base href="/">` otherwise, and a build
served under `/dashboard/` then fetches its bootstrap from the wrong path and
renders a blank page with nothing to explain it.

Leaving `API_BASE_URL` empty makes the dashboard same-origin — when Caddy
serves the page and proxies `/auth` and `/devices`, nothing needs configuring
and CORS never comes up.

---

## When something goes wrong

| Symptom | Where to look |
|---|---|
| "connecting" forever | `sudo wg show wg0 latest-handshakes` — zero means the key is not on the server |
| Handshake, but no internet | `verify-deploy.sh` → forwarding and MASQUERADE |
| Ping works, HTTPS hangs | MTU. Try `WG_CLIENT_MTU=1380` |
| The IP did not change | `verify-tunnel.sh` → AllowedIPs is probably not `0.0.0.0/0` |
| "service is not running" on desktop | `verify-daemon.sh` — the service, the socket permissions, or the protocol |
| Everyone gets 429 at once | `TRUST_PROXY` does not match the number of proxies |
| Device added but no tunnel | The agent is not running: `journalctl -u vpn-node-agent` |
| `/ready` returns 503 | No agent has synced |
