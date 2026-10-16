//go:build windows

package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func automaticFixture(t *testing.T) (*releaseServer, *updater, ed25519.PrivateKey, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	keys, priv := testKeys(t)
	s, u := testServer(t, keys)
	initializeSmall(t, u, s, priv)
	nextSmall(t, s, priv, 2)
	c, err := readConnection(u.root)
	if err != nil {
		t.Fatal(err)
	}
	c.AutomaticCheck = true
	writeAutomaticConnection(t, u.root, c)
	manifests, archives := &atomic.Int32{}, &atomic.Int32{}
	handler := s.server.Config.Handler
	s.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest" {
			manifests.Add(1)
		} else {
			archives.Add(1)
		}
		handler.ServeHTTP(w, r)
	})
	return s, u, priv, manifests, archives
}

func writeAutomaticConnection(t *testing.T, root string, c connection) {
	t.Helper()
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "connection.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
}

func waitAutomatic(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("automatic check did not reach expected HTTP boundary")
	}
}

func automaticCacheBytes(t *testing.T, u *updater) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(u.root, "state", "update-check.json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAutomaticSignedCheckBackoffNoticeAndManualIndependence(t *testing.T) {
	_, u, _, manifests, archives := automaticFixture(t)
	statePath := filepath.Join(u.root, "state", "activation.json")
	before, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	// Automatic checks never acquire the manual mutation lock, even for HTTP.
	manual, err := acquireLock(u.root)
	if err != nil {
		t.Fatal(err)
	}
	defer manual.close()
	if err := u.automaticCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	if notice := u.automaticNotice(); notice != "Cudia update available. Run cudia update to install." {
		t.Fatal("missing verified local notice", notice)
	}
	cache := automaticCacheBytes(t, u)
	if err := u.automaticCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	if manifests.Load() != 1 || archives.Load() != 0 || !bytes.Equal(cache, automaticCacheBytes(t, u)) {
		t.Fatal("automatic check downloaded an archive or ignored backoff")
	}
	if _, _, available, err := u.check(context.Background()); err != nil || !available || manifests.Load() != 2 {
		t.Fatal("manual check was affected by automatic backoff", err)
	}
	after, err := os.ReadFile(statePath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("automatic check mutated activation", err)
	}
	owned, ok := automaticCacheMetadata(u.root)
	if !ok || owned.Record.Size != int64(len(cache)) || owned.Record.SHA256 != digest(cache) {
		t.Fatal("owned cache snapshot mismatch")
	}
}

func TestAutomaticWorkersUseProtectedImmediateMutex(t *testing.T) {
	s, u, _, manifests, _ := automaticFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	handler := s.server.Config.Handler
	s.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		handler.ServeHTTP(w, r)
	})
	first := u.startAutomaticCheck()
	defer first()
	waitAutomatic(t, entered)
	second := u.startAutomaticCheck()
	secondDone := make(chan struct{})
	go func() { second(); close(secondDone) }()
	waitAutomatic(t, secondDone)
	// Exercise the actual named mutex, rather than a process-local test gate.
	key, err := automaticMutexKey(u.root)
	if err != nil {
		t.Fatal(err)
	}
	if err := withRegistrationLock(key, func() error { t.Error("busy automatic mutex was acquired"); return nil }); err == nil {
		t.Fatal("automatic mutex did not exclude an independent acquisition")
	}
	close(release)
	// Do not cancel the first worker until it has durably completed its check.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(u.root, "state", "update-check.json")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first worker did not write its result")
		}
		time.Sleep(5 * time.Millisecond)
	}
	first()
	if manifests.Load() != 1 {
		t.Fatal("concurrent launchers performed multiple HTTP checks", manifests.Load())
	}
}

