package enroll

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadReportsNeverEnrolledRatherThanFailing(t *testing.T) {
	store := NewStore(t.TempDir())

	identity, err := store.Load()
	if err != nil {
		t.Fatalf("a first run should not be an error: %v", err)
	}
	if identity != nil {
		t.Fatal("something was loaded from an empty directory")
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	store := NewStore(t.TempDir())
	want := Identity{
		ControlPlane: "https://vpn.example.com",
		DeviceToken:  "vpndev_abc",
		PrivateKey:   "cHJpdmF0ZQ==",
		PublicKey:    "cHVibGlj",
	}

	if err := store.Save(want); err != nil {
		t.Fatal(err)
	}

	got, err := store.Load()
	if err != nil || got == nil {
		t.Fatalf("load: %v", err)
	}
	if *got != want {
		t.Fatalf("got %+v, want %+v", *got, want)
	}
}

func TestSaveKeepsTheFileUnreadableToOthers(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows uses ACLs, not mode bits; the daemon's directory is under
		// ProgramData and inherits from there.
		t.Skip("permissions are ACL-based on Windows")
	}

	dir := t.TempDir()
	store := NewStore(dir)
	if err := store.Save(Identity{
		ControlPlane: "https://vpn.example.com",
		DeviceToken:  "vpndev_abc",
		PrivateKey:   "cHJpdmF0ZQ==",
	}); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(store.Path)
	if err != nil {
		t.Fatal(err)
	}
	// It holds a private key. Group- or world-readable would make it readable
	// by every account on the machine.
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("mode = %o, want 600", mode)
	}
}

func TestSaveLeavesNoTemporaryFileBehind(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	if err := store.Save(Identity{
		ControlPlane: "https://vpn.example.com",
		DeviceToken:  "vpndev_abc",
		PrivateKey:   "cHJpdmF0ZQ==",
	}); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Fatalf("a temporary file with a private key in it was left behind: %s", entry.Name())
		}
	}
}

func TestAHalfWrittenIdentityReadsAsNeverEnrolled(t *testing.T) {
	// Every field is needed to authenticate; a file missing one is not a
	// device that can connect, and treating it as one would produce a 401 the
	// user cannot act on.
	for name, body := range map[string]string{
		"no token":         `{"controlPlane":"https://a.example","privateKey":"k"}`,
		"no key":           `{"controlPlane":"https://a.example","deviceToken":"t"}`,
		"no control plane": `{"deviceToken":"t","privateKey":"k"}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := NewStore(t.TempDir())
			if err := os.WriteFile(store.Path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}

			identity, err := store.Load()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if identity != nil {
				t.Fatal("an unusable identity was returned as usable")
			}
		})
	}
}

func TestCorruptIsReportedRatherThanSilentlyDiscarded(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := os.WriteFile(store.Path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Starting over silently would look to the user exactly like the device
	// being revoked, and they would spend the invite they did not need to.
	if _, err := store.Load(); err == nil {
		t.Fatal("a corrupt identity was treated as absent")
	}
}

func TestClearIsIdempotent(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := store.Clear(); err != nil {
		t.Fatalf("clearing nothing failed: %v", err)
	}

	if err := store.Save(Identity{
		ControlPlane: "https://vpn.example.com",
		DeviceToken:  "vpndev_abc",
		PrivateKey:   "cHJpdmF0ZQ==",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	if identity, _ := store.Load(); identity != nil {
		t.Fatal("the identity survived Clear")
	}
}
