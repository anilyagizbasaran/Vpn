// Package enroll registers this machine with a control plane and fetches the
// tunnel configuration for it.
//
// It is the one place in vpnd that talks to the network, and it exists so that
// the browser extension does not have to. An extension that enrolled itself
// would have to hold a WireGuard private key in browser storage, readable by
// anything that can read the profile directory. Here the key is generated
// inside the daemon and never leaves it.
//
// The daemon runs privileged, so the reach is deliberately narrow: two GETs
// and a POST against one host the user typed in, over TLS, with a timeout and
// a response size cap. No redirects to other hosts, no retries, no discovery.
package enroll

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MaxResponseBytes caps what the daemon will read from a control plane. A
// config is a couple of kilobytes; anything larger is a mistake or an attempt
// to make a privileged process allocate without limit.
const MaxResponseBytes = 256 * 1024

// PrivateKeyPlaceholder is what the control plane renders instead of a key it
// does not have. Substituting it here is the last step before the config
// reaches the interface.
const PrivateKeyPlaceholder = "<PRIVATE_KEY>"

// Keys is an X25519 pair, base64-encoded the way WireGuard writes them.
type Keys struct {
	Private string
	Public  string
}

// GenerateKeys produces a WireGuard keypair.
//
// crypto/ecdh clamps the scalar exactly as X25519 requires, so the bytes it
// returns are already a valid WireGuard private key — there is no separate
// clamping step to forget.
func GenerateKeys() (Keys, error) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return Keys{}, fmt.Errorf("generate x25519 key: %w", err)
	}
	return Keys{
		Private: base64.StdEncoding.EncodeToString(key.Bytes()),
		Public:  base64.StdEncoding.EncodeToString(key.PublicKey().Bytes()),
	}, nil
}

// Result is everything the daemon needs to bring a tunnel up, plus the
// credential it needs to ask again later.
type Result struct {
	// Config with the placeholder already replaced by the private key.
	Config string
	// WireGuard endpoint, as host:port.
	Endpoint string
	// Issued at enrolment only; empty when re-fetching a config.
	DeviceToken string
	Keys        Keys
}

// Client talks to one control plane.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New builds a client for baseURL.
//
// The redirect policy is not a default worth inheriting: a control plane that
// answers 302 to another host would otherwise receive the invite code, and the
// user authorised exactly one address.
func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		HTTP: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("the VPN service redirected, which is not allowed here")
			},
		},
	}
}

// ValidateAddress checks an address before anything is sent to it.
//
// HTTPS only, and no credentials or path smuggled into the URL: the invite
// code and the device token both travel in these requests, and a plain-HTTP
// control plane would put them on the wire in the clear.
func ValidateAddress(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("Enter the address of your VPN server.")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return "", errors.New("That does not look like an address. It should start with https://")
	}
	if parsed.Scheme != "https" {
		return "", errors.New("The address must start with https:// — your invite code would otherwise travel unencrypted.")
	}
	if parsed.User != nil {
		return "", errors.New("Remove the username from the address.")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("Enter only the address, with no path after it.")
	}
	return trimmed, nil
}

type enrolRequest struct {
	InviteToken string `json:"inviteToken"`
	PublicKey   string `json:"publicKey"`
	Label       string `json:"label,omitempty"`
	Platform    string `json:"platform,omitempty"`
}

// The subset of the control plane's answer this daemon uses. Everything else
// in the payload is for the app's device list, which vpnd does not draw.
type configResponse struct {
	Conf   string `json:"conf"`
	Server struct {
		Endpoint string `json:"endpoint"`
	} `json:"server"`
	DeviceToken string `json:"deviceToken"`
}

type errorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Enrol registers a new device and returns a config ready for the interface.
//
// The keypair is made here and only the public half is sent, so a control
// plane that is compromised — or simply dishonest — never holds anything that
// could decrypt this machine's traffic.
func (c *Client) Enrol(ctx context.Context, inviteToken, label, platform string) (Result, error) {
	keys, err := GenerateKeys()
	if err != nil {
		return Result{}, err
	}

	body, err := json.Marshal(enrolRequest{
		InviteToken: strings.TrimSpace(inviteToken),
		PublicKey:   keys.Public,
		Label:       label,
		Platform:    platform,
	})
	if err != nil {
		return Result{}, fmt.Errorf("encode enrolment request: %w", err)
	}

	answer, err := c.do(ctx, http.MethodPost, "/enroll", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	return finish(answer, keys)
}

// FetchConfig asks for this device's config again, using the token enrolment
// issued. This is what makes a reboot survivable: the daemon keeps a key and a
// token, not a stale config that may name an address the server has reused.
func (c *Client) FetchConfig(ctx context.Context, deviceToken string, keys Keys) (Result, error) {
	answer, err := c.do(ctx, http.MethodGet, "/device/config", nil, deviceToken)
	if err != nil {
		return Result{}, err
	}
	return finish(answer, keys)
}

func finish(answer configResponse, keys Keys) (Result, error) {
	if answer.Conf == "" {
		return Result{}, errors.New("The VPN service did not return a configuration.")
	}
	if answer.Server.Endpoint == "" {
		return Result{}, errors.New("The VPN service did not say which server to connect to.")
	}

	// A config that still holds the placeholder would be installed verbatim
	// and the tunnel would sit on "connecting" with nothing to explain it.
	config := strings.ReplaceAll(answer.Conf, PrivateKeyPlaceholder, keys.Private)
	if strings.Contains(config, PrivateKeyPlaceholder) {
		return Result{}, errors.New("The configuration could not be completed.")
	}

	return Result{
		Config:      config,
		Endpoint:    answer.Server.Endpoint,
		DeviceToken: answer.DeviceToken,
		Keys:        keys,
	}, nil
}

func (c *Client) do(
	ctx context.Context,
	method, path string,
	body io.Reader,
	bearer ...string,
) (configResponse, error) {
	var answer configResponse

	request, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return answer, errors.New("That address could not be used.")
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if len(bearer) > 0 && bearer[0] != "" {
		request.Header.Set("Authorization", "Bearer "+bearer[0])
	}

	response, err := c.HTTP.Do(request)
	if err != nil {
		return answer, errors.New("Could not reach the VPN service. Check the address and your connection.")
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes))
	if err != nil {
		return answer, errors.New("The VPN service stopped responding.")
	}

	if response.StatusCode >= 400 {
		var failure errorResponse
		if json.Unmarshal(raw, &failure) == nil && failure.Error.Message != "" {
			return answer, errors.New(failure.Error.Message)
		}
		return answer, fmt.Errorf("The VPN service refused the request (%d).", response.StatusCode)
	}

	if err := json.Unmarshal(raw, &answer); err != nil {
		return answer, errors.New("The VPN service returned something unexpected.")
	}
	return answer, nil
}
