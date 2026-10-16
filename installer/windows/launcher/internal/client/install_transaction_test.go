package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func installTestBundle(t *testing.T, u *updater, priv ed25519.PrivateKey, p payload) ([]byte, string, string) {
	t.Helper()
	b, _ := smallPackage(t, p)
	p.Artifacts[0].Size = int64(len(b))
	p.Artifacts[0].SHA256 = digest(b)
	bootstrap := filepath.Join(t.TempDir(), "bootstrap.exe")
	if err := os.WriteFile(bootstrap, testPE(t), 0600); err != nil {
		t.Fatal(err)
	}
	return signPayload(t, p, priv), writeArchive(t, b), bootstrap
}
func installTestPrepare(t *testing.T, u *updater, priv ed25519.PrivateKey, p payload) (installTicket, string) {
	t.Helper()
	e, a, b := installTestBundle(t, u, priv, p)
	ticket, err := u.prepareInstall(context.Background(), "normal", p.Channel, e, a, b)
	if err != nil {
		t.Fatal(err)
	}
	return ticket, b
}
func installTestBootstrap(t *testing.T, u *updater, source string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(u.root, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(u.root, "bin", "cudia.exe"), b, 0600); err != nil {
		t.Fatal(err)
	}
}
func installTestFresh(t *testing.T) (*updater, ed25519.PrivateKey) {
	t.Helper()
	keys, priv := testKeys(t)
	return &updater{root: t.TempDir(), keys: keys, now: time.Now}, priv
}
func installTestNoActivation(t *testing.T, u *updater) {
	t.Helper()
	for _, p := range []string{"state/activation.json", "connection.json", "bin/cudia.exe"} {
		if _, err := os.Stat(filepath.Join(u.root, filepath.FromSlash(p))); !os.IsNotExist(err) {
			t.Fatalf("prepare changed active path %s: %v", p, err)
		}
	}
}
func TestPreparedInstallFreshAndRecoveredCommit(t *testing.T) {
	u, priv := installTestFresh(t)
	p := testPayload()
	p.Channel = "preview"
	ticket, bootstrap := installTestPrepare(t, u, priv, p)
	installTestNoActivation(t, u)
	if _, _, err := func() (installTicket, string, error) {
		e, a, b := installTestBundle(t, u, priv, p)
		v, err := u.prepareInstall(context.Background(), "normal", p.Channel, e, a, b)
		return v, b, err
	}(); err == nil {
		t.Fatal("pending wizard did not block another preparation")
	}
	installTestBootstrap(t, u, bootstrap)
	restarted := *u
	if err := restarted.commitPreparedInstall(context.Background(), ticket.Ticket); err != nil {
		t.Fatal(err)
	}
	s, err := readState(u.root)
	if err != nil || s.SelectedReleaseID != ticket.ReleaseID {
		t.Fatal("prepared release not activated", err)
	}
	c, err := readConnection(u.root)
	if err != nil || c.Channel != "preview" || c.ManifestURL != "https://cyara.com.br/updates/v1/preview.json" || !c.AutomaticCheck || c.CheckIntervalHours != 24 {
		t.Fatal("planned preview connection invalid", c, err)
	}
	j, err := u.readInstallPending(ticket.Ticket)
	if err != nil || j.Phase != "committed" {
		t.Fatal("no durable completion marker", err)
	}
	if _, err := os.Stat(filepath.Join(u.root, "state", "staging", j.Stage)); !os.IsNotExist(err) {
		t.Fatal("commit staging cleanup failed", err)
	}
	if err := restarted.commitPreparedInstall(context.Background(), ticket.Ticket); err != nil {
		t.Fatal("committed retry failed", err)
	}
	if err := restarted.abortPreparedInstall(ticket.Ticket); err != nil {
		t.Fatal(err)
	}
	if err := restarted.abortPreparedInstall(ticket.Ticket); err != nil {
		t.Fatal("abort retry failed", err)
	}
	if got, err := readState(u.root); err != nil || got.SelectedReleaseID != ticket.ReleaseID {
		t.Fatal("cleanup undid committed installation", err)
	}
}

