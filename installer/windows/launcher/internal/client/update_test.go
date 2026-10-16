package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type releaseServer struct {
	mu       sync.Mutex
	server   *httptest.Server
	p        payload
	manifest []byte
	archive  []byte
	mode     string
	started  chan struct{}
}

func testServer(t *testing.T, keys map[string]ed25519.PublicKey) (*releaseServer, *updater) {
	t.Helper()
	s := &releaseServer{}
	s.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		manifest := append([]byte{}, s.manifest...)
		archive := append([]byte{}, s.archive...)
		mode := s.mode
		started := s.started
		s.mu.Unlock()
		if r.URL.Path == "/manifest" {
			if mode == "manifest oversized" {
				w.Write(bytes.Repeat([]byte("x"), maxEnvelope+1))
				return
			}
			if mode == "manifest compressed" {
				w.Header().Set("Content-Encoding", "gzip")
			}
			w.Write(manifest)
			return
		}
		if r.URL.Path != "/archive" {
			http.NotFound(w, r)
			return
		}
		if mode == "redirect http" {
			http.Redirect(w, r, "http://example.invalid/secret?token=private", http.StatusFound)
			return
		}
		if mode == "loop redirect" {
			http.Redirect(w, r, s.server.URL+"/archive", http.StatusFound)
			return
		}
		if mode == "truncated" {
			w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
			w.Write(archive[:len(archive)/2])
			return
		}
		if mode == "corrupt" {
			archive[0] ^= 1
		}
		if mode == "oversized" {
			archive = append(archive, 'x')
		}
		if mode == "cancel" {
			w.WriteHeader(http.StatusOK)
			w.Write(archive[:len(archive)/2])
			w.(http.Flusher).Flush()
			close(started)
			<-r.Context().Done()
			return
		}
		w.Write(archive)
	}))
	t.Cleanup(s.server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(s.server.Certificate())
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	t.Cleanup(transport.CloseIdleConnections)
	u := &updater{t.TempDir(), keys, &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: redirectPolicy}, time.Now}
	c := connection{1, "cudia", "stable", s.server.URL + "/manifest", 24, false}
	b, _ := json.Marshal(c)
	if err := os.WriteFile(filepath.Join(u.root, "connection.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	return s, u
}
func (s *releaseServer) set(t *testing.T, p payload, b []byte, priv ed25519.PrivateKey) {
	t.Helper()
	p.Artifacts = []artifact{{"archive", "windows", "x64", "normal", s.server.URL + "/archive", int64(len(b)), digest(b)}}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.p = p
	s.archive = b
	s.manifest = signPayload(t, p, priv)
	s.mode = ""
}
func initializeSmall(t *testing.T, u *updater, s *releaseServer, priv ed25519.PrivateKey) activation {
	t.Helper()
	p := testPayload()
	b, _ := smallPackage(t, p)
	s.set(t, p, b, priv)
	if err := u.initialize(context.Background(), "normal", s.manifest, writeArchive(t, b)); err != nil {
		t.Fatal(err)
	}
	state, err := readState(u.root)
	if err != nil {
		t.Fatal(err)
	}
	return state
}
func nextSmall(t *testing.T, s *releaseServer, priv ed25519.PrivateKey, seq int64) {
	t.Helper()
	p := testPayload()
	p.Sequence = seq
	p.Version = "1.2." + strconv.FormatInt(seq, 10)
	b, _ := smallPackage(t, p)
	s.set(t, p, b, priv)
}

func TestSignedTLSUpdateAndRollback(t *testing.T) {
	keys, priv := testKeys(t)
	s, u := testServer(t, keys)
	initial := initializeSmall(t, u, s, priv)
	nextSmall(t, s, priv, 2)
	p, _, available, err := u.check(context.Background())
	if err != nil || !available || p.Sequence != 2 {
		t.Fatal("check failed", err)
	}
	if _, err := u.apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	current, err := readState(u.root)
	if err != nil {
		t.Fatal(err)
	}
	if current.HighestSequence != 2 || current.SelectedReleaseID == initial.SelectedReleaseID || len(current.Installed) != 2 {
		t.Fatal("bad activated state")
	}
	if _, err := os.Stat(filepath.Join(u.root, "versions", initial.SelectedReleaseID, "launcher.exe")); err != nil {
		t.Fatal("old version was removed")
	}
	if err := u.rollback(initial.SelectedReleaseID); err != nil {
		t.Fatal(err)
	}
	rolled, err := readState(u.root)
	if err != nil || rolled.HighestSequence != 2 || rolled.SelectedReleaseID != initial.SelectedReleaseID {
		t.Fatal("rollback lowered sequence", err)
	}
	if _, _, _, err := u.check(context.Background()); err == nil {
		t.Fatal("update after rollback reinstalled old sequence")
	}
	if err := u.rollback("../arbitrary"); err == nil {
		t.Fatal("unverified rollback accepted")
	}
	nextSmall(t, s, priv, 3)
	if _, err := u.apply(context.Background()); err != nil {
		t.Fatal("higher sequence failed after rollback", err)
	}
	if _, err := u.apply(context.Background()); err != nil {
		t.Fatal("idempotent update failed", err)
	}
	if err := u.initialize(context.Background(), "normal", s.manifest, writeArchive(t, s.archive)); err != nil {
		t.Fatal("idempotent installer failed", err)
	}
}
func TestFailedDownloadPreservesActivation(t *testing.T) {
	for _, mode := range []string{"truncated", "corrupt", "oversized", "redirect http", "loop redirect", "manifest oversized", "manifest compressed", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			keys, priv := testKeys(t)
			s, u := testServer(t, keys)
			_ = initializeSmall(t, u, s, priv)
			before, err := os.ReadFile(filepath.Join(u.root, "state", "activation.json"))
			if err != nil {
				t.Fatal(err)
			}
			nextSmall(t, s, priv, 2)
			s.mu.Lock()
			s.mode = mode
			s.started = make(chan struct{})
			s.mu.Unlock()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel" {
				go func() {
					select {
					case <-s.started:
						cancel()
					case <-time.After(5 * time.Second):
						cancel()
					}
				}()
			}
			if _, err := u.apply(ctx); err == nil {
				t.Fatal("failed download activated")
			}
			after, err := os.ReadFile(filepath.Join(u.root, "state", "activation.json"))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatal("failed update changed activation")
			}
			entries, err := os.ReadDir(filepath.Join(u.root, "state", "staging"))
			if err != nil || len(entries) != 0 {
				t.Fatal("staging cleanup failed", err)
			}
		})
	}
}
func TestTLSVerificationAndEmptyTrust(t *testing.T) {
	keys, priv := testKeys(t)
	s, u := testServer(t, keys)
	initializeSmall(t, u, s, priv)
	plain := *u
	plain.http = &http.Client{Timeout: time.Second, CheckRedirect: redirectPolicy}
	if _, _, _, err := plain.check(context.Background()); err == nil {
		t.Fatal("accepted untrusted TLS server certificate")
	}
	plain = *u
	plain.keys = map[string]ed25519.PublicKey{}
	if _, _, _, err := plain.check(context.Background()); err == nil || !strings.Contains(err.Error(), "updates disabled") {
		t.Fatal("empty trust must disable updates", err)
	}
}
func TestOSLockAndAtomicCommitFailure(t *testing.T) {
	keys, priv := testKeys(t)
	s, u := testServer(t, keys)
	initial := initializeSmall(t, u, s, priv)
	nextSmall(t, s, priv, 2)
	l, err := acquireLock(u.root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := u.apply(context.Background()); err == nil {
		l.close()
		t.Fatal("concurrent updater entered lock")
	}
	l.close()
	statePath := filepath.Join(u.root, "state", "activation.json")
	before, _ := os.ReadFile(statePath)
	ptr, err := syscall.UTF16PtrFromString(statePath)
	if err != nil {
		t.Fatal(err)
	}
	h, err := syscall.CreateFile(ptr, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, applyErr := u.apply(context.Background())
	syscall.CloseHandle(h)
	if applyErr == nil {
		t.Fatal("activation commit succeeded despite denied delete sharing")
	}
	after, _ := os.ReadFile(statePath)
	if !bytes.Equal(before, after) {
		t.Fatal("failed atomic replacement altered old state")
	}
	current, _ := readState(u.root)
	if current.SelectedReleaseID != initial.SelectedReleaseID {
		t.Fatal("failed commit selected new release")
	}
	id := releaseID(2, s.p.Artifacts[0].SHA256)
	if _, err := os.Stat(filepath.Join(u.root, "versions", id)); err != nil {
		t.Fatal("expected verified unreferenced version", err)
	}
	if _, err := u.apply(context.Background()); err != nil {
		t.Fatal("retry did not reuse verified orphan", err)
	}
}
func TestSameSequenceConflictAndInvalidBundle(t *testing.T) {
	keys, priv := testKeys(t)
	s, u := testServer(t, keys)
	initial := initializeSmall(t, u, s, priv)
	p := testPayload()
	p.Version = "9.0.0"
	b, _ := smallPackage(t, p)
	s.set(t, p, b, priv)
	if _, err := u.apply(context.Background()); err == nil {
		t.Fatal("same sequence conflict accepted")
	}
	if err := u.initialize(context.Background(), "normal", s.manifest, writeArchive(t, b)); err == nil {
		t.Fatal("bundle bypassed monotonic history")
	}
	badRoot := t.TempDir()
	other := *u
	other.root = badRoot
	if err := other.initialize(context.Background(), "normal", []byte(`{}`), writeArchive(t, b)); err == nil {
		t.Fatal("unsigned initialization accepted")
	}
	state, err := readState(u.root)
	if err != nil || state.SelectedReleaseID != initial.SelectedReleaseID {
		t.Fatal("bad bundle changed state", err)
	}
}
