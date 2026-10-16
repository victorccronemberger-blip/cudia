//go:build windows

package client

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWizardIntentCrashRerunRecoversWithoutTicket(t *testing.T) {
	for _, existing := range []bool{false, true} {
		for _, point := range []string{"wizard-intent-persisted", "wizard-internal-prepared", "wizard-journal-persisted"} {
			name := "fresh/" + point
			if existing {
				name = "existing/" + point
			}
			t.Run(name, func(t *testing.T) {
				w, priv := wizardTest(t)
				p := testPayload()
				if existing {
					wizardInstallTest(t, w, priv)
					p.Sequence = 2
					p.Version = "1.2.4"
				}
				userData := filepath.Join(w.u.root, "session-and-credentials.txt")
				if err := os.WriteFile(userData, []byte("preserve personal data"), 0600); err != nil {
					t.Fatal(err)
				}
				activation := filepath.Join(w.u.root, "state", "activation.json")
				before, err := installReadOptional(activation, maxStateBytes)
				if err != nil {
					t.Fatal(err)
				}
				envelope, archive, bootstrap := installTestBundle(t, w.u, priv, p)
				reached := false
				w.fail = func(name string) error {
					if name == point {
						reached = true
						return errors.New("simulated death without normal defer cleanup")
					}
					return nil
				}
				if _, err = w.prepare(context.Background(), "normal", p.Channel, envelope, archive, bootstrap, true); err == nil || !reached {
					t.Fatalf("did not reach crash boundary: %v", err)
				}
				intent, err := w.readIntent()
				if err != nil {
					t.Fatal("durable intent missing", err)
				}
				prepared, preparedErr := w.u.readInstallPending("")
				if point == "wizard-intent-persisted" {
					if !os.IsNotExist(preparedErr) {
						t.Fatal("internal prepare ran before injected crash", preparedErr)
					}
				} else if preparedErr != nil || prepared.Ticket != intent.Ticket {
					t.Fatal("internal prepared journal not retained after simulated death", preparedErr)
				}
				if point == "wizard-internal-prepared" {
					if _, err = w.readPending(""); !os.IsNotExist(err) {
						t.Fatal("coordinator journal unexpectedly existed", err)
					}
				}
				after, err := installReadOptional(activation, maxStateBytes)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("preparation changed active release", err)
				}
				restarted := w
				restarted.fail = nil
				next, err := restarted.prepare(context.Background(), "normal", p.Channel, envelope, archive, bootstrap, true)
				if err != nil {
					t.Fatal("ordinary rerun without old ticket", err)
				}
				if next.Ticket == intent.Ticket {
					t.Fatal("recovery reused the abandoned ticket")
				}
				if _, err = restarted.readIntent(); !os.IsNotExist(err) {
					t.Fatal("intent survived complete preparation", err)
				}
				after, err = installReadOptional(activation, maxStateBytes)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("recovery changed established activation", err)
				}
				if data, err := os.ReadFile(userData); err != nil || string(data) != "preserve personal data" {
					t.Fatal("recovery changed personal data", err)
				}
				if err = restarted.finalize(context.Background(), next.Ticket); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
func TestWizardIntentPreservesUnrelatedManualPending(t *testing.T) {
	w, priv := wizardTest(t)
	envelope, archive, bootstrap := installTestBundle(t, w.u, priv, testPayload())
	ticket, err := w.u.prepareInstall(context.Background(), "normal", "stable", envelope, archive, bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(w.u.root, "state", "install-pending.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.prepare(context.Background(), "normal", "stable", envelope, archive, bootstrap, true); err == nil {
		t.Fatal("manual prepare was adopted")
	}
	if after, err := os.ReadFile(path); err != nil || !bytes.Equal(before, after) {
		t.Fatal("manual pending journal changed", err)
	}
	if _, err = w.readIntent(); !os.IsNotExist(err) {
		t.Fatal("wizard intent was created over a manual transaction", err)
	}
	if _, err = w.u.readInstallPending(ticket.Ticket); err != nil {
		t.Fatal("manual ticket lost", err)
	}
}
func TestWizardIntentMismatchAndCommittedPendingArePreserved(t *testing.T) {
	for _, kind := range []string{"different ticket", "different envelope", "different bootstrap", "changed connection", "committed"} {
		t.Run(kind, func(t *testing.T) {
			w, priv := wizardTest(t)
			envelope, archive, bootstrap := installTestBundle(t, w.u, priv, testPayload())
			w.fail = func(name string) error {
				if name == "wizard-internal-prepared" {
					return errors.New("crash")
				}
				return nil
			}
			if _, err := w.prepare(context.Background(), "normal", "stable", envelope, archive, bootstrap, true); err == nil {
				t.Fatal("no crash")
			}
			w.fail = nil
			p, err := w.u.readInstallPending("")
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "different ticket":
				p.Ticket = strings.Repeat("a", 64)
				p.Stage = "install-" + p.Ticket
			case "different envelope":
				p.Envelope = append(p.Envelope, ' ')
			case "different bootstrap":
				p.Bootstrap.SHA256 = strings.Repeat("b", 64)
			case "changed connection":
				if err = os.WriteFile(filepath.Join(w.u.root, "connection.json"), []byte("user edited connection"), 0600); err != nil {
					t.Fatal(err)
				}
			case "committed":
				intentBytes, err := os.ReadFile(filepath.Join(w.u.root, "state", "wizard-intent.json"))
				if err != nil {
					t.Fatal(err)
				}
				if err = w.removeIntent(); err != nil {
					t.Fatal(err)
				}
				installTestBootstrap(t, w.u, bootstrap)
				if err = w.u.commitPreparedInstall(context.Background(), p.Ticket); err != nil {
					t.Fatal(err)
				}
				if err = installWriteAtomicNew(filepath.Join(w.u.root, "state", "wizard-intent.json"), intentBytes); err != nil {
					t.Fatal(err)
				}
				p, err = w.u.readInstallPending("")
				if err != nil {
					t.Fatal(err)
				}
			}
			if kind != "committed" {
				if err = w.u.writeInstallPending(p, false); err != nil {
					t.Fatal(err)
				}
			}
			pendingPath := filepath.Join(w.u.root, "state", "install-pending.json")
			intentPath := filepath.Join(w.u.root, "state", "wizard-intent.json")
			pendingBefore, err := os.ReadFile(pendingPath)
			if err != nil {
				t.Fatal(err)
			}
			intentBefore, err := os.ReadFile(intentPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = w.prepare(context.Background(), "normal", "stable", envelope, archive, bootstrap, true); err == nil {
				t.Fatal("mismatched/committed transaction adopted")
			}
			if after, err := os.ReadFile(pendingPath); err != nil || !bytes.Equal(after, pendingBefore) {
				t.Fatal("pending transaction changed", err)
			}
			if after, err := os.ReadFile(intentPath); err != nil || !bytes.Equal(after, intentBefore) {
				t.Fatal("intent evidence changed", err)
			}
		})
	}
}
func TestWizardCompletedReceiptCleansOnlyMatchingStaleIntent(t *testing.T) {
	w, priv := wizardTest(t)
	envelope, archive, bootstrap := installTestBundle(t, w.u, priv, testPayload())
	w.fail = func(name string) error {
		if name == "wizard-journal-persisted" {
			return errors.New("crash before intent cleanup")
		}
		return nil
	}
	prepared, err := w.prepare(context.Background(), "normal", "stable", envelope, archive, bootstrap, true)
	if err == nil {
		t.Fatal("no interruption")
	}
	w.fail = nil
	intentBytes, err := os.ReadFile(filepath.Join(w.u.root, "state", "wizard-intent.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = w.finalize(context.Background(), prepared.Ticket); err != nil {
		t.Fatal("finalize complete coordinator journal with retained intent", err)
	}
	if err = installWriteAtomicNew(filepath.Join(w.u.root, "state", "wizard-intent.json"), intentBytes); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(w.u.root, "state", "activation.json"))
	if err != nil {
		t.Fatal(err)
	}
	next, err := w.prepare(context.Background(), "normal", "stable", envelope, archive, bootstrap, false)
	if err != nil {
		t.Fatal("stale completed intent", err)
	}
	if after, err := os.ReadFile(filepath.Join(w.u.root, "state", "activation.json")); err != nil || !bytes.Equal(before, after) {
		t.Fatal("completed intent recovery altered activation", err)
	}
	if err = w.abort(context.Background(), next.Ticket); err != nil {
		t.Fatal(err)
	}
}
func TestWizardIntentBlocksLowLevelAndLegacyRemoval(t *testing.T) {
	w, priv := wizardTest(t)
	envelope, archive, bootstrap := installTestBundle(t, w.u, priv, testPayload())
	w.fail = func(name string) error {
		if name == "wizard-intent-persisted" {
			return errors.New("crash")
		}
		return nil
	}
	if _, err := w.prepare(context.Background(), "normal", "stable", envelope, archive, bootstrap, true); err == nil {
		t.Fatal("no crash")
	}
	w.fail = nil
	intent, err := w.readIntent()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.u.prepareInstall(context.Background(), "normal", "stable", envelope, archive, bootstrap); err == nil {
		t.Fatal("public prepare ignored intent")
	}
	if err = w.u.commitPreparedInstall(context.Background(), intent.Ticket); err == nil {
		t.Fatal("public commit ignored intent")
	}
	if err = w.u.abortPreparedInstall(intent.Ticket); err == nil {
		t.Fatal("public abort ignored intent")
	}
	if err = preflightUninstall(w.u.root); err == nil {
		t.Fatal("legacy preflight ignored intent")
	}
	if err = removeOwnedFiles(w.u.root); err == nil {
		t.Fatal("legacy removal ignored intent")
	}
	if _, err = w.readIntent(); err != nil {
		t.Fatal("guard removed intent", err)
	}
}
