//go:build windows

package client

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func removalFixture(t *testing.T) (string, activation) {
	t.Helper()
	root := t.TempDir()
	if err := ensureLayout(root); err != nil {
		t.Fatal(err)
	}
	payload := testPayload()
	archive, d := smallPackage(t, payload)
	artifact := payload.Artifacts[0]
	artifact.Size = int64(len(archive))
	artifact.SHA256 = digest(archive)
	state := initialState("normal", payload, artifact, d)
	dir := filepath.Join(root, "versions", state.SelectedReleaseID)
	if _, err := extractPackage(writeArchive(t, archive), dir, payload, artifact); err != nil {
		t.Fatal(err)
	}
	if err := writeState(root, state); err != nil {
		t.Fatal(err)
	}
	return root, state
}
func TestMaintenanceLifetimeContention(t *testing.T) {
	root, _ := removalFixture(t)
	first, err := acquireLifetime(root, false)
	if err != nil {
		t.Fatal(err)
	}
	defer first.close()
	second, err := acquireLifetime(root, false)
	if err != nil {
		t.Fatal("shared leases conflict", err)
	}
	second.close()
	if lease, err := acquireLifetime(root, true); err == nil {
		lease.close()
		t.Fatal("exclusive lease accepted active runtime")
	}
	if err := preflightUninstall(root); err == nil {
		t.Fatal("preflight accepted active runtime")
	}
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("removal accepted active runtime")
	}
	// Updates remain independent from shared engine leases.
	update, err := acquireLock(root)
	if err != nil {
		t.Fatal("lifetime blocked update", err)
	}
	update.close()
	first.close()
	lease, err := acquireLifetime(root, true)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.close()
	if other, err := acquireLifetime(root, false); err == nil {
		other.close()
		t.Fatal("shared lease accepted maintenance")
	}
}
func TestMaintenancePreservesUnknownAndUserData(t *testing.T) {
	root, state := removalFixture(t)
	user := t.TempDir()
	t.Setenv("XDG_DATA_HOME", user)
	t.Setenv("XDG_CONFIG_HOME", user)
	t.Setenv("XDG_STATE_HOME", user)
	unknown := filepath.Join(root, "versions", state.SelectedReleaseID, "defaults", "my-session.json")
	outside := filepath.Join(user, "credentials.json")
	for _, path := range []string{unknown, outside, filepath.Join(root, "connection.json")} {
		if err := os.WriteFile(path, []byte("preserve"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := preflightUninstall(root); err != nil {
		t.Fatal(err)
	}
	if err := removeOwnedFiles(root); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{unknown, outside, filepath.Join(root, "connection.json")} {
		if data, err := os.ReadFile(path); err != nil || string(data) != "preserve" {
			t.Fatal("user file changed", path, err)
		}
	}
	for name := range state.Installed[state.SelectedReleaseID].Descriptor.Files {
		if _, err := os.Stat(filepath.Join(root, "versions", state.SelectedReleaseID, filepath.FromSlash(name))); !os.IsNotExist(err) {
			t.Fatal("owned payload survived", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "state", "activation.json")); !os.IsNotExist(err) {
		t.Fatal("activation survived", err)
	}
	if err := removeOwnedFiles(root); err != nil {
		t.Fatal("repeat removal failed", err)
	}
	remnants, err := uninstallRemnants(root)
	if err != nil || len(remnants) != 2 {
		t.Fatal("unexpected remnants", remnants, err)
	}
}
func TestMaintenanceModifiedFilePreservesWholeInstallation(t *testing.T) {
	root, state := removalFixture(t)
	changed := filepath.Join(root, "versions", state.SelectedReleaseID, "defaults", "release.txt")
	if err := os.WriteFile(changed, []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := preflightUninstall(root); err == nil {
		t.Fatal("accepted changed file")
	}
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("deleted changed installation")
	}
	if _, err := readState(root); err != nil {
		t.Fatal("activation changed", err)
	}
	if _, err := os.Stat(filepath.Join(root, "versions", state.SelectedReleaseID, "launcher.exe")); err != nil {
		t.Fatal("payload removed before full preflight", err)
	}
	if _, err := os.Stat(filepath.Join(root, "state", removalJournal)); !os.IsNotExist(err) {
		t.Fatal("journal created on failed preflight", err)
	}
}
func TestMaintenanceMissingFilesAndJournalRetry(t *testing.T) {
	root, state := removalFixture(t)
	plan, err := prepareRemoval(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemovalPlan(root, *plan); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "versions", state.SelectedReleaseID, "launcher.exe")
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	if err := preflightUninstall(root); err != nil {
		t.Fatal("retry rejected partial deletion", err)
	}
	if err := removeOwnedFiles(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "state", removalJournal)); !os.IsNotExist(err) {
		t.Fatal("completed journal survived", err)
	}
}
func TestMaintenanceJournalAndTransactionRefusal(t *testing.T) {
	root, _ := removalFixture(t)
	pending := filepath.Join(root, "state", "install-pending.json")
	if err := os.WriteFile(pending, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := preflightUninstall(root); err == nil {
		t.Fatal("accepted pending installation")
	}
	if err := os.Remove(pending); err != nil {
		t.Fatal(err)
	}
	plan, err := prepareRemoval(root)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	bytes = []byte(strings.Replace(string(bytes), `"schema":1`, `"schema":1,"unexpected":true`, 1))
	if err := os.WriteFile(filepath.Join(root, "state", removalJournal), bytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("accepted malformed journal")
	}
	if _, err := readState(root); err != nil {
		t.Fatal("state lost on malformed journal", err)
	}
}
func TestMaintenanceRejectsUnsafeRootsAndReparse(t *testing.T) {
	for _, root := range []string{`C:\`, `C:`, `relative`, `\\server\share`, `C:\Users\..\Windows`, `C:\invalid*name`, `\\?\C:\Windows`} {
		if err := validateMaintenanceRoot(root); err == nil {
			t.Fatal("accepted unsafe root", root)
		}
	}
	root, state := removalFixture(t)
	original := filepath.Join(root, "versions", state.SelectedReleaseID, "defaults")
	if err := os.Rename(original, original+"-saved"); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "release.txt")
	if err := os.WriteFile(sentinel, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "mklink", "/J", original, outside)
	if data, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("junction: %s %v", data, err)
	}
	t.Cleanup(func() { _ = os.Remove(original) })
	if err := preflightUninstall(root); err == nil {
		t.Fatal("accepted redirected payload")
	}
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("removed redirected payload")
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "preserve" {
		t.Fatal("outside file changed", err)
	}
}
func TestLifetimeHolderProcess(t *testing.T) {
	if os.Getenv("CUDIA_TEST_LIFETIME_HELPER") != "1" {
		return
	}
	root := os.Getenv("CUDIA_TEST_ROOT")
	lease, err := acquireLifetime(root, false)
	if err != nil {
		os.Exit(2)
	}
	defer lease.close()
	if err := os.WriteFile(filepath.Join(root, "ready"), nil, 0600); err != nil {
		os.Exit(3)
	}
	for {
		time.Sleep(time.Hour)
	}
}
func TestMaintenanceProcessDeathReleasesLifetime(t *testing.T) {
	root, _ := removalFixture(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestLifetimeHolderProcess$")
	cmd.Env = append(os.Environ(), "CUDIA_TEST_LIFETIME_HELPER=1", "CUDIA_TEST_ROOT="+root)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	waitFile(t, filepath.Join(root, "ready"))
	if err := preflightUninstall(root); err == nil {
		t.Fatal("accepted live child lease")
	}
	// This is the isolated test child created above, never a user engine.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	if err := preflightUninstall(root); err != nil {
		t.Fatal("dead helper retained lease", err)
	}
}
func TestMaintenanceRefusesLegacyRunningImage(t *testing.T) {
	root, _ := removalFixture(t)
	executable := filepath.Join(root, "legacy", "engine.exe")
	if err := os.Mkdir(filepath.Dir(executable), 0700); err != nil {
		t.Fatal(err)
	}
	buildNative(t, "./internal/client/testdata/engine", executable)
	ready := filepath.Join(t.TempDir(), "ready")
	release := filepath.Join(t.TempDir(), "release")
	cmd := exec.Command(executable, "--test-hold", ready, release)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.WriteFile(release, nil, 0600)
		if cmd.ProcessState == nil {
			_ = cmd.Wait()
		}
	}()
	waitFile(t, ready)
	if err := preflightUninstall(root); err == nil {
		t.Fatal("accepted legacy running image")
	}
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("removed legacy running image")
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal("legacy engine was disturbed", err)
	}
	if err := preflightUninstall(root); err != nil {
		t.Fatal(err)
	}
}

func TestMaintenanceSharingViolationRetainsDurableRetry(t *testing.T) {
	root, state := removalFixture(t)
	path := filepath.Join(root, "versions", state.SelectedReleaseID, "runtime", "engine.exe")
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("expected Windows sharing violation")
	}
	if _, err := readState(root); err != nil {
		t.Fatal("activation lost after partial deletion", err)
	}
	if _, err := os.Stat(filepath.Join(root, "state", removalJournal)); err != nil {
		t.Fatal("retry plan not durable", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := removeOwnedFiles(root); err != nil {
		t.Fatal("partial deletion retry failed", err)
	}
}
func TestMaintenanceJournalRecoversAfterActivationRemoval(t *testing.T) {
	root, _ := removalFixture(t)
	plan, err := prepareRemoval(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemovalPlan(root, *plan); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "state", "activation.json")); err != nil {
		t.Fatal(err)
	}
	if err := preflightUninstall(root); err != nil {
		t.Fatal("journal retry required removed activation", err)
	}
	if err := removeOwnedFiles(root); err != nil {
		t.Fatal(err)
	}
	if remnants, err := uninstallRemnants(root); err != nil || len(remnants) != 0 {
		t.Fatal("completed retry remnants", remnants, err)
	}
}
func TestMaintenanceRefusesHardLinkAliases(t *testing.T) {
	root, state := removalFixture(t)
	owned := filepath.Join(root, "versions", state.SelectedReleaseID, "defaults", "release.txt")
	alias := filepath.Join(t.TempDir(), "alias.txt")
	if err := os.Link(owned, alias); err != nil {
		t.Fatal(err)
	}
	if err := preflightUninstall(root); err == nil {
		t.Fatal("accepted hard-linked payload")
	}
	if err := removeOwnedFiles(root); err == nil {
		t.Fatal("removed hard-linked payload")
	}
	if _, err := readState(root); err != nil {
		t.Fatal("activation lost", err)
	}
	if _, err := os.Stat(alias); err != nil {
		t.Fatal("alias removed", err)
	}
}

func TestMaintenancePreservesAndReportsUnknownJunction(t *testing.T) {
	root, _ := removalFixture(t)
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "session.db")
	if err := os.WriteFile(sentinel, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(root, "my-data")
	command := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "mklink", "/J", junction, outside)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("junction: %s %v", output, err)
	}
	t.Cleanup(func() { _ = os.Remove(junction) })
	if err := removeOwnedFiles(root); err != nil {
		t.Fatal(err)
	}
	remnants, err := uninstallRemnants(root)
	if err != nil || len(remnants) != 1 || remnants[0] != "my-data" {
		t.Fatal("redirect was not reported without traversal", remnants, err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "preserve" {
		t.Fatal("outside data changed", err)
	}
}