func TestPreparedInstallPreservesLegacyAutomaticCheckPolicy(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy-prepared", true: "existing-disabled"}[existing], func(t *testing.T) {
			u, priv := installTestFresh(t)
			legacy := installerConnection("stable", false)
			if existing {
				if err := os.WriteFile(filepath.Join(u.root, "connection.json"), legacy, 0600); err != nil {
					t.Fatal(err)
				}
			}
			ticket, bootstrap := installTestPrepare(t, u, priv, testPayload())
			if !existing {
				j, err := u.readInstallPending(ticket.Ticket)
				if err != nil {
					t.Fatal(err)
				}
				j.PlannedConnection = legacy
				if err := u.writeInstallPending(j, false); err != nil {
					t.Fatal(err)
				}
			}
			installTestBootstrap(t, u, bootstrap)
			if err := u.commitPreparedInstall(context.Background(), ticket.Ticket); err != nil {
				t.Fatal("resume legacy policy", err)
			}
			b, err := os.ReadFile(filepath.Join(u.root, "connection.json"))
			if err != nil || !bytes.Equal(b, legacy) {
				t.Fatal("legacy opt-out was changed", err)
			}
		})
	}
}
func TestPreparedInstallPreservesWorkingActivationOnFailure(t *testing.T) {
	for _, kind := range []string{"bootstrap missing", "bootstrap wrong", "files modified", "archive modified", "envelope modified", "descriptor modified", "extra file", "state changed", "connection changed", "expired", "uninstall pending"} {
		t.Run(kind, func(t *testing.T) {
			keys, priv := testKeys(t)
			server, u := testServer(t, keys)
			initial := initializeSmall(t, u, server, priv)
			p := testPayload()
			p.Sequence = 2
			p.Version = "1.2.4"
			ticket, bootstrap := installTestPrepare(t, u, priv, p)
			installTestBootstrap(t, u, bootstrap)
			statePath := filepath.Join(u.root, "state", "activation.json")
			j, err := u.readInstallPending(ticket.Ticket)
			if err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(u.root, "state", "staging", j.Stage)
			switch kind {
			case "bootstrap missing":
				if err := os.Remove(filepath.Join(u.root, "bin", "cudia.exe")); err != nil {
					t.Fatal(err)
				}
			case "bootstrap wrong":
				if err := os.WriteFile(filepath.Join(u.root, "bin", "cudia.exe"), []byte("wrong"), 0600); err != nil {
					t.Fatal(err)
				}
			case "files modified":
				if err := os.WriteFile(filepath.Join(stage, "files", "defaults", "release.txt"), []byte("bad"), 0600); err != nil {
					t.Fatal(err)
				}
			case "archive modified":
				if err := os.WriteFile(filepath.Join(stage, "archive.zip"), []byte("bad"), 0600); err != nil {
					t.Fatal(err)
				}
			case "envelope modified":
				if err := os.WriteFile(filepath.Join(stage, "release.json"), []byte("bad"), 0600); err != nil {
					t.Fatal(err)
				}
			case "descriptor modified":
				j.Descriptor.Files["defaults/release.txt"] = fileRecord{3, digest([]byte("bad"))}
				if err := u.writeInstallPending(j, false); err != nil {
					t.Fatal(err)
				}
			case "extra file":
				if err := os.WriteFile(filepath.Join(stage, "files", "unexpected.txt"), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			case "state changed":
				b, err := os.ReadFile(statePath)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(statePath, append(b, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			case "connection changed":
				c, err := os.ReadFile(filepath.Join(u.root, "connection.json"))
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(u.root, "connection.json"), append(c, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			case "expired":
				u.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
			case "uninstall pending":
				if err := os.WriteFile(filepath.Join(u.root, "state", "uninstall-pending.json"), []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			if err := u.commitPreparedInstall(context.Background(), ticket.Ticket); err == nil {
				t.Fatal("invalid transaction committed")
			}
			after, err := os.ReadFile(statePath)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("failed installation changed activation", err)
			}
			got, err := readState(u.root)
			if err != nil || got.SelectedReleaseID != initial.SelectedReleaseID {
				t.Fatal("working release lost", err)
			}
		})
	}
}
func TestPreparedInstallRejectsSequenceAndChannel(t *testing.T) {
	keys, priv := testKeys(t)
	server, u := testServer(t, keys)
	initializeSmall(t, u, server, priv)
	p := testPayload()
	p.Version = "9.9.9"
	e, a, b := installTestBundle(t, u, priv, p)
	if _, err := u.prepareInstall(context.Background(), "normal", "stable", e, a, b); err == nil {
		t.Fatal("same-sequence replacement accepted")
	}
	p.Channel = "preview"
	p.Sequence = 2
	e, a, b = installTestBundle(t, u, priv, p)
	if _, err := u.prepareInstall(context.Background(), "normal", "preview", e, a, b); err == nil {
		t.Fatal("existing channel silently replaced")
	}
}
func TestPreparedInstallAbortPreservesUnknownFiles(t *testing.T) {
	u, priv := installTestFresh(t)
	ticket, _ := installTestPrepare(t, u, priv, testPayload())
	j, err := u.readInstallPending(ticket.Ticket)
	if err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(u.root, "state", "staging", j.Stage, "user.txt")
	if err := os.WriteFile(unknown, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(u.root, "user-data.txt")
	if err := os.WriteFile(outside, []byte("keep too"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := u.abortPreparedInstall(ticket.Ticket); err == nil {
		t.Fatal("unknown staging file silently deleted")
	}
	for _, p := range []string{unknown, outside} {
		if _, err := os.Stat(p); err != nil {
			t.Fatal("unknown file lost", err)
		}
	}
	installTestNoActivation(t, u)
	if err := os.Remove(unknown); err != nil {
		t.Fatal(err)
	}
	if err := u.abortPreparedInstall(ticket.Ticket); err != nil {
		t.Fatal(err)
	}
}
func TestPreparedInstallCrashAfterConnectionAndActivation(t *testing.T) {
	for _, activated := range []bool{false, true} {
		t.Run(map[bool]string{false: "connection", true: "activation"}[activated], func(t *testing.T) {
			u, priv := installTestFresh(t)
			ticket, bootstrap := installTestPrepare(t, u, priv, testPayload())
			installTestBootstrap(t, u, bootstrap)
			j, err := u.readInstallPending(ticket.Ticket)
			if err != nil {
				t.Fatal(err)
			}
			j.Phase = "committing"
			if err := u.writeInstallPending(j, false); err != nil {
				t.Fatal(err)
			}
			if err := installWriteAtomicNew(filepath.Join(u.root, "connection.json"), j.PlannedConnection); err != nil {
				t.Fatal(err)
			}
			if activated {
				p, err := verifyEnvelope(j.Envelope, u.keys, j.Channel, u.now())
				if err != nil {
					t.Fatal(err)
				}
				a, err := archiveFor(p, j.Variant)
				if err != nil {
					t.Fatal(err)
				}
				if err := promote(filepath.Join(u.root, "state", "staging", j.Stage, "files"), filepath.Join(u.root, "versions", ticket.ReleaseID)); err != nil {
					t.Fatal(err)
				}
				s, err := u.installNextState(j, p, a)
				if err != nil {
					t.Fatal(err)
				}
				if err := writeState(u.root, s); err != nil {
					t.Fatal(err)
				}
			}
			restarted := *u
			if err := restarted.commitPreparedInstall(context.Background(), ticket.Ticket); err != nil {
				t.Fatal("interrupted transaction recovery failed", err)
			}
			if s, err := readState(u.root); err != nil || s.SelectedReleaseID != ticket.ReleaseID {
				t.Fatal("recovery selected wrong release", err)
			}
		})
	}
}
func TestPreparedInstallStrictJournalAndBadTicket(t *testing.T) {
	for _, kind := range []string{"unknown", "duplicate", "nested unknown", "ticket"} {
		t.Run(kind, func(t *testing.T) {
			u, priv := installTestFresh(t)
			ticket, _ := installTestPrepare(t, u, priv, testPayload())
			path := filepath.Join(u.root, "state", "install-pending.json")
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "unknown":
				b = append([]byte(`{"unknown":1,`), b[1:]...)
			case "duplicate":
				b = append([]byte(`{"schema":1,`), b[1:]...)
			case "nested unknown":
				var raw map[string]json.RawMessage
				if err := json.Unmarshal(b, &raw); err != nil {
					t.Fatal(err)
				}
				raw["bootstrap"] = append([]byte(`{"unknown":1,`), raw["bootstrap"][1:]...)
				b, err = json.Marshal(raw)
				if err != nil {
					t.Fatal(err)
				}
			case "ticket":
				ticket.Ticket = "../bad"
			}
			if err := os.WriteFile(path, b, 0600); err != nil {
				t.Fatal(err)
			}
			if err := u.commitPreparedInstall(context.Background(), ticket.Ticket); err == nil {
				t.Fatal("invalid journal/ticket accepted")
			}
			installTestNoActivation(t, u)
		})
	}
}

func TestPreparedInstallExistingBootstrapPreflight(t *testing.T) {
	for _, matching := range []bool{false, true} {
		t.Run(map[bool]string{false: "mismatch", true: "matching repair"}[matching], func(t *testing.T) {
			keys, priv := testKeys(t)
			server, u := testServer(t, keys)
			initializeSmall(t, u, server, priv)
			p := testPayload()
			p.Sequence = 2
			p.Version = "1.2.4"
			e, a, bootstrap := installTestBundle(t, u, priv, p)
			installTestBootstrap(t, u, bootstrap)
			if !matching {
				if err := os.WriteFile(filepath.Join(u.root, "bin", "cudia.exe"), []byte("different bootstrap"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			statePath := filepath.Join(u.root, "state", "activation.json")
			before, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			ticket, err := u.prepareInstall(context.Background(), "normal", "stable", e, a, bootstrap)
			if matching {
				if err != nil {
					t.Fatal("matching bootstrap repair rejected", err)
				}
				if err := u.abortPreparedInstall(ticket.Ticket); err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					t.Fatal("bootstrap mismatch passed wizard preflight")
				}
				if _, err := os.Stat(filepath.Join(u.root, "state", "install-pending.json")); !os.IsNotExist(err) {
					t.Fatal("failed bootstrap preflight left pending journal", err)
				}
			}
			after, err := os.ReadFile(statePath)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("bootstrap preflight changed working activation", err)
			}
		})
	}
}
