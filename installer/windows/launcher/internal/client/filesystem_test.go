package client

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCleanupContainmentAndReparseRefusal(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "preserve.txt")
	if err := os.WriteFile(sentinel, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, outside, filepath.Dir(root)} {
		if err := safeRemove(root, path); err == nil {
			t.Fatal("unsafe cleanup path accepted", path)
		}
	}
	work := filepath.Join(root, "work")
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(work, "redirect")
	cmd := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "mklink", "/J", junction, outside)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("test junction creation failed: %s %v", b, err)
	}
	t.Cleanup(func() {
		if err := os.Remove(junction); err != nil && !os.IsNotExist(err) {
			t.Errorf("remove owned test junction: %v", err)
		}
	})
	if err := guardPath(filepath.Join(junction, "preserve.txt")); err == nil {
		t.Fatal("junction ancestor accepted")
	}
	if err := safeRemove(root, work); err == nil {
		t.Fatal("cleanup accepted reparse descendant")
	}
	if b, err := os.ReadFile(sentinel); err != nil || string(b) != "preserve" {
		t.Fatal("cleanup escaped task root", err)
	}
	if err := os.Remove(junction); err != nil {
		t.Fatal(err)
	}
	if err := safeRemove(root, work); err != nil {
		t.Fatal("safe contained cleanup failed", err)
	}
}
