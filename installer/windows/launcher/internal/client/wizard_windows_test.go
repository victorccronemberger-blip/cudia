//go:build windows

package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func wizardTest(t *testing.T) (wizardCoordinator, ed25519.PrivateKey) {
	t.Helper()
	m, root := newPathTest(t)
	keys, priv := testKeys(t)
	helper := filepath.Join(t.TempDir(), "launcher.exe")
	if err := os.WriteFile(helper, testPE(t), 0600); err != nil {
		t.Fatal(err)
	}
	key := strings.TrimSuffix(m.registrySubkey, `\Environment`) + `\Uninstall`
	t.Cleanup(func() {
		p, _ := syscall.UTF16PtrFromString(key)
		r, _, _ := pathAdvapi.NewProc("RegDeleteKeyW").Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(p)))
		if r != 0 && r != uintptr(syscall.ERROR_FILE_NOT_FOUND) {
			t.Errorf("isolated uninstall cleanup: %v", syscall.Errno(r))
		}
	})
	return wizardCoordinator{u: &updater{root: root, keys: keys, now: time.Now}, registrySubkey: key, path: m, helperSource: helper, recoveryRoot: t.TempDir()}, priv
}
func wizardPrepareTest(t *testing.T, w wizardCoordinator, priv ed25519.PrivateKey, p payload, add bool) installTicket {
	t.Helper()
	e, a, b := installTestBundle(t, w.u, priv, p)
	ticket, err := w.prepare(context.Background(), "normal", p.Channel, e, a, b, add)
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}
func wizardInstallTest(t *testing.T, w wizardCoordinator, priv ed25519.PrivateKey) installTicket {
	t.Helper()
	ticket := wizardPrepareTest(t, w, priv, testPayload(), true)
	if err := w.finalize(context.Background(), ticket.Ticket); err != nil {
		t.Fatal(err)
	}
	return ticket
}

