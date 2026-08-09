package protocol

import (
	"regexp"
	"strings"
)

// Any `Key = value` line whose key names a secret.
var secretLine = regexp.MustCompile(`(?im)^\s*(PrivateKey|PresharedKey)\s*=.*$`)

// RedactConfig strips key material from a wg-quick config so it can be logged.
//
// The daemon logs configs when a tunnel fails to come up, which is exactly the
// moment an operator wants to see one — and exactly the moment a private key
// would otherwise be written to the system journal in cleartext, where it
// outlives the tunnel and survives log shipping.
func RedactConfig(config string) string {
	return secretLine.ReplaceAllStringFunc(config, func(line string) string {
		key, _, found := strings.Cut(line, "=")
		if !found {
			return line
		}
		return strings.TrimRight(key, " \t") + " = [redacted]"
	})
}
