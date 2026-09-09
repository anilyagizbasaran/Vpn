package main

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
)

// tunnelConfig is everything the userspace tunnel needs, read from the same
// wg-quick config the system-wide mode uses.
//
// Reusing one config format is the point: browser-only mode is not a different
// tunnel, it is the same tunnel terminated in this process instead of in the
// kernel. The control plane issues one config and does not need to know which
// mode the device happens to be in.
type tunnelConfig struct {
	PrivateKey   string
	PublicKey    string
	PresharedKey string
	Endpoint     string
	Addresses    []netip.Addr
	DNS          []netip.Addr
	MTU          int
	Keepalive    int
}

// parseConfig reads a wg-quick config. Unknown keys are ignored rather than
// rejected, because this parser is downstream of the daemon's validator, which
// is where a hostile config is supposed to be stopped.
func parseConfig(raw string) (tunnelConfig, error) {
	cfg := tunnelConfig{MTU: 1420}
	section := ""

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			section = strings.ToLower(strings.Trim(line, "[]"))
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)

		switch {
		case section == "interface" && key == "privatekey":
			cfg.PrivateKey = value
		case section == "interface" && key == "address":
			addrs, err := parseAddrList(value)
			if err != nil {
				return cfg, fmt.Errorf("Address: %w", err)
			}
			cfg.Addresses = addrs
		case section == "interface" && key == "dns":
			addrs, err := parseAddrList(value)
			if err != nil {
				return cfg, fmt.Errorf("DNS: %w", err)
			}
			cfg.DNS = addrs
		case section == "interface" && key == "mtu":
			mtu, err := strconv.Atoi(value)
			if err != nil {
				return cfg, fmt.Errorf("MTU: %w", err)
			}
			cfg.MTU = mtu
		case section == "peer" && key == "publickey":
			cfg.PublicKey = value
		case section == "peer" && key == "presharedkey":
			cfg.PresharedKey = value
		case section == "peer" && key == "endpoint":
			cfg.Endpoint = value
		case section == "peer" && key == "persistentkeepalive":
			ka, err := strconv.Atoi(value)
			if err != nil {
				return cfg, fmt.Errorf("PersistentKeepalive: %w", err)
			}
			cfg.Keepalive = ka
		}
	}

	if cfg.PrivateKey == "" {
		return cfg, fmt.Errorf("the configuration has no private key")
	}
	if cfg.PublicKey == "" || cfg.Endpoint == "" {
		return cfg, fmt.Errorf("the configuration has no peer to connect to")
	}
	if len(cfg.Addresses) == 0 {
		return cfg, fmt.Errorf("the configuration has no tunnel address")
	}
	if len(cfg.DNS) == 0 {
		// Without a resolver inside the tunnel every lookup would have to go
		// out some other way, which is the leak this mode exists to prevent.
		return cfg, fmt.Errorf("the configuration has no DNS server")
	}
	return cfg, nil
}

// parseAddrList reads a comma-separated list, dropping any prefix length. The
// stack is told the address; the routing is a default route either way.
func parseAddrList(value string) ([]netip.Addr, error) {
	var out []netip.Addr
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if prefix, err := netip.ParsePrefix(part); err == nil {
			out = append(out, prefix.Addr())
			continue
		}
		addr, err := netip.ParseAddr(part)
		if err != nil {
			return nil, fmt.Errorf("%q is not an address", part)
		}
		out = append(out, addr)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no addresses")
	}
	return out, nil
}

// uapi renders the configuration in the format wireguard-go's device accepts.
//
// The keys are hex there and base64 in the config file, which is a conversion
// worth doing in one place: a mistake produces a tunnel that builds, runs, and
// silently never completes a handshake.
func (c tunnelConfig) uapi() (string, error) {
	priv, err := hexKey(c.PrivateKey)
	if err != nil {
		return "", fmt.Errorf("private key: %w", err)
	}
	pub, err := hexKey(c.PublicKey)
	if err != nil {
		return "", fmt.Errorf("peer public key: %w", err)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", priv)
	fmt.Fprintf(&b, "public_key=%s\n", pub)
	fmt.Fprintf(&b, "endpoint=%s\n", c.Endpoint)
	fmt.Fprintf(&b, "allowed_ip=0.0.0.0/0\n")
	fmt.Fprintf(&b, "allowed_ip=::/0\n")

	if c.PresharedKey != "" {
		psk, err := hexKey(c.PresharedKey)
		if err != nil {
			return "", fmt.Errorf("preshared key: %w", err)
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", psk)
	}
	if c.Keepalive > 0 {
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", c.Keepalive)
	}
	return b.String(), nil
}

func hexKey(base64Key string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil {
		return "", fmt.Errorf("not base64")
	}
	if len(raw) != 32 {
		return "", fmt.Errorf("is %d bytes, want 32", len(raw))
	}
	return hex.EncodeToString(raw), nil
}