func TestWizardUninstallAcceptsLegacyAutomaticCheckReceipt(t *testing.T) {
	w, priv := wizardTest(t)
	wizardInstallTest(t, w, priv)
	path := filepath.Join(w.u.root, "state", "wizard-owner.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var owner wizardOwner
	if err = decodeWizardOwner(b, w.u.root, &owner); err != nil {
		t.Fatal(err)
	}
	owner.Connection = installerConnection("stable", false)
	if err = os.WriteFile(filepath.Join(w.u.root, "connection.json"), owner.Connection, 0600); err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(owner)
	if err = wizardWriteJSON(path, b, false); err != nil {
		t.Fatal(err)
	}
	if err = w.uninstall(); err != nil {
		t.Fatal("legacy receipt blocked uninstall", err)
	}
	if _, err = os.Stat(filepath.Join(w.u.root, "connection.json")); !os.IsNotExist(err) {
		t.Fatal("legacy owned connection survived", err)
	}
}
func TestWizardFreshRepairCancelAndUninstall(t *testing.T) {
	w, priv := wizardTest(t)
	before := setPathTest(t, w.path, "C:\\user-existing", syscall.REG_EXPAND_SZ)
	e, a, b := installTestBundle(t, w.u, priv, testPayload())
	ticket, err := w.prepare(context.Background(), "normal", "stable", e, a, b, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.finalize(context.Background(), ticket.Ticket); err != nil {
		t.Fatal(err)
	}
	if err := w.finalize(context.Background(), ticket.Ticket); err != nil {
		t.Fatal("committed retry", err)
	}
	if _, err := readState(w.u.root); err != nil {
		t.Fatal(err)
	}
	values, exists, err := readWizardRegistry(w.registrySubkey, wizardRegistration(w.u.root, "stable", ticket.Version))
	if err != nil || !exists || !values["UninstallString"].equal(wizardRegistration(w.u.root, "stable", ticket.Version)["UninstallString"]) {
		t.Fatal("missing native registration", err)
	}
	owned, _, err := readPathOwnership(w.u.root, filepath.Join(w.u.root, "bin"))
	if err != nil || !owned.Added {
		t.Fatal("PATH not owned", err)
	}
	// Same-release repair still executes requested PATH and registration work.
	repair, err := w.prepare(context.Background(), "normal", "stable", e, a, b, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.finalize(context.Background(), repair.Ticket); err != nil {
		t.Fatal("repair", err)
	}
	owned, _, err = readPathOwnership(w.u.root, filepath.Join(w.u.root, "bin"))
	if err != nil || !owned.Added {
		t.Fatal("repair lost prior PATH ownership", err)
	}
	p := testPayload()
	p.Sequence = 2
	p.Version = "1.2.4"
	cancel := wizardPrepareTest(t, w, priv, p, true)
	if err = w.abort(context.Background(), cancel.Ticket); err != nil {
		t.Fatal(err)
	}
	state, err := readState(w.u.root)
	if err != nil || state.SelectedReleaseID != ticket.ReleaseID {
		t.Fatal("cancel changed working release", err)
	}
	unknown := filepath.Join(w.u.root, "user-sessions.json")
	if err = os.WriteFile(unknown, []byte("personal"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = w.uninstall(); err != nil {
		t.Fatal("uninstall", err)
	}
	if got, err := os.ReadFile(unknown); err != nil || string(got) != "personal" {
		t.Fatal("unknown user data changed", err)
	}
	if !getPathTest(t, w.path).equal(before) {
		t.Fatal("uninstall did not restore exact prior PATH")
	}
	_, exists, err = readWizardRegistry(w.registrySubkey, values)
	if err != nil || !exists {
		t.Fatal("registered recovery authority disappeared before external cleanup", err)
	}
}
func TestWizardFailureCompensatesOwnedChanges(t *testing.T) {
	for _, point := range []string{"file-intent:bin/cudia.exe", "file-promoted:bin/cudia.exe", "file-created:maintenance/launcher.exe", "registry-intent:DisplayName", "registry-written:DisplayName", "path-added", "before-activation"} {
		t.Run(point, func(t *testing.T) {
			w, priv := wizardTest(t)
			before := setPathTest(t, w.path, "C:\\preserve", syscall.REG_SZ)
			ticket := wizardPrepareTest(t, w, priv, testPayload(), true)
			w.fail = func(name string) error {
				if name == point {
					return errors.New("simulated process interruption")
				}
				return nil
			}
			if err := w.finalize(context.Background(), ticket.Ticket); err == nil {
				t.Fatal("failure hook not reached")
			}
			w.fail = nil
			if err := w.abort(context.Background(), ticket.Ticket); err != nil {
				t.Fatal("abort", err)
			}
			for _, name := range []string{"bin/cudia.exe", "maintenance/launcher.exe", "state/activation.json", "state/wizard-owner.json"} {
				if _, err := os.Stat(filepath.Join(w.u.root, filepath.FromSlash(name))); !os.IsNotExist(err) {
					t.Fatal("attempt file remained", name, err)
				}
			}
			if !getPathTest(t, w.path).equal(before) {
				t.Fatal("abort changed prior PATH")
			}
			// An ordinary rerun requires no old ticket and must not collide with an
			// empty key or abandoned staging left by cancellation.
			ticket = wizardPrepareTest(t, w, priv, testPayload(), true)
			if err := w.finalize(context.Background(), ticket.Ticket); err != nil {
				t.Fatal("rerun", err)
			}
		})
	}
}
func TestWizardFileRenameCrashCanFinalizeOrAbort(t *testing.T) {
	for _, point := range []string{"file-intent:bin/cudia.exe", "file-promoted:bin/cudia.exe"} {
		t.Run(point, func(t *testing.T) {
			w, priv := wizardTest(t)
			ticket := wizardPrepareTest(t, w, priv, testPayload(), false)
			w.fail = func(name string) error {
				if name == point {
					return errors.New("crash")
				}
				return nil
			}
			if err := w.finalize(context.Background(), ticket.Ticket); err == nil {
				t.Fatal("no simulated crash")
			}
			w.fail = nil
			if err := w.finalize(context.Background(), ticket.Ticket); err != nil {
				t.Fatal("FileID-bound recovery", err)
			}
		})
	}
}
func TestWizardPrepareAutomaticallyRecoversInterruptedAttempt(t *testing.T) {
	w, priv := wizardTest(t)
	ticket := wizardPrepareTest(t, w, priv, testPayload(), true)
	w.fail = func(name string) error {
		if name == "registry-written:DisplayName" {
			return errors.New("crash")
		}
		return nil
	}
	if err := w.finalize(context.Background(), ticket.Ticket); err == nil {
		t.Fatal("no interruption")
	}
	w.fail = nil
	again := wizardPrepareTest(t, w, priv, testPayload(), true)
	if again.Ticket == ticket.Ticket {
		t.Fatal("new wizard reused old ticket")
	}
	if err := w.finalize(context.Background(), again.Ticket); err != nil {
		t.Fatal(err)
	}
}
func TestWizardUncertainPathAndEditedRegistrationPreserved(t *testing.T) {
	w, priv := wizardTest(t)
	ticket := wizardPrepareTest(t, w, priv, testPayload(), true)
	w.path.beforeCommit = func() error { return errors.New("registry persisted but no ownership receipt") }
	if err := w.finalize(context.Background(), ticket.Ticket); err == nil {
		t.Fatal("uncertain PATH accepted")
	}
	path := getPathTest(t, w.path)
	w.path.beforeCommit = nil
	if err := w.abort(context.Background(), ticket.Ticket); err == nil {
		t.Fatal("uncertain PATH claimed")
	}
	if !getPathTest(t, w.path).equal(path) {
		t.Fatal("uncertain PATH removed")
	}
	if _, err := os.Stat(filepath.Join(w.u.root, "state", "wizard-pending.json")); err != nil {
		t.Fatal("uncertain journal removed", err)
	}
}
func TestWizardUninstallPreflightAndRecovery(t *testing.T) {
	for _, modified := range []string{"bin/cudia.exe", "maintenance/launcher.exe"} {
		t.Run(modified, func(t *testing.T) {
			w, priv := wizardTest(t)
			ticket := wizardInstallTest(t, w, priv)
			path := filepath.Join(w.u.root, filepath.FromSlash(modified))
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(path, []byte("modified"), 0600); err != nil {
				t.Fatal(err)
			}
			if err = w.uninstall(); err == nil {
				t.Fatal("modified executable removed")
			}
			if _, err = readState(w.u.root); err != nil {
				t.Fatal("payload deleted before preflight", err)
			}
			if err = os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			w.fail = func(point string) error {
				if point == "uninstall-before-registration" {
					return errors.New("crash")
				}
				return nil
			}
			if err = w.uninstall(); err == nil {
				t.Fatal("no crash")
			}
			w.fail = nil
			values, exists, err := readWizardRegistry(w.registrySubkey, wizardRegistration(w.u.root, "stable", ticket.Version))
			if err != nil || !exists || !values["DisplayName"].Exists {
				t.Fatal("registration removed too early", err)
			}
			if err = w.uninstall(); err != nil {
				t.Fatal("recovery after activation gone", err)
			}
		})
	}
}
func TestWizardUninstallPreservesEditedConnectionAndRunningLease(t *testing.T) {
	w, priv := wizardTest(t)
	wizardInstallTest(t, w, priv)
	connection := filepath.Join(w.u.root, "connection.json")
	edited := []byte("personal edited connection")
	if err := os.WriteFile(connection, edited, 0600); err != nil {
		t.Fatal(err)
	}
	lease, err := acquireLifetime(w.u.root, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.uninstall(); err == nil {
		t.Fatal("running lifetime lease ignored")
	}
	lease.close()
	if err = w.uninstall(); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(connection); err != nil || !bytes.Equal(b, edited) {
		t.Fatal("edited connection lost", err)
	}
}
func TestWizardRejectsUnownedRegistrationAndMismatchingHelper(t *testing.T) {
	w, priv := wizardTest(t)
	if err := writeWizardValue(w.registrySubkey, "DisplayName", pathSnapshot{true, syscall.REG_SZ, pathStringBytes("User application")}); err != nil {
		t.Fatal(err)
	}
	e, a, b := installTestBundle(t, w.u, priv, testPayload())
	if _, err := w.prepare(context.Background(), "normal", "stable", e, a, b, true); err == nil {
		t.Fatal("unowned registration adopted")
	}
	if err := writeWizardValue(w.registrySubkey, "DisplayName", pathSnapshot{}); err != nil {
		t.Fatal(err)
	}
	if err := removeEmptyWizardKey(w.registrySubkey); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(w.helperSource, []byte("wrong helper"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.prepare(context.Background(), "normal", "stable", e, a, b, true); err == nil {
		t.Fatal("unsigned helper admitted")
	}
}
func TestWizardUninstallKeepsVerifiedLiveRetryAtEveryFailure(t *testing.T) {
	points := []string{"uninstall-resume:UninstallString", "uninstall-handoff", "uninstall-app:bin/cudia.exe", "uninstall-app:maintenance/launcher.exe", "uninstall-before-registration"}

	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			w, priv := wizardTest(t)
			wizardInstallTest(t, w, priv)
			reached := false
			w.fail = func(name string) error {
				if name == point {
					reached = true
					return errors.New("simulated interruption")
				}
				return nil
			}
			if err := w.uninstall(); err == nil || !reached {
				t.Fatalf("failure point %s not reached (reached=%v): %v", point, reached, err)
			}
			w.fail = nil
			b, err := os.ReadFile(filepath.Join(w.u.root, "state", "wizard-uninstall.json"))
			if err != nil {
				t.Fatal(err)
			}
			var j wizardRemoval
			if err = decodeWizardRemoval(b, w.u.root, &j); err != nil {
				t.Fatal(err)
			}
			registry, exists, err := readWizardRegistry(w.registrySubkey, j.Owner.Registration)
			if err != nil || !exists || !registry["DisplayName"].Exists {
				t.Fatal("uninstall disappeared before completion", err)
			}
			command, err := registry["UninstallString"].value()
			if err != nil {
				t.Fatal(err)
			}
			parts := strings.SplitN(command, `"`, 3)
			if len(parts) != 3 {
				t.Fatal("unquoted uninstall command", command)
			}
			if err = installVerifyFile(parts[1], j.Owner.Helper); err != nil {
				t.Fatal("Apps and Features retry target missing or invalid", err)
			}
			if parts[1] != j.ResumeHelper {
				t.Fatal("retry still points at removable helper")
			}
			if err = w.validateRecoveryHelper(j); err != nil {
				t.Fatal("durable retry receipt", err)
			}
			if err = w.uninstall(); err != nil {
				t.Fatal("retry failed", err)
			}
			if err = w.uninstall(); err != nil {
				t.Fatal("completed uninstall is not idempotent", err)
			}
		})
	}
}
func TestWizardUninstallRejectsMissingModifiedOrReplacedRecoveryHelper(t *testing.T) {
	for _, kind := range []string{"missing", "modified", "same bytes new identity"} {
		t.Run(kind, func(t *testing.T) {
			w, priv := wizardTest(t)
			ticket := wizardInstallTest(t, w, priv)
			w.fail = func(name string) error {
				if name == "uninstall-planned" {
					return errors.New("crash")
				}
				return nil
			}
			if err := w.uninstall(); err == nil {
				t.Fatal("no interruption")
			}
			w.fail = nil
			b, err := os.ReadFile(filepath.Join(w.u.root, "state", "wizard-uninstall.json"))
			if err != nil {
				t.Fatal(err)
			}
			var j wizardRemoval
			if err = decodeWizardRemoval(b, w.u.root, &j); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "missing":
				err = os.Remove(j.ResumeHelper)
			case "modified":
				err = os.WriteFile(j.ResumeHelper, []byte("changed"), 0600)
			case "same bytes new identity":
				tmp := filepath.Join(filepath.Dir(j.ResumeHelper), "replacement.exe")
				err = installCopyVerified(context.Background(), j.ResumeHelper, tmp, j.Owner.Helper)
				if err == nil {
					err = os.Remove(j.ResumeHelper)
				}
				if err == nil {
					err = promote(tmp, j.ResumeHelper)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = w.uninstall(); err == nil {
				t.Fatal("invalid recovery helper accepted")
			}
			state, err := readState(w.u.root)
			if err != nil || state.SelectedReleaseID != ticket.ReleaseID {
				t.Fatal("payload removed before recovery preflight", err)
			}
		})
	}
}
func TestWizardPendingFileIdentityProtectsIdenticalReplacement(t *testing.T) {
	w, priv := wizardTest(t)
	ticket := wizardPrepareTest(t, w, priv, testPayload(), false)
	w.fail = func(name string) error {
		if name == "file-created:bin/cudia.exe" {
			return errors.New("crash")
		}
		return nil
	}
	if err := w.finalize(context.Background(), ticket.Ticket); err == nil {
		t.Fatal("no interruption")
	}
	w.fail = nil
	j, err := w.readPending(ticket.Ticket)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(w.u.root, "bin", "cudia.exe")
	tmp := filepath.Join(w.u.root, "bin", "replacement.exe")
	if err = installCopyVerified(context.Background(), path, tmp, j.Owner.Bootstrap); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = promote(tmp, path); err != nil {
		t.Fatal(err)
	}
	if err = w.abort(context.Background(), ticket.Ticket); err == nil {
		t.Fatal("replacement identity adopted for rollback")
	}
	if err = installVerifyFile(path, j.Owner.Bootstrap); err != nil {
		t.Fatal("replacement bytes deleted", err)
	}
}
func TestWizardPreservesPreexistingUnownedPathAndCompletionAfterActivation(t *testing.T) {
	w, priv := wizardTest(t)
	before := setPathTest(t, w.path, filepath.Join(w.u.root, "bin")+`;C:\user`, syscall.REG_SZ)
	ticket := wizardPrepareTest(t, w, priv, testPayload(), true)
	w.fail = func(name string) error {
		if name == "after-activation" {
			return errors.New("cleanup interrupted")
		}
		return nil
	}
	if err := w.finalize(context.Background(), ticket.Ticket); err != nil {
		t.Fatal("postactivation cleanup changed success", err)
	}
	w.fail = nil
	if err := w.abort(context.Background(), ticket.Ticket); err != nil {
		t.Fatal(err)
	}
	if err := w.uninstall(); err != nil {
		t.Fatal(err)
	}
	if !getPathTest(t, w.path).equal(before) {
		t.Fatal("preexisting PATH token removed")
	}
}
func TestWizardStrictOwnerAndPendingMetadata(t *testing.T) {
	w, priv := wizardTest(t)
	ticket := wizardPrepareTest(t, w, priv, testPayload(), false)
	j, err := w.readPending(ticket.Ticket)
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := json.Marshal(j.Owner)
	for _, bad := range [][]byte{bytes.Replace(owner, []byte(`"bootstrap"`), []byte(`"Bootstrap"`), 1), bytes.Replace(owner, []byte(`"size"`), []byte(`"Size"`), 1), bytes.Replace(owner, []byte(`"exists"`), []byte(`"Exists"`), 1), bytes.Replace(owner, []byte(`"schema":1`), []byte(`"schema":null`), 1)} {
		var o wizardOwner
		if err = decodeWizardOwner(bad, w.u.root, &o); err == nil {
			t.Fatal("non-exact ownership metadata accepted", string(bad))
		}
	}
	pending, _ := json.Marshal(j)
	bad := bytes.Replace(pending, []byte(`"addPath":false`), []byte(`"addPath":null`), 1)
	if err = os.WriteFile(filepath.Join(w.u.root, "state", "wizard-pending.json"), bad, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = w.readPending(ticket.Ticket); err == nil {
		t.Fatal("null flag accepted")
	}
}
