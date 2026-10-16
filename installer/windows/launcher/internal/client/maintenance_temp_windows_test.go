//go:build windows

package client

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestMaintenanceTempDirCanonicalizesOnlySystemPath(t *testing.T) {
	raw := syscall.UTF16PtrFromString
	systemTemp, err := maintenanceTempDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := guardMaintenancePath(systemTemp); err != nil {
		t.Fatalf("canonical system temp failed strict path guards: %v", err)
	}

	longPointer, err := raw(systemTemp)
	if err != nil {
		t.Fatal(err)
	}
	shortBuffer := make([]uint16, 32768)
	n, err := syscall.GetShortPathName(longPointer, &shortBuffer[0], uint32(len(shortBuffer)))
	if err != nil || n == 0 || n >= uint32(len(shortBuffer)) {
		t.Fatalf("resolve system temp short path: n=%d err=%v", n, err)
	}
	short := syscall.UTF16ToString(shortBuffer[:n])
	resolved, err := canonicalMaintenanceTempPath(short)
	if err != nil {
		t.Fatalf("canonicalize OS-returned short temp path %q: %v", short, err)
	}
	if !strings.EqualFold(resolved, systemTemp) {
		t.Fatalf("short system temp resolved to %q, want %q", resolved, systemTemp)
	}

	ownedImage := filepath.Join(systemTemp, "cudia-uninstall-fixture", "launcher.exe")
	if !isOwnedUninstallTemp(ownedImage) {
		t.Fatal("verified helper under canonical system temp was not recognized")
	}
	if !strings.EqualFold(short, systemTemp) {
		aliasedImage := filepath.Join(short, "cudia-uninstall-fixture", "launcher.exe")
		if isOwnedUninstallTemp(aliasedImage) {
			t.Fatal("caller-supplied short-name image path was normalized and accepted")
		}
		t.Logf("system temp alias resolved: %q -> %q", short, resolved)
	}
}
