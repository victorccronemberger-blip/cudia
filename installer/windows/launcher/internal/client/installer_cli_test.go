package client

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerTicketOutputNeverOverwrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ticket ü.txt")
	if err := writeInstallerTicket(path, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeInstallerTicket(path, strings.Repeat("b", 64)); err == nil {
		t.Fatal("existing output was overwritten")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("existing ticket output changed", err)
	}
}

func TestUninstallCleanupCannotClaimAnUnownedAbsentRoot(t *testing.T) {
	for _, operation := range []string{"uninstall", "cleanup"} {
		t.Run(operation, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "not installed")
			personal := filepath.Join(parent, "personal.txt")
			if err := os.WriteFile(personal, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			if code := installerCommand([]string{operation, "--root", root, "--quiet"}); code == 0 {
				t.Fatal("unowned absent root was accepted")
			}
			if _, err := os.Lstat(root); !os.IsNotExist(err) {
				t.Fatal("unowned root was created or changed", err)
			}
			if b, err := os.ReadFile(personal); err != nil || string(b) != "preserve" {
				t.Fatal("unrelated file changed", err)
			}
		})
	}
}

func TestPendingMaintenancePreventsVersionMutation(t *testing.T) {
	for _, journal := range []string{"install-pending.json", "uninstall-pending.json", "wizard-pending.json", "wizard-intent.json", "wizard-uninstall.json"} {
		t.Run(journal, func(t *testing.T) {
			keys, private := testKeys(t)
			server, updater := testServer(t, keys)
			initial := initializeSmall(t, updater, server, private)
			before, err := os.ReadFile(filepath.Join(updater.root, "state", "activation.json"))
			if err != nil {
				t.Fatal(err)
			}
			nextSmall(t, server, private, 2)
			pending := filepath.Join(updater.root, "state", journal)
			if err := os.WriteFile(pending, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			_, err = updater.apply(context.Background())
			if err == nil || !strings.Contains(err.Error(), "maintenance is pending") {
				t.Fatal("update did not refuse pending maintenance", err)
			}
			if err := updater.rollback(initial.SelectedReleaseID); err == nil || !strings.Contains(err.Error(), "maintenance is pending") {
				t.Fatal("rollback did not refuse pending maintenance", err)
			}
			if err := updater.initialize(context.Background(), "normal", server.manifest, writeArchive(t, server.archive)); err == nil || !strings.Contains(err.Error(), "maintenance is pending") {
				t.Fatal("bundle installation did not refuse pending maintenance", err)
			}
			after, err := os.ReadFile(filepath.Join(updater.root, "state", "activation.json"))
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("pending maintenance changed activation", err)
			}
			if err := os.Remove(pending); err != nil {
				t.Fatal(err)
			}
			if _, err := updater.apply(context.Background()); err != nil {
				t.Fatal("update failed after pending maintenance was resolved", err)
			}
		})
	}
}