func TestAutomaticCancellationJoinsBeforeLifetimeReleaseWithoutStamp(t *testing.T) {
	s, u, _, _, _ := automaticFixture(t)
	entered, canceled := make(chan struct{}), make(chan struct{})
	s.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(canceled)
	})
	lease, err := acquireLifetime(u.root, false)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.close()
	stop := u.startAutomaticCheck()
	waitAutomatic(t, entered)
	if exclusive, err := acquireLifetime(u.root, true); err == nil {
		exclusive.close()
		t.Fatal("worker's launcher lifetime was not retained")
	}
	start := time.Now()
	stop()
	if time.Since(start) > 2*time.Second {
		t.Fatal("engine exit waited on the 15 second HTTP timeout")
	}
	waitAutomatic(t, canceled)
	if _, err := os.Stat(filepath.Join(u.root, "state", "update-check.json")); !os.IsNotExist(err) {
		t.Fatal("canceled check wrote a success/failure backoff stamp", err)
	}
	lease.close()
	exclusive, err := acquireLifetime(u.root, true)
	if err != nil {
		t.Fatal("joined worker kept installation alive", err)
	}
	exclusive.close()
}

func TestAutomaticActualFailureBackoffAndClockRollback(t *testing.T) {
	s, u, _, manifests, _ := automaticFixture(t)
	c, _ := readConnection(u.root)
	c.CheckIntervalHours = 1
	writeAutomaticConnection(t, u.root, c)
	s.mu.Lock()
	s.mode = "manifest oversized"
	s.mu.Unlock()
	clock := time.Now().UTC()
	u.now = func() time.Time { return clock }
	if err := u.automaticCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	cache, err := parseAutomaticCache(automaticCacheBytes(t, u), u.root)
	if err != nil || cache.Result != "failed" || len(cache.Envelope) != 0 || u.automaticNotice() != "" {
		t.Fatal("failure cache leaked untrusted source or notice", err)
	}
	clock = clock.Add(23 * time.Hour)
	if err := u.automaticCheck(context.Background()); err != nil || manifests.Load() != 1 {
		t.Fatal("failure did not back off", err)
	}
	clock = clock.Add(time.Hour)
	if err := u.automaticCheck(context.Background()); err != nil || manifests.Load() != 2 {
		t.Fatal("failure retry did not resume at interval", err)
	}
	clock = clock.Add(-48 * time.Hour)
	if err := u.automaticCheck(context.Background()); err != nil || manifests.Load() != 3 {
		t.Fatal("future timestamp postponed checking after clock rollback", err)
	}
}

func TestAutomaticRejectsSignedVariantAndSequenceMismatch(t *testing.T) {
	for _, mode := range []string{"variant", "sequence"} {
		t.Run(mode, func(t *testing.T) {
			s, u, priv, manifests, archives := automaticFixture(t)
			if mode == "variant" {
				s.mu.Lock()
				p := s.p
				p.Artifacts = append([]artifact{}, p.Artifacts...)
				p.Artifacts[0].Variant = "baseline"
				s.manifest = signPayload(t, p, priv)
				s.mu.Unlock()
			} else {
				state, _ := readState(u.root)
				state.HighestSequence = 3
				if err := writeState(u.root, state); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(filepath.Join(u.root, "state", "activation.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := u.automaticCheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			cache, err := parseAutomaticCache(automaticCacheBytes(t, u), u.root)
			if err != nil || cache.Result != "failed" || len(cache.Envelope) != 0 || u.automaticNotice() != "" || manifests.Load() != 1 || archives.Load() != 0 {
				t.Fatal("automatic check accepted an incompatible signed manifest", err)
			}
			after, err := os.ReadFile(filepath.Join(u.root, "state", "activation.json"))
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("rejected automatic check modified activation", err)
			}
		})
	}
}

func TestAutomaticObsoleteInflightResultIsDiscarded(t *testing.T) {
	for _, change := range []string{"connection", "activation", "trust"} {
		t.Run(change, func(t *testing.T) {
			s, u, _, _, _ := automaticFixture(t)
			entered, release := make(chan struct{}), make(chan struct{})
			handler := s.server.Config.Handler
			s.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				<-release
				handler.ServeHTTP(w, r)
			})
			done := make(chan error, 1)
			go func() { done <- u.automaticCheck(context.Background()) }()
			waitAutomatic(t, entered)
			switch change {
			case "connection":
				c, _ := readConnection(u.root)
				c.CheckIntervalHours++
				writeAutomaticConnection(t, u.root, c)
			case "activation":
				state, _ := readState(u.root)
				state.HighestSequence++
				if err := writeState(u.root, state); err != nil {
					t.Fatal(err)
				}
			case "trust":
				// Mutate only once the HTTP handler has started; fetch subsequently
				// observes this replacement while verifying the returned envelope.
				u.keys = map[string]ed25519.PublicKey{}
			}
			close(release)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(u.root, "state", "update-check.json")); !os.IsNotExist(err) {
				t.Fatal("obsolete result changed cache", err)
			}
		})
	}
}

