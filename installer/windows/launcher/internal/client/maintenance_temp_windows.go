//go:build windows

package client

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// maintenanceTempDir canonicalizes only the path supplied by the operating
// system. Caller and journal paths continue to pass through strict guards
// unchanged, so an untrusted short-name alias is still rejected.
func maintenanceTempDir() (string, error) {
	return canonicalMaintenanceTempPath(os.TempDir())
}

func canonicalMaintenanceTempPath(systemPath string) (string, error) {
	if !filepath.IsAbs(systemPath) || filepath.Clean(systemPath) != systemPath || strings.HasPrefix(systemPath, `\\`) {
		return "", errors.New("system temporary directory is not a canonical local absolute path")
	}
	pointer, err := syscall.UTF16PtrFromString(systemPath)
	if err != nil {
		return "", err
	}
	buffer := make([]uint16, 32768)
	n, err := syscall.GetLongPathName(pointer, &buffer[0], uint32(len(buffer)))
	if err != nil {
		return "", err
	}
	if n == 0 || n >= uint32(len(buffer)) {
		return "", errors.New("cannot canonicalize system temporary directory")
	}
	canonical := syscall.UTF16ToString(buffer[:n])
	if !filepath.IsAbs(canonical) || filepath.Clean(canonical) != canonical || filepath.VolumeName(canonical) == "" || strings.HasPrefix(canonical, `\\`) {
		return "", errors.New("system temporary directory did not resolve to a local canonical path")
	}
	if err := guardMaintenancePath(canonical); err != nil {
		return "", err
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("system temporary path is not a directory")
	}
	return canonical, nil
}
