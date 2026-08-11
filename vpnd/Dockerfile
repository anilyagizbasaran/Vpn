# syntax=docker/dockerfile:1
#
# The node agent, containerised. Read the honest version first:
#
# This container needs `--network host` (to see wg0, which lives in the host's
# network namespace) and CAP_NET_ADMIN (to change it). Between them it has the
# same reach over host networking as the systemd unit does, with none of that
# unit's sandboxing — no ProtectSystem, no ProtectKernelTunables, no
# RestrictNamespaces. So this buys packaging convenience, not isolation.
#
# On a VPS, prefer deploy/vpn-node-agent.service. Use this when the host is
# already container-only and installing a systemd unit is the awkward path.
#
#   docker compose --profile agent up -d agent

# --- build -------------------------------------------------------------------
FROM golang:1.26-bookworm AS build
WORKDIR /src

# No go.sum: this module has no third-party dependencies, on purpose (see
# go.mod). The bracket glob copies go.sum only if one ever appears, instead of
# failing the build the day it does.
COPY go.mod go.su[m] ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal

# CGO off so the binary does not link against this image's libc and then refuse
# to start on the smaller runtime image.
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" \
      -o /out/vpn-node-agent ./cmd/vpn-node-agent


# --- runtime -----------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# `wireguard-tools` alone, not `wireguard`: the agent only ever edits the peer
# table with `wg set`. Bringing the interface up is wg-quick's job and happens
# on the host, before this ever starts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wireguard-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/vpn-node-agent /usr/local/bin/vpn-node-agent

# Runs as root because CAP_NET_ADMIN is granted to the container, and the
# preshared keys it writes go to a tmpfs the compose file mounts.
ENTRYPOINT ["/usr/local/bin/vpn-node-agent"]