func TestAutomaticNoticeReverifiesSignedSourceAndCurrentPolicy(t *testing.T) {
	for _, change := range []string{"unsigned", "tampered", "expired", "connection", "activation", "trust", "disabled", "future"} {
		t.Run(change, func(t *testing.T) {
			_, u, _, _, _ := automaticFixture(t)
			if err := u.automaticCheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			cache, err := parseAutomaticCache(automaticCacheBytes(t, u), u.root)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "unsigned":
				cache.Envelope = []byte(`{"version":"999.0.0"}`)
			case "tampered":
				cache.Envelope[len(cache.Envelope)/2] ^= 1
			case "expired":
				now := u.now().Add(31 * 24 * time.Hour)
				u.now = func() time.Time { return now }
			case "connection", "disabled":
				c, _ := readConnection(u.root)
				if change == "disabled" {
					c.AutomaticCheck = false
				} else {
					c.CheckIntervalHours++
				}
				writeAutomaticConnection(t, u.root, c)
			case "activation":
				state, _ := readState(u.root)
				state.HighestSequence++
				if err := writeState(u.root, state); err != nil {
					t.Fatal(err)
				}
			case "trust":
				u.keys = map[string]ed25519.PublicKey{"replacement": make(ed25519.PublicKey, ed25519.PublicKeySize)}
			case "future":
				cache.CheckedAt = u.now().Add(100 * 365 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
			}
			b, _ := json.Marshal(cache)
			if err := os.WriteFile(filepath.Join(u.root, "state", "update-check.json"), b, 0600); err != nil {
				t.Fatal(err)
			}
			if u.automaticNotice() != "" {
				t.Fatal("unverified/stale cached notice was displayed")
			}
			if change == "expired" {
				if _, ok := automaticCacheMetadata(u.root); !ok {
					t.Fatal("expired signed source lost structural cleanup ownership")
				}
			}
		})
	}
}

