package enroll

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Identity is what the daemon keeps between runs so it can rebuild a tunnel
// without being handed a config again.
//
// This is a deliberate change in how long key material lives on disk. Before,
// the config — private key included — was written when the tunnel came up and
// deleted when it went down. Now the key and the device token persist, because
// otherwise the browser extension can only reconnect until the next reboot,
// which is the thing it kept failing at.
//
// What that buys and what it costs, plainly: an attacker who can read this
// file can bring up a tunnel as this device, until the device is revoked. They
// could already do that while the tunnel was up. The file is 0600 and lives in
// the daemon's own directory, which is root-owned on Linux and under
// ProgramData on Windows — the same place the running config already sat.
type Identity struct {
	// Control plane this device belongs to. A device token means nothing
	// anywhere else, so the two are stored together and cleared together.
	ControlPlane string `json:"controlPlane"`
	DeviceToken  string `json:"deviceToken"`
	PrivateKey   string `json:"privateKey"`
	PublicKey    string `json:"publicKey"`
}

// Store reads and writes one [Identity].
type Store struct{ Path string }

// NewStore keeps the identity beside the tunnel configuration, so an operator
// who locks down one directory has locked down both.
func NewStore(configDir string) *Store {
	return &Store{Path: filepath.Join(configDir, "device.json")}
}

// Load returns the stored identity, or nil when this machine has never
// enrolled. A missing file is not an error: it is the ordinary first run.
func (s *Store) Load() (*Identity, error) {
	raw, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", s.Path, err)
	}

	var identity Identity
	if err := json.Unmarshal(raw, &identity); err != nil {
		// Corrupt beyond use. Reported rather than deleted: silently starting
		// over would look to the user like the device was revoked.
		return nil, fmt.Errorf("parse %s: %w", s.Path, err)
	}
	if identity.DeviceToken == "" || identity.PrivateKey == "" || identity.ControlPlane == "" {
		return nil, nil
	}
	return &identity, nil
}

// Save writes the identity, replacing any previous one.
func (s *Store) Save(identity Identity) error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(s.Path), err)
	}

	raw, err := json.MarshalIndent(identity, "", "  ")
	if err != nil {
		return fmt.Errorf("encode identity: %w", err)
	}

	// Written to a temporary file and renamed, so a crash midway leaves the
	// previous identity intact rather than a half-written one that reads as
	// "never enrolled" and sends the user back to an invite code they have
	// already spent.
	//
	// Removed first for the same reason the tunnel config is: os.WriteFile
	// follows a symlink, which would let anyone who can create one in this
	// directory choose where a private key lands.
	temp := s.Path + ".tmp"
	_ = os.Remove(temp)
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", temp, err)
	}
	if err := os.Rename(temp, s.Path); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("replace %s: %w", s.Path, err)
	}
	return nil
}

// Clear forgets this device. Used when the control plane says it no longer
// knows us, so the next connect asks for a code instead of retrying a
// credential that will keep failing.
func (s *Store) Clear() error {
	err := os.Remove(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
