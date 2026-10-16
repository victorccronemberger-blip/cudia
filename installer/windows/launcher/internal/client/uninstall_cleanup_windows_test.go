//go:build windows

package client

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func cleanupTestPlan(t *testing.T, unknown bool) (wizardCoordinator, string) {
	t.Helper()
	w, priv := wizardTest(t)
	wizardInstallTest(t, w, priv)
	if unknown {
		for _, name := range []string{"personal-note.txt", "state/personal-note.txt"} {
			if err := os.WriteFile(filepath.Join(w.u.root, filepath.FromSlash(name)), []byte("personal data"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	var receipt string
	w.cleanupOutput = &receipt
	if err := w.uninstall(); err != nil {
		t.Fatal(err)
	}
	if receipt == "" {
		t.Fatal("outside cleanup receipt not returned")
	}
	return w, receipt
}
func TestOwnedCleanupRemovesMetadataLocksAndEmptyRoot(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty", true: "unknown files"}[unknown], func(t *testing.T) {
			w, path := cleanupTestPlan(t, unknown)
			if err := w.cleanupRoot(path); err != nil {
				t.Fatal(err)
			}
			p, err := w.readCleanup(path)
			if err != nil || p.Phase != "tail" {
				t.Fatal("outside authority did not survive root cleanup", err)
			}
			for _, n := range []string{"state/lifetime.lock", "state/update.lock", "state/path-ownership.lock", "state/path-ownership.json", "state/wizard-owner.json", "state/wizard-uninstalled.json", "state/wizard-uninstall.json"} {
				if _, err = os.Lstat(filepath.Join(w.u.root, filepath.FromSlash(n))); !os.IsNotExist(err) {
					t.Fatal("owned metadata remained", n, err)
				}
			}
			if unknown {
				for _, n := range []string{"personal-note.txt", "state/personal-note.txt"} {
					if b, err := os.ReadFile(filepath.Join(w.u.root, filepath.FromSlash(n))); err != nil || string(b) != "personal data" {
						t.Fatal("personal file changed", err)
					}
				}
			} else if _, err = os.Stat(w.u.root); !os.IsNotExist(err) {
				t.Fatal("empty owned root remained", err)
			}
			if err = w.cleanupRoot(path); err != nil {
				t.Fatal("cleanup retry", err)
			}
		})
	}
}
func TestOwnedCleanupGateAndMetadataPreflight(t *testing.T) {
	w, path := cleanupTestPlan(t, true)
	before, err := os.ReadFile(filepath.Join(w.u.root, "state", "path-ownership.json"))
	if err != nil {
		t.Fatal(err)
	}
	lease, err := acquireLifetime(w.u.root, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.cleanupRoot(path); err == nil {
		t.Fatal("old reader did not block cleanup gate")
	}
	lease.close()
	if b, err := os.ReadFile(filepath.Join(w.u.root, "state", "path-ownership.json")); err != nil || string(b) != string(before) {
		t.Fatal("metadata changed before all gates", err)
	}
	if err = os.WriteFile(filepath.Join(w.u.root, "state", "path-ownership.json"), []byte("user edited metadata"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = w.cleanupRoot(path); err == nil {
		t.Fatal("modified metadata deleted")
	}
	if _, err = os.Stat(filepath.Join(w.u.root, "state", "wizard-uninstalled.json")); err != nil {
		t.Fatal("another metadata file was deleted before complete preflight", err)
	}
}
func TestOwnedCleanupCrashPhasesAndPartialMissingGates(t *testing.T) {
	for _, point := range []string{"cleanup-metadata:state/path-ownership.json", "cleanup-root-files-removed", "cleanup-lock-armed:state/path-ownership.lock", "cleanup-lock-armed:state/update.lock", "cleanup-lock-armed:state/lifetime.lock"} {
		t.Run(point, func(t *testing.T) {
			w, path := cleanupTestPlan(t, false)
			w.fail = func(name string) error {
				if name == point {
					return errors.New("simulated cleanup death")
				}
				return nil
			}
			if err := w.cleanupRoot(path); err == nil {
				t.Fatal("failure hook missing")
			}
			w.fail = nil
			if err := w.cleanupRoot(path); err != nil {
				t.Fatal("phase recovery", err)
			}
			if _, err := os.Stat(w.u.root); !os.IsNotExist(err) {
				t.Fatal("old root remained", err)
			}
		})
	}
}
func TestOwnedCleanupNeverRecreatesMissingPhaseAGateOrDeletesNewGeneration(t *testing.T) {
	w, path := cleanupTestPlan(t, true)
	if err := os.Remove(filepath.Join(w.u.root, "state", "lifetime.lock")); err != nil {
		t.Fatal(err)
	}
	if err := w.cleanupRoot(path); err == nil {
		t.Fatal("missing initial gate adopted")
	}
	if _, err := os.Lstat(filepath.Join(w.u.root, "state", "lifetime.lock")); !os.IsNotExist(err) {
		t.Fatal("missing gate recreated", err)
	}
	// A new generation makes the old root untouchable, even if it reuses the
	// same root directory while the old outside cleanup receipt is still present.
	newOwner := filepath.Join(w.u.root, "state", "activation.json")
	if err := os.WriteFile(newOwner, []byte("new-generation"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := w.cleanupRoot(path); err != nil {
		t.Fatal(err)
	}
	p, err := w.readCleanup(path)
	if err != nil || p.Phase != "superseded" {
		t.Fatal("new generation not recognized", err)
	}
	if b, err := os.ReadFile(newOwner); err != nil || string(b) != "new-generation" {
		t.Fatal("new generation changed", err)
	}
}
func TestOwnedCleanupRejectsSameBytesDifferentMetadataIdentity(t *testing.T) {
	w, path := cleanupTestPlan(t, false)
	target := filepath.Join(w.u.root, "state", "path-ownership.json")
	b, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(w.u.root, "state", "replacement.json")
	if err = os.WriteFile(replacement, b, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err = promote(replacement, target); err != nil {
		t.Fatal(err)
	}
	if err = w.cleanupRoot(path); err == nil {
		t.Fatal("replacement identity adopted")
	}
	if _, err = os.Stat(target); err != nil {
		t.Fatal("replacement deleted", err)
	}
}

type tailFixtureConfig struct {
	Receipt   string `json:"receipt"`
	FailPoint string `json:"failPoint"`
	Root      string `json:"root"`
	Key       string `json:"key"`
	Log       string `json:"log"`
}

func TestOwnedCleanupTailChild(t *testing.T) {
	config := os.Getenv("CUDIA_OWNED_TAIL_FIXTURE")
	if config == "" {
		return
	}
	b, err := os.ReadFile(config)
	if err != nil {
		os.Exit(91)
	}
	var c tailFixtureConfig
	if json.Unmarshal(b, &c) != nil {
		os.Exit(92)
	}
	self, err := os.Executable()
	if err != nil {
		os.Exit(93)
	}
	w := wizardCoordinator{u: &updater{root: c.Root}, registrySubkey: c.Key, registryChannel: "stable", tailLog: c.Log}
	if c.FailPoint != "" {
		w.fail = func(n string) error {
			if n == c.FailPoint {
				return errors.New("injected executor failure")
			}
			return nil
		}
	}
	if err = w.startCleanupTail(self, c.Receipt, c.Receipt != "", true, ""); err != nil {
		if c.FailPoint != "" && strings.Contains(err.Error(), "injected executor failure") {
			os.Exit(0)
		}
		_ = os.WriteFile(config+".error", []byte(err.Error()), 0600)
		os.Exit(94)
	}
	os.Exit(0)
}
func TestOwnedCleanupPowerShellTailDeletesOnlyVerifiedExitedFixture(t *testing.T) {
	fixture := t.TempDir()
	temp := filepath.Join(fixture, "temp")
	if err := os.Mkdir(temp, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(temp, "cudia-uninstall-")
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "launcher.exe")
	copyFile(t, self, exe)
	config := filepath.Join(fixture, "fixture.json")
	w, _ := wizardTest(t)
	c := tailFixtureConfig{Root: w.u.root, Key: w.registrySubkey, Log: filepath.Join(fixture, "tail.log")}

	original := wizardRegistration(c.Root, "stable", "1.2.3")
	for name, v := range original {
		if err = writeWizardValue(c.Key, name, v); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := cleanupSnapshot(exe, maxBootstrapBytes)
	if err != nil {
		t.Fatal(err)
	}
	id, err := cleanupDirectoryIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	authority := registeredCleanup{Schema: 1, Root: c.Root, Ticket: strings.Repeat("a", 64), Channel: "stable", Mode: "native", RootPhase: "none", Files: []registeredCleanupFile{{Path: exe, Kind: "temp-helper", State: "confirmed", Record: snap.Record, ID: snap.ID}}, Directories: []registeredCleanupDirectory{{Path: dir, State: "confirmed", ID: id}}, NativeValues: original, NativeRetryValues: map[string]pathSnapshot{}, CommandRecords: map[string]fileRecord{}}
	if err = w.writeRegisteredCleanup(authority); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(c)
	if err = os.WriteFile(config, b, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(exe, "-test.run=^TestOwnedCleanupTailChild$")
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if key != "TEMP" && key != "TMP" && key != "CUDIA_OWNED_TAIL_FIXTURE" {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "TEMP="+temp, "TMP="+temp, "CUDIA_OWNED_TAIL_FIXTURE="+config)
	if out, err := command.CombinedOutput(); err != nil {
		detail, _ := os.ReadFile(config + ".error")
		log, _ := os.ReadFile(c.Log)
		t.Fatalf("tail native child: %v %s %s %s", err, out, detail, log)
	}
	for until := time.Now().Add(65 * time.Second); time.Now().Before(until); {
		if _, err = os.Stat(dir); os.IsNotExist(err) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	log, _ := os.ReadFile(c.Log)
	t.Fatalf("finite PS tail left its owned fixture: %s", log)
}
func TestOwnedCleanupPhaseWriteFailureDoesNotArmLocks(t *testing.T) {
	w, path := cleanupTestPlan(t, false)
	w.fail = func(n string) error {
		if n == "cleanup-before-locks-phase" {
			return errors.New("phase persistence failed")
		}
		return nil
	}
	if err := w.cleanupRoot(path); err == nil {
		t.Fatal("phase failure ignored")
	}
	for _, n := range []string{"lifetime.lock", "update.lock", "path-ownership.lock"} {
		if _, err := os.Stat(filepath.Join(w.u.root, "state", n)); err != nil {
			t.Fatal("lock armed before phase commit", n, err)
		}
	}
	w.fail = nil
	if err := w.cleanupRoot(path); err != nil {
		t.Fatal(err)
	}
}
func TestOwnedCleanupNewGenerationAfterGatesClosedSurvives(t *testing.T) {
	w, path := cleanupTestPlan(t, false)
	created := false
	w.fail = func(n string) error {
		if n == "cleanup-all-gates-closed" {
			if err := os.MkdirAll(filepath.Join(w.u.root, "state"), 0700); err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(w.u.root, "state", "activation.json"), []byte("new generation"), 0600); err != nil {
				return err
			}
			created = true
		}
		return nil
	}
	if err := w.cleanupRoot(path); err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("hook missing")
	}
	if b, err := os.ReadFile(filepath.Join(w.u.root, "state", "activation.json")); err != nil || string(b) != "new generation" {
		t.Fatal("new generation changed", err)
	}
}
func TestOwnedCleanupRegisteredTransferAndRegistryOnlyFinalRetry(t *testing.T) {
	for _, point := range []string{"cleanup-handoff-intent", "cleanup-handoff-command:UninstallString", "cleanup-handoff-command:QuietUninstallString", "cleanup-handoff-complete"} {
		t.Run(point, func(t *testing.T) {
			w, path := cleanupTestPlan(t, true)
			if err := w.cleanupRoot(path); err != nil {
				t.Fatal(err)
			}
			reached := false
			w.fail = func(n string) error {
				if n == point {
					reached = true
					return errors.New("handoff interrupted")
				}
				return nil
			}
			err := withRegistrationLock(w.key("stable"), func() error { _, e := w.transferCleanupLocked("stable"); return e })
			if err == nil || !reached {
				t.Fatal("handoff hook missing", err)
			}
			if _, err = os.Stat(path); err != nil {
				t.Fatal("native authority removed before handoff", err)
			}
			w.fail = nil
			err = withRegistrationLock(w.key("stable"), func() error { _, e := w.transferCleanupLocked("stable"); return e })
			if err != nil {
				t.Fatal("transfer retry", err)
			}
			state, _, err := w.readRegisteredCleanup("stable")
			if err != nil {
				t.Fatal(err)
			}
			_, quiet, err := registryCleanupCommands(w.key("stable"), state.Ticket)
			if err != nil {
				t.Fatal(err)
			}
			shell, err := systemPowerShell()
			if err != nil {
				t.Fatal(err)
			}
			command := exec.Command(shell)
			command.SysProcAttr = &syscall.SysProcAttr{CmdLine: quiet, HideWindow: true}
			out, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("registry-only final retry: %v %s", err, out)
			}
			if _, exists, err := readWizardRegistry(w.key("stable"), map[string]pathSnapshot{registryCleanupValue: {}}); err != nil || exists {
				t.Fatal("final key remains", err)
			}
			if _, err = os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("outside receipt remains", err)
			}
			if b, err := os.ReadFile(filepath.Join(w.u.root, "state", "personal-note.txt")); err != nil || string(b) != "personal data" {
				t.Fatal("personal file changed", err)
			}
		})
	}
}
func TestOwnedCleanupOrphanGenerationRequiresExactOwner(t *testing.T) {
	w, priv := wizardTest(t)
	wizardInstallTest(t, w, priv)
	b, err := os.ReadFile(filepath.Join(w.u.root, "state", "wizard-owner.json"))
	if err != nil {
		t.Fatal(err)
	}
	var owner wizardOwner
	if err = decodeWizardOwner(b, w.u.root, &owner); err != nil {
		t.Fatal(err)
	}
	if err = writeWizardValue(w.key("stable"), registryCleanupGeneration, pathSnapshot{true, syscall.REG_SZ, pathStringBytes(owner.Ticket)}); err != nil {
		t.Fatal(err)
	}
	if err = w.recoverCleanupGeneration(owner); err != nil {
		t.Fatal(err)
	}
	if err = writeWizardValue(w.key("stable"), registryCleanupGeneration, pathSnapshot{true, syscall.REG_SZ, pathStringBytes(strings.Repeat("f", 64))}); err != nil {
		t.Fatal(err)
	}
	if err = w.recoverCleanupGeneration(owner); err == nil {
		t.Fatal("foreign generation adopted")
	}
}
func TestOwnedCleanupStartupFailureRestoresDurableNativeCommand(t *testing.T) {
	for _, point := range []string{"cleanup-handoff-intent", "cleanup-handoff-command:UninstallString", "cleanup-handoff-command:QuietUninstallString", "cleanup-handoff-complete", "cleanup-before-executor-start"} {
		t.Run(point, func(t *testing.T) {
			w, path := cleanupTestPlan(t, false)
			if err := w.cleanupRoot(path); err != nil {
				t.Fatal(err)
			}
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			w.fail = func(n string) error {
				if n == point {
					return errors.New("PowerShell unavailable")
				}
				return nil
			}
			if err = w.startCleanupTail(self, path, true, true, ""); err == nil || !strings.Contains(err.Error(), "PowerShell unavailable") {
				t.Fatal("original startup failure lost", err)
			}
			state, exists, err := w.readRegisteredCleanup("stable")
			if err != nil || !exists || state.Mode != "native" || state.Handoff {
				t.Fatal("native retry authority not restored", err)
			}
			current, _, err := readWizardRegistry(w.key("stable"), state.NativeRetryValues)
			if err != nil {
				t.Fatal(err)
			}
			for name, want := range state.NativeRetryValues {
				if !current[name].equal(want) {
					t.Fatal("native command not restored", name)
				}
			}
			if _, err = os.Stat(path); err != nil {
				t.Fatal("native root receipt lost", err)
			}
			w.fail = nil
			if err = withRegistrationLock(w.key("stable"), func() error { _, e := w.transferCleanupLocked("stable"); return e }); err != nil {
				t.Fatal("retry after unavailable PowerShell", err)
			}
		})
	}
}

func TestOwnedCleanupReservedAbsentReceiptCanRetryWithoutAdoption(t *testing.T) {
	w, priv := wizardTest(t)
	wizardInstallTest(t, w, priv)
	b, err := os.ReadFile(filepath.Join(w.u.root, "state", "wizard-owner.json"))
	if err != nil {
		t.Fatal(err)
	}
	var owner wizardOwner
	if err = decodeWizardOwner(b, w.u.root, &owner); err != nil {
		t.Fatal(err)
	}
	p, err := w.ensureRegisteredCleanup(owner)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "cleanup.json")
	r := fileRecord{3, digest([]byte("one"))}
	if err = w.reserveCleanupFile(&p, target, "root-receipt", r); err != nil {
		t.Fatal(err)
	}
	if err = w.reserveCleanupFile(&p, target, "root-receipt", fileRecord{3, digest([]byte("two"))}); err != nil {
		t.Fatal("absent reservation cannot retry", err)
	}
	if len(p.Files) != 1 {
		t.Fatal("duplicate reservation")
	}
	if err = os.WriteFile(target, []byte("two"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = w.reserveCleanupFile(&p, target, "root-receipt", r); err == nil {
		t.Fatal("present reserved file adopted")
	}
}
func TestOwnedCleanupDelayedExecutorReadsRevokedHandoff(t *testing.T) {
	for _, point := range []string{"cleanup-executor-started", "cleanup-executor-acknowledged"} {
		t.Run(point, func(t *testing.T) {
			w, receipt := cleanupTestPlan(t, true)
			if err := w.cleanupRoot(receipt); err != nil {
				t.Fatal(err)
			}
			fixture := t.TempDir()
			temp := filepath.Join(fixture, "temp")
			if err := os.Mkdir(temp, 0700); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(temp, "cudia-uninstall-1234567890abcdef1234567890abcdef")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			exe := filepath.Join(dir, "launcher.exe")
			copyFile(t, self, exe)
			snap, err := cleanupSnapshot(exe, maxBootstrapBytes)
			if err != nil {
				t.Fatal(err)
			}
			id, err := cleanupDirectoryIdentity(dir)
			if err != nil {
				t.Fatal(err)
			}
			p, _, err := w.readRegisteredCleanup("stable")
			if err != nil {
				t.Fatal(err)
			}
			p.Files = append(p.Files, registeredCleanupFile{Path: exe, Kind: "temp-helper", State: "confirmed", Record: snap.Record, ID: snap.ID})
			p.Directories = append(p.Directories, registeredCleanupDirectory{Path: dir, State: "confirmed", ID: id})
			if err = w.writeRegisteredCleanup(p); err != nil {
				t.Fatal(err)
			}
			config := filepath.Join(fixture, "config.json")
			c := tailFixtureConfig{Root: w.u.root, Key: w.registrySubkey, Log: filepath.Join(fixture, "tail.log"), Receipt: receipt, FailPoint: point}
			b, _ := json.Marshal(c)
			if err = os.WriteFile(config, b, 0600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(exe, "-test.run=^TestOwnedCleanupTailChild$")
			for _, entry := range os.Environ() {
				key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
				if key != "TEMP" && key != "TMP" && key != "CUDIA_OWNED_TAIL_FIXTURE" {
					cmd.Env = append(cmd.Env, entry)
				}
			}
			cmd.Env = append(cmd.Env, "TEMP="+temp, "TMP="+temp, "CUDIA_OWNED_TAIL_FIXTURE="+config)
			if out, err := cmd.CombinedOutput(); err != nil {
				detail, _ := os.ReadFile(config + ".error")
				t.Fatalf("child: %v %s %s", err, out, detail)
			}
			var log []byte
			for until := time.Now().Add(8 * time.Second); time.Now().Before(until); {
				log, _ = os.ReadFile(c.Log)
				if strings.Contains(string(log), "Exception") || strings.Contains(string(log), "handoff") {
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
			state, exists, err := w.readRegisteredCleanup("stable")
			if err != nil || !exists || state.Mode != "native" || state.Handoff {
				t.Fatal("handoff not revoked", err)
			}
			for _, f := range state.Files {
				if _, err := os.Stat(f.Path); err != nil {
					t.Fatal("delayed executor deleted owned recovery file", f.Kind, err)
				}
			}
			if len(log) == 0 {
				t.Fatal("delayed executor did not report rejection")
			}
		})
	}
}

type cleanupAbruptFixture struct {
	Root     string `json:"root"`
	Key      string `json:"key"`
	Receipt  string `json:"receipt"`
	Recovery string `json:"recovery"`
	Point    string `json:"point"`
	Action   string `json:"action"`
	Marker   string `json:"marker"`
}

func TestOwnedCleanupAbruptBoundaryChild(t *testing.T) {
	path := os.Getenv("CUDIA_CLEANUP_ABRUPT_FIXTURE")
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		os.Exit(90)
	}
	var c cleanupAbruptFixture
	if strictJSON(b, &c) != nil {
		os.Exit(91)
	}
	w := wizardCoordinator{u: &updater{root: c.Root}, registrySubkey: c.Key, registryChannel: "stable", recoveryRoot: c.Recovery}
	w.fail = func(n string) error {
		if n == c.Point {
			if os.WriteFile(c.Marker, []byte(n), 0600) != nil {
				os.Exit(92)
			}
			os.Exit(86)
		}
		return nil
	}
	err = withRegistrationLock(c.Key, func() error {
		if c.Action == "transfer" {
			_, e := w.transferCleanupLocked("stable")
			return e
		}
		p, _, e := w.readRegisteredCleanup("stable")
		if e != nil {
			return e
		}
		return w.restoreNativeCleanupLocked(p)
	})
	if err != nil {
		_ = os.WriteFile(c.Marker, []byte(err.Error()), 0600)
		os.Exit(93)
	}
	os.Exit(94)
}
func TestOwnedCleanupAbruptTransferAndRestoreRemainResumable(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	childExe := filepath.Join(t.TempDir(), "abrupt-fixture.exe")
	copyFile(t, self, childExe)
	transfer := []string{"cleanup-handoff-intent", "cleanup-handoff-command:UninstallString", "cleanup-handoff-command:QuietUninstallString", "cleanup-handoff-complete"}
	restore := []string{"cleanup-native-restore-intent", "cleanup-native-restored:UninstallString", "cleanup-native-restored:QuietUninstallString", "cleanup-native-restore-complete"}
	for _, action := range []string{"transfer", "restore"} {
		points := transfer
		if action == "restore" {
			points = restore
		}
		for _, point := range points {
			t.Run(action+"/"+point, func(t *testing.T) {
				w, receipt := cleanupTestPlan(t, true)
				if err = w.cleanupRoot(receipt); err != nil {
					t.Fatal(err)
				}
				if action == "restore" {
					if err = withRegistrationLock(w.key("stable"), func() error { _, e := w.transferCleanupLocked("stable"); return e }); err != nil {
						t.Fatal(err)
					}
				}
				before, _, err := w.readRegisteredCleanup("stable")
				if err != nil {
					t.Fatal(err)
				}
				snapshots := map[string]cleanupFile{}
				for _, f := range before.Files {
					snapshot, e := cleanupSnapshot(f.Path, maxBootstrapBytes)
					if e != nil {
						t.Fatal(e)
					}
					snapshots[f.Path] = snapshot
				}
				dir := t.TempDir()
				c := cleanupAbruptFixture{Root: w.u.root, Key: w.key("stable"), Receipt: receipt, Recovery: w.recoveryRoot, Point: point, Action: action, Marker: filepath.Join(dir, "abrupt.marker")}
				b, _ := json.Marshal(c)
				config := filepath.Join(dir, "fixture.json")
				if err = os.WriteFile(config, b, 0600); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(childExe, "-test.run=^TestOwnedCleanupAbruptBoundaryChild$")
				for _, entry := range os.Environ() {
					if !strings.HasPrefix(strings.ToUpper(entry), "CUDIA_CLEANUP_ABRUPT_FIXTURE=") {
						cmd.Env = append(cmd.Env, entry)
					}
				}
				cmd.Env = append(cmd.Env, "CUDIA_CLEANUP_ABRUPT_FIXTURE="+config)
				out, runErr := cmd.CombinedOutput()
				var exit *exec.ExitError
				if !errors.As(runErr, &exit) || exit.ExitCode() != 86 {
					detail, _ := os.ReadFile(c.Marker)
					t.Fatalf("abrupt child did not exit at durable hook: %v %s %s", runErr, out, detail)
				}
				marker, err := os.ReadFile(c.Marker)
				if err != nil || string(marker) != point {
					t.Fatal("abrupt boundary not reached", err)
				}
				fresh := w
				fresh.fail = nil
				state, exists, err := fresh.readRegisteredCleanup("stable")
				if err != nil || !exists {
					t.Fatal("abrupt journal unreadable", err)
				}
				normal, quiet, err := registryCleanupCommands(w.key("stable"), state.Ticket)
				if err != nil {
					t.Fatal(err)
				}
				commands := map[string]string{"UninstallString": normal, "QuietUninstallString": quiet}
				values, _, err := readWizardRegistry(w.key("stable"), state.NativeRetryValues)
				if err != nil {
					t.Fatal(err)
				}
				for name, value := range values {
					if !value.equal(state.NativeRetryValues[name]) && !value.equal(pathSnapshot{true, syscall.REG_SZ, pathStringBytes(commands[name])}) {
						t.Fatal("registered command lost every owned recovery route", name)
					}
				}
				expectedMode := "external-remove"
				expectedHandoff := point == "cleanup-handoff-complete"
				if point == "cleanup-native-restore-complete" {
					expectedMode = "native"
				}
				if state.Mode != expectedMode || state.Handoff != expectedHandoff {
					t.Fatal("wrong durable phase at abrupt boundary", state.Mode, state.Handoff)
				}
				for name, value := range values {
					native := false
					if action == "transfer" {
						native = point == "cleanup-handoff-intent" || (point == "cleanup-handoff-command:UninstallString" && name == "QuietUninstallString")
					} else {
						native = point == "cleanup-native-restore-complete" || point == "cleanup-native-restored:QuietUninstallString" || (point == "cleanup-native-restored:UninstallString" && name == "UninstallString")
					}
					want := pathSnapshot{true, syscall.REG_SZ, pathStringBytes(commands[name])}
					if native {
						want = state.NativeRetryValues[name]
					}
					if !value.equal(want) {
						t.Fatal("wrong durable command at abrupt boundary", name)
					}
				}
				for path, before := range snapshots {
					after, e := cleanupSnapshot(path, maxBootstrapBytes)
					if e != nil || after != before {
						t.Fatal("abrupt crash altered native recovery inventory", path, e)
					}
				}
				// The current native command can enter this same fresh coordinator even when
				// its sibling command and typed journal still describe incomplete PS transfer.
				if err = fresh.cleanupRoot(receipt); err != nil {
					t.Fatal("native root recovery entry", err)
				}
				if err = withRegistrationLock(w.key("stable"), func() error { _, e := fresh.transferCleanupLocked("stable"); return e }); err != nil {
					t.Fatal("fresh native coordinator cannot resume mixed command state", err)
				}
				if b, err := os.ReadFile(filepath.Join(w.u.root, "state", "personal-note.txt")); err != nil || string(b) != "personal data" {
					t.Fatal("personal data changed", err)
				}
			})
		}
	}
}
func TestOwnedCleanupNativeRestorationValidatesEntirePresentInventory(t *testing.T) {
	for _, kind := range []string{"historical-absent", "modified-historical", "reserved-present", "changed-directory", "unbound-current"} {
		t.Run(kind, func(t *testing.T) {
			w, path := cleanupTestPlan(t, false)
			if err := w.cleanupRoot(path); err != nil {
				t.Fatal(err)
			}
			var p registeredCleanup
			if err := withRegistrationLock(w.key("stable"), func() error { var e error; p, e = w.transferCleanupLocked("stable"); return e }); err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			target := filepath.Join(dir, "launcher.exe")
			record := fileRecord{3, digest([]byte("old"))}
			switch kind {
			case "historical-absent":
				p.Files = append(p.Files, registeredCleanupFile{Path: target, Kind: "durable-helper", State: "confirmed", Record: record, ID: wizardFileID{1, 2, 3}})
			case "modified-historical", "reserved-present":
				if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
					t.Fatal(err)
				}
				snapshot, err := cleanupSnapshot(target, 10)
				if err != nil {
					t.Fatal(err)
				}
				f := registeredCleanupFile{Path: target, Kind: "durable-helper", State: "confirmed", Record: snapshot.Record, ID: snapshot.ID}
				if kind == "modified-historical" {
					if err = os.WriteFile(target, []byte("new"), 0600); err != nil {
						t.Fatal(err)
					}
				} else {
					f.State = "reserved"
					f.ID = wizardFileID{}
				}
				p.Files = append(p.Files, f)
			case "changed-directory":
				p.Directories = append(p.Directories, registeredCleanupDirectory{Path: dir, State: "confirmed", ID: wizardFileID{1, 2, 3}})
			case "unbound-current":
				p.NativeRetryValues["QuietUninstallString"] = pathSnapshot{true, syscall.REG_SZ, pathStringBytes("unbound")}
			}
			if err := w.writeRegisteredCleanup(p); err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(p)
			err := withRegistrationLock(w.key("stable"), func() error { return w.restoreNativeCleanupLocked(p) })
			if kind == "historical-absent" {
				if err != nil {
					t.Fatal("confirmed absent historical helper blocked current native recovery", err)
				}
				return
			}
			if err == nil {
				t.Fatal("uncertain present inventory admitted native registry repair")
			}
			after, _, readErr := w.readRegisteredCleanup("stable")
			if readErr != nil {
				t.Fatal(readErr)
			}
			encoded, _ := json.Marshal(after)
			if string(before) != string(encoded) {
				t.Fatal("registry authority changed before full native inventory proof")
			}
		})
	}
}