func TestAutomaticMalformedOrAliasedCachePreservedAndSuspends(t *testing.T) {
	for _, change := range []string{"unknown", "duplicate", "null", "type", "array-envelope", "wrong-root", "oversized", "hardlink", "directory", "junction"} {
		t.Run(change, func(t *testing.T) {
			_, u, _, manifests, _ := automaticFixture(t)
			_, _, binding, _ := u.automaticBinding()
			root, _ := automaticRoot(u.root)
			b, _ := json.Marshal(automaticCache{1, root, binding, u.now().UTC().Format(time.RFC3339Nano), "failed", []byte{}})
			switch change {
			case "unknown":
				b = bytes.Replace(b, []byte(`"schema":1`), []byte(`"schema":1,"future":true`), 1)
			case "duplicate":
				b = bytes.Replace(b, []byte(`"schema":1`), []byte(`"schema":1,"schema":1`), 1)
			case "null":
				b = bytes.Replace(b, []byte(`"envelope":""`), []byte(`"envelope":null`), 1)
			case "type":
				b = bytes.Replace(b, []byte(`"schema":1`), []byte(`"schema":"1"`), 1)
			case "array-envelope":
				b = bytes.Replace(b, []byte(`"envelope":""`), []byte(`"envelope":[]`), 1)
			case "wrong-root":
				b = bytes.Replace(b, []byte(`"root":`), []byte(`"Root":`), 1)
			case "oversized":
				b = bytes.Repeat([]byte("x"), maxAutomaticCache+1)
			}
			path := filepath.Join(u.root, "state", "update-check.json")
			if change == "junction" {
				target := t.TempDir()
				command := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "mklink", "/J", path, target)
				if out, err := command.CombinedOutput(); err != nil {
					t.Fatalf("owned test junction: %s %v", out, err)
				}
				t.Cleanup(func() { _ = os.Remove(path) })
			} else if change == "directory" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(path, b, 0600); err != nil {
					t.Fatal(err)
				}
				if change == "hardlink" {
					if err := os.Link(path, filepath.Join(u.root, "cache-alias")); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := u.automaticCheck(context.Background()); err == nil {
				t.Fatal("uncertain cache did not suspend checks")
			}
			if manifests.Load() != 0 || u.automaticNotice() != "" {
				t.Fatal("uncertain cache triggered network or a notice")
			}
			if _, ok := automaticCacheMetadata(u.root); ok {
				t.Fatal("uncertain cache was adopted for cleanup")
			}
			if change != "directory" && change != "junction" {
				after, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(b, after) {
					t.Fatal("uncertain cache changed", err)
				}
			}
		})
	}
}

func TestAutomaticCacheReplacementRequiresSameRetainedIdentity(t *testing.T) {
	_, u, _, _, _ := automaticFixture(t)
	if err := u.automaticCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := readAutomaticCache(u.root)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.close()
	path := filepath.Join(u.root, "state", "update-check.json")
	if err := os.Rename(path, path+".preserved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, snapshot.bytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeAutomaticCache(u.root, snapshot, snapshot.cache); err == nil {
		t.Fatal("same bytes with different file identity were replaced")
	}
	entries, err := os.ReadDir(filepath.Join(u.root, "state"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".update-check-") {
			t.Fatal("owned temporary cache was left behind")
		}
	}
}

func TestAutomaticCacheAtomicFailurePreservesTarget(t *testing.T) {
	for _, mode := range []string{"initial-winner", "rename-blocked", "changed-content"} {
		t.Run(mode, func(t *testing.T) {
			_, u, _, _, _ := automaticFixture(t)
			_, _, binding, _ := u.automaticBinding()
			root, _ := automaticRoot(u.root)
			cache := automaticCache{1, root, binding, u.now().UTC().Format(time.RFC3339Nano), "failed", []byte{}}
			path := filepath.Join(u.root, "state", "update-check.json")
			var snapshot *automaticSnapshot
			var want []byte
			if mode == "initial-winner" {
				// Another writer wins after the worker observed an absent cache.
				want = []byte("preserve the independently created winner")
				if err := os.WriteFile(path, want, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := writeAutomaticCache(u.root, nil, cache); err != nil {
					t.Fatal(err)
				}
				var err error
				snapshot, err = readAutomaticCache(u.root)
				if err != nil {
					t.Fatal(err)
				}
				defer snapshot.close()
				want = append([]byte{}, snapshot.bytes...)
				if mode == "rename-blocked" {
					// This ordinary Windows reader does not share DELETE. Reads and
					// final validation succeed; MoveFileEx replacement itself fails.
					blocker, err := os.Open(path)
					if err != nil {
						t.Fatal(err)
					}
					defer blocker.Close()
				} else {
					// The held snapshot normally excludes writes. Release it here
					// to exercise the independent final hash/bytes validation.
					if err := snapshot.close(); err != nil {
						t.Fatal(err)
					}
					cache.CheckedAt = u.now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
					want, _ = json.Marshal(cache)
					if err := os.WriteFile(path, want, 0600); err != nil {
						t.Fatal(err)
					}
					id, err := wizardFileIdentity(path)
					if err != nil || id != snapshot.metadata.ID {
						t.Fatal("content-change fixture did not retain the original file identity", err)
					}
				}
			}
			if err := writeAutomaticCache(u.root, snapshot, cache); err == nil {
				t.Fatal("cache replaced an independently changed or unavailable target")
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(want, after) {
				t.Fatal("failed cache commit changed target", err)
			}
			entries, err := os.ReadDir(filepath.Dir(path))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".update-check-") {
					t.Fatal("failed cache commit left its owned nonce temporary")
				}
			}
		})
	}
}

