# Drops and slowness

Three symptoms, three different causes. Confusing them is how hours get spent
in the wrong place.

| Symptom | Cause | Fixed in |
|---|---|---|
| Connected, but some sites hang and HTTPS stalls while ping works | **MTU** | the client config |
| Drops after a period of inactivity, recovers when you open the app | **NAT timeout** | `PersistentKeepalive` |
| Fast but stuttering, packet loss under load | **Kernel buffers** | server sysctl |

## 1. MTU — "ping works, HTTPS hangs"

The most common and the most misleading. Small packets get through, large ones
do not. A router on the path is supposed to send a "fragmentation needed" ICMP,
but much of the internet filters ICMP, so that message never arrives. The
tunnel looks up and does not work.

**The default is 1420** (`WG_CLIENT_MTU`), which is right for an ordinary
1500-byte path. When the path is not 1500, it has to come down:

| Access type | Path MTU | Use |
|---|---|---|
| Ordinary ethernet or fibre | 1500 | 1420 |
| PPPoE (most DSL) | 1492 | 1412 |
| Some mobile networks, CGNAT | 1400–1450 | 1380 |
| Another tunnel on top | varies | 1280 (the IPv6 floor; works everywhere) |

Do not guess the number — **measure it**. On the client, while connected:

```bash
./server/scripts/verify-tunnel.sh --expect-ip <VPS-IP>
```

The script sends a large packet with fragmentation forbidden. By hand:

```bash
# Find the largest payload that gets through; MTU = that + 28
ping -M do -s 1372 -c 2 1.1.1.1   # 1372 + 28 = 1400
```

Changing `WG_CLIENT_MTU` and restarting the control plane is enough — clients
pick it up the next time they fetch a config.

> Tune this for the worst path in your user base, not for one person. 1380
> works for everyone and costs under a percent on a good path; 1420 breaks
> completely on a bad one. When in doubt, go lower.

## 2. Drops — NAT timeout

When the client is behind NAT — a home router, a mobile network — and no
traffic flows, the router drops the UDP mapping and the server can no longer
reach the client. Users describe this as "it fixes itself when I open the app".

**`PersistentKeepalive = 25`** solves it, and is the default here. The 25 is
not arbitrary: the most aggressive UDP NAT timeouts in the field cluster around
30 seconds, and 25 is the largest round number below that.

If it still drops, the NAT is unusually aggressive — try
`WG_PERSISTENT_KEEPALIVE=15`. Going lower buys nothing and spends battery and
data.

The keepalive belongs on the **client**, not the server: the client is the side
behind NAT. The `.conf` this project generates is a client config, so it is
already in the right place.

**WireGuard handles roaming by itself:** when a client moves from wifi to
mobile, the server updates the endpoint from the first authenticated packet.
There is no setting for this and none is needed.

## 3. Packet loss under load — kernel buffers

The default `rmem_max` is around 212 KB on most distributions. That is not
enough to hold the burst of packets arriving while WireGuard decrypts: the
kernel drops them **before WireGuard sees them**. To the user this is "fast but
stuttering".

`setup-wg.sh` writes these to `/etc/sysctl.d/99-wireguard.conf`:

```
net.core.rmem_max = 16777216        # 212 KB -> 16 MB
net.core.wmem_max = 16777216
net.core.netdev_max_backlog = 5000  # queue between the NIC and the kernel
net.core.netdev_budget = 600        # packets processed in one NAPI poll
net.netfilter.nf_conntrack_max = 262144
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
```

**conntrack matters most.** Because of the NAT rule, every tunnelled flow holds
a conntrack slot. The default table fills silently, and once it is full new
connections fail at random — which users report as "sometimes it just doesn't
load", the hardest symptom of all to diagnose.

Watch how full it is:

```bash
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
```

**BBR** is clearly better than cubic on the long, lossy paths a VPN produces.
If the kernel has no `tcp_bbr`, the script warns and carries on.

## What to measure

```bash
sudo ./server/scripts/verify-deploy.sh                     # sysctl, NAT, forwarding
./server/scripts/verify-tunnel.sh --expect-ip <VPS-IP>     # MTU, leaks, handshake
sudo wg show wg0 transfer                                  # bytes moving both ways
sudo wg show wg0 latest-handshakes                         # older than 180s is trouble
```

While traffic flows, WireGuard rehandshakes roughly every two minutes. A last
handshake older than three minutes means the tunnel is idle or the peer is
unreachable.
