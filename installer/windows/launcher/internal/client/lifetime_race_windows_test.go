//go:build windows

package client

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRunningImageSnapshotAcceptsConfirmedExitedCandidate(t *testing.T) {
	for _, phase := range []string{"before-open", "before-query"} {
		t.Run(phase, func(t *testing.T) {
			dir := t.TempDir()
			exe := filepath.Join(dir, "launcher.exe")
			buildNative(t, "./internal/client/testdata/engine", exe)
			ready, release := filepath.Join(dir, "ready"), filepath.Join(dir, "release")
			child := exec.Command(exe, "--test-hold", ready, release)
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			exited := false
			defer func() {
				if !exited {
					_ = os.WriteFile(release, []byte("release owned test fixture"), 0600)
					_ = child.Wait()
				}
			}()
			waitFile(t, ready)
			observed := false
			exitOwnedFixture := func(pid uint32) {
				if pid != uint32(child.Process.Pid) {
					return
				}
				observed = true
				if err := os.WriteFile(release, []byte("release owned test fixture"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := child.Wait(); err != nil {
					t.Fatal(err)
				}
				exited = true
			}
			var beforeOpen, beforeQuery func(uint32)
			if phase == "before-open" {
				beforeOpen = exitOwnedFixture
			} else {
				beforeQuery = exitOwnedFixture
			}
			// The candidate is outside this root and exits normally after the process
			// snapshot. No unrelated PID is signaled, waited on, or excluded.
			if err := refuseRunningImagesObserved(t.TempDir(), beforeOpen, beforeQuery); err != nil {
				t.Fatal(err)
			}
			if !observed {
				t.Fatal("owned candidate was not present in process snapshot")
			}
		})
	}
}