func TestAutomaticTrustFingerprintDeterministicAndIncludesBytes(t *testing.T) {
	_, u, _, _, _ := automaticFixture(t)
	first := make(ed25519.PublicKey, ed25519.PublicKeySize)
	second := make(ed25519.PublicKey, ed25519.PublicKeySize)
	second[0] = 1
	u.keys = map[string]ed25519.PublicKey{"a": first, "b": second}
	_, _, original, err := u.automaticBinding()
	if err != nil {
		t.Fatal(err)
	}
	u.keys = map[string]ed25519.PublicKey{"b": second, "a": first}
	_, _, reordered, err := u.automaticBinding()
	if err != nil || reordered != original {
		t.Fatal("trust map iteration changed fingerprint", err)
	}
	u.keys = map[string]ed25519.PublicKey{"a": second, "b": first}
	_, _, changed, err := u.automaticBinding()
	if err != nil || changed == original {
		t.Fatal("trust fingerprint omitted key bytes", err)
	}
	key, err := automaticMutexKey(u.root)
	if err != nil {
		t.Fatal(err)
	}
	upper, err := automaticMutexKey(strings.ToUpper(u.root))
	if err != nil || upper != key {
		t.Fatal("root casing changed automatic mutex identity", err)
	}
}

func TestAutomaticNoKeysOrDisabledPolicyNeverConnect(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		_, u, _, manifests, _ := automaticFixture(t)
		if disabled {
			c, _ := readConnection(u.root)
			c.AutomaticCheck = false
			writeAutomaticConnection(t, u.root, c)
		} else {
			u.keys = nil
		}
		if err := u.automaticCheck(context.Background()); err != nil {
			t.Fatal(err)
		}
		if manifests.Load() != 0 || u.automaticNotice() != "" {
			t.Fatal("disabled checks performed network activity or notice")
		}
	}
}

func TestAutomaticInteractiveArgumentRecognition(t *testing.T) {
	project := t.TempDir()
	for _, args := range [][]string{nil, {project}, {"--prompt", "hello"}, {"--model=provider/model", "-c"}, {"--mini", "--no-replay", "--replay-limit", "5", project}, {"--session", "session", "--fork"}, {"--hostname=localhost", "--port=0", "--mdns=false"}, {"--pure", "--print-logs", "--log-level=INFO"}, {"--"}} {
		if !automaticInteractiveArgs(args) {
			t.Error("supported interactive invocation was missed", args)
		}
	}
	for _, args := range [][]string{{"--version"}, {"-v"}, {"--help"}, {"-h"}, {"run", "--prompt", "hello"}, {"installation", "info"}, {"unknown-command"}, {"--unknown"}, {"--prompt"}, {"--mini", "--mdns=false"}, {"--mini", "--no-mdns"}, {"--mini", "--port=0", "--"}, {"--replay"}, {"--replay=false"}, {"--mini", "--no-mini", "--demo"}, {"--demo"}, {"--fork"}, {"--replay-limit=abc"}, {"--port=invalid"}, {"--log-level=oops"}, {"-model", "x"}, {"--", "run"}, {project, project}} {
		if automaticInteractiveArgs(args) {
			t.Error("noninteractive/unsupported invocation triggered checks", args)
		}
	}
}
