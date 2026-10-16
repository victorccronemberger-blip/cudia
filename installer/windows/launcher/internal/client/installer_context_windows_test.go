//go:build windows

package client

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestInstallerContextPhysicalWritesLeaveNoMarker(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	if err := checkInstallerContext(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("context probe left artifacts: entries=%v err=%v", entries, err)
	}
	if code := installerCommand([]string{"context-check"}); code != 0 {
		t.Fatalf("context-check exit=%d", code)
	}
}

func TestInstallerContextRequiresAbsoluteAppData(t *testing.T) {
	t.Setenv("LOCALAPPDATA", "relative-directory")
	if err := checkInstallerContext(); err == nil {
		t.Fatal("relative application data was accepted")
	}
	if code := installerCommand([]string{"context-check"}); code == 0 {
		t.Fatal("invalid filesystem context was reported as success")
	}
}

func TestInstallerPhysicalRootWithoutCreatingDestination(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "new", "instalação ü")
	if err := checkInstallerRoot(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new")); !os.IsNotExist(err) {
		t.Fatalf("physical root check mutated destination: %v", err)
	}
}

func TestInstallerPhysicalRootRejectsAlias(t *testing.T) {
	dir := t.TempDir()
	target := t.TempDir()
	alias := filepath.Join(dir, "redirect")
	cmd := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "mklink", "/J", alias, target)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create owned test junction: %s %v", output, err)
	}
	t.Cleanup(func() { _ = os.Remove(alias) })
	if err := checkInstallerRoot(filepath.Join(alias, "new-installation")); err == nil {
		t.Fatal("physical root check accepted an alias")
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 0 {
		t.Fatalf("root check modified the alias target: entries=%v err=%v", entries, err)
	}
}
