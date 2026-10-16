//go:build windows

package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOwnedCleanupAutomaticCachePreservesUnknownFiles(t *testing.T) {
	for _, known := range []bool{true, false} {
		t.Run(map[bool]string{true: "owned-cache", false: "unknown-cache"}[known], func(t *testing.T) {
			w, priv := wizardTest(t)
			wizardInstallTest(t, w, priv)
			cache := filepath.Join(w.u.root, "state", "update-check.json")
			body := []byte("personal file: preserve without adopting")
			if known {
				body, _ = json.Marshal(automaticCache{1, strings.ToLower(w.u.root), strings.Repeat("a", 64), time.Now().UTC().Format(time.RFC3339Nano), "failed", []byte{}})
			}
			if err := os.WriteFile(cache, body, 0600); err != nil {
				t.Fatal(err)
			}
			var receipt string
			w.cleanupOutput = &receipt
			if err := w.uninstall(); err != nil {
				t.Fatal(err)
			}
			if err := w.cleanupRoot(receipt); err != nil {
				t.Fatal(err)
			}
			if known {
				if _, err := os.Stat(w.u.root); !os.IsNotExist(err) {
					t.Fatal("owned cache prevented empty-root cleanup", err)
				}
				return
			}
			if b, err := os.ReadFile(cache); err != nil || string(b) != string(body) {
				t.Fatal("unknown cache was adopted or changed", err)
			}
		})
	}
}
