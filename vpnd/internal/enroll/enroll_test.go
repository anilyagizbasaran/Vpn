package enroll

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateKeysProducesAUsableWireGuardPair(t *testing.T) {
	keys, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}

	private, err := base64.StdEncoding.DecodeString(keys.Private)
	if err != nil || len(private) != 32 {
		t.Fatalf("private key is %d bytes: %v", len(private), err)
	}
	public, err := base64.StdEncoding.DecodeString(keys.Public)
	if err != nil || len(public) != 32 {
		t.Fatalf("public key is %d bytes: %v", len(public), err)
	}

	// The pair really is a pair. A mismatch here would produce a tunnel that
	// never handshakes, with nothing anywhere saying why.
	parsed, err := ecdh.X25519().NewPrivateKey(private)
	if err != nil {
		t.Fatalf("the private key is not a valid X25519 scalar: %v", err)
	}
	if got := base64.StdEncoding.EncodeToString(parsed.PublicKey().Bytes()); got != keys.Public {
		t.Fatalf("public key does not derive from the private one")
	}

	// Two calls must not agree.
	other, _ := GenerateKeys()
	if other.Private == keys.Private {
		t.Fatal("two generated keys were identical")
	}
}

func TestValidateAddress(t *testing.T) {
	cases := []struct {
		name, in, want string
		ok             bool
	}{
		{name: "https", in: "https://vpn.example.com", want: "https://vpn.example.com", ok: true},
		{name: "trailing slash", in: "https://vpn.example.com/", want: "https://vpn.example.com", ok: true},
		{name: "surrounding space", in: "  https://vpn.example.com  ", want: "https://vpn.example.com", ok: true},
		{name: "port", in: "https://vpn.example.com:8443", want: "https://vpn.example.com:8443", ok: true},
		{name: "plain http", in: "http://vpn.example.com"},
		{name: "no scheme", in: "vpn.example.com"},
		{name: "empty", in: "   "},
		{name: "credentials", in: "https://user:pass@vpn.example.com"},
		{name: "path", in: "https://vpn.example.com/api/v2"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ValidateAddress(c.in)
			if c.ok {
				if err != nil {
					t.Fatalf("rejected %q: %v", c.in, err)
				}
				if got != c.want {
					t.Fatalf("got %q, want %q", got, c.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("accepted %q", c.in)
			}
		})
	}
}

const testConf = "[Interface]\nPrivateKey = <PRIVATE_KEY>\nAddress = 10.8.0.2/32\n"

func TestEnrolSendsOnlyThePublicHalf(t *testing.T) {
	var body map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/enroll" || r.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"conf": ` + jsonString(testConf) + `,
			"server": {"endpoint": "vpn.test:51820"},
			"deviceToken": "vpndev_abc"
		}`))
	}))
	defer server.Close()

	client := New(server.URL)
	result, err := client.Enrol(context.Background(), "vpninv_code", "laptop", "linux")
	if err != nil {
		t.Fatal(err)
	}

	if body["publicKey"] != result.Keys.Public {
		t.Fatalf("sent public key %v, kept %q", body["publicKey"], result.Keys.Public)
	}
	// The one property the whole design rests on.
	for key, value := range body {
		if str, ok := value.(string); ok && str == result.Keys.Private {
			t.Fatalf("the private key was sent as %q", key)
		}
	}
	if _, present := body["privateKey"]; present {
		t.Fatal("the request carried a privateKey field")
	}

	if result.DeviceToken != "vpndev_abc" {
		t.Fatalf("device token = %q", result.DeviceToken)
	}
	if result.Endpoint != "vpn.test:51820" {
		t.Fatalf("endpoint = %q", result.Endpoint)
	}
	// The placeholder is gone and the real key is in its place; a config still
	// holding it would be installed verbatim and never connect.
	if strings.Contains(result.Config, PrivateKeyPlaceholder) {
		t.Fatal("the placeholder survived")
	}
	if !strings.Contains(result.Config, "PrivateKey = "+result.Keys.Private) {
		t.Fatal("the private key was not substituted in")
	}
}

func TestEnrolSurfacesTheServersOwnMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"forbidden","message":"That invite code has been revoked."}}`))
	}))
	defer server.Close()

	_, err := New(server.URL).Enrol(context.Background(), "vpninv_dead", "", "")
	if err == nil {
		t.Fatal("a 403 was treated as success")
	}
	// Rewriting it would replace the one sentence that tells the user what to
	// do with a generic failure.
	if err.Error() != "That invite code has been revoked." {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestFetchConfigAuthenticatesWithTheDeviceToken(t *testing.T) {
	var bearer string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/device/config" || r.Method != http.MethodGet {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		bearer = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"conf": ` + jsonString(testConf) + `,
			"server": {"endpoint": "vpn.test:51820"}
		}`))
	}))
	defer server.Close()

	keys, _ := GenerateKeys()
	result, err := New(server.URL).FetchConfig(context.Background(), "vpndev_stored", keys)
	if err != nil {
		t.Fatal(err)
	}

	if bearer != "Bearer vpndev_stored" {
		t.Fatalf("authorization = %q", bearer)
	}
	// The key is the caller's, not a new one: re-keying on every reconnect
	// would leave a trail of peers the server still believes in.
	if result.Keys.Private != keys.Private {
		t.Fatal("FetchConfig replaced the key it was given")
	}
	if !strings.Contains(result.Config, "PrivateKey = "+keys.Private) {
		t.Fatal("the stored key was not substituted in")
	}
}

func TestARedirectIsRefusedRatherThanFollowed(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the invite code was delivered to the redirect target: %s", r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer elsewhere.Close()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, &http.Request{}, elsewhere.URL+"/enroll", http.StatusFound)
	}))
	defer server.Close()

	if _, err := New(server.URL).Enrol(context.Background(), "vpninv_code", "", ""); err == nil {
		t.Fatal("a redirect to another host was followed")
	}
}

func TestAConfigWithNoPlaceholderIsRefused(t *testing.T) {
	// An older or misconfigured control plane that renders its own key. Using
	// it would mean a tunnel built on a key this machine cannot vouch for.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"conf":"[Interface]\nAddress = 10.8.0.2/32\n","server":{}}`))
	}))
	defer server.Close()

	if _, err := New(server.URL).Enrol(context.Background(), "vpninv_code", "", ""); err == nil {
		t.Fatal("a config with no endpoint was accepted")
	}
}

func jsonString(s string) string {
	encoded, _ := json.Marshal(s)
	return string(encoded)
}
