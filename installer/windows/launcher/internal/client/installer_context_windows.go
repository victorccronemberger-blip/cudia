//go:build windows

package client

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// An MSIX descendant can have no package identity and still redirect new writes
// into its parent's private AppData. Inspect an actual write, not package flags.
// This runs before the wizard prepares application files, PATH or registration.
func checkInstallerContext() error {
	local := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(local) || filepath.Clean(local) != local {
		return errors.New("installer requires an absolute local application data directory")
	}
	f, err := os.CreateTemp(local, ".cudia-install-context-*")
	if err != nil {
		return fmt.Errorf("cannot verify installer filesystem context: %w", err)
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	buffer := make([]uint16, 32768)
	n, _, callErr := kernel32.NewProc("GetFinalPathNameByHandleW").Call(f.Fd(), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
	if n == 0 || n >= uintptr(len(buffer)) {
		return fmt.Errorf("cannot resolve installer filesystem context: %w", callErr)
	}
	actual := syscall.UTF16ToString(buffer[:n])
	if strings.HasPrefix(actual, `\\?\UNC\`) {
		actual = `\\` + strings.TrimPrefix(actual, `\\?\UNC\`)
	} else {
		actual = strings.TrimPrefix(actual, `\\?\`)
	}
	if !strings.EqualFold(filepath.Clean(actual), filepath.Clean(name)) {
		return errors.New("installer filesystem is redirected; launch the complete CUDIA setup from the Windows desktop")
	}
	return nil
}

func checkInstallerRoot(root string) error {
	for path := root; ; path = filepath.Dir(path) {
		name, err := syscall.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		h, err := syscall.CreateFile(name, 0x80, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if os.IsNotExist(err) && filepath.Dir(path) != path {
			continue
		}
		if err != nil {
			return fmt.Errorf("cannot verify physical installation directory: %w", err)
		}
		buffer := make([]uint16, 32768)
		n, _, callErr := kernel32.NewProc("GetFinalPathNameByHandleW").Call(uintptr(h), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
		syscall.CloseHandle(h)
		if n == 0 || n >= uintptr(len(buffer)) {
			return fmt.Errorf("cannot resolve physical installation directory: %w", callErr)
		}
		actual := syscall.UTF16ToString(buffer[:n])
		if strings.HasPrefix(actual, `\\?\UNC\`) {
			actual = `\\` + strings.TrimPrefix(actual, `\\?\UNC\`)
		} else {
			actual = strings.TrimPrefix(actual, `\\?\`)
		}
		if !strings.EqualFold(filepath.Clean(actual), filepath.Clean(path)) {
			return errors.New("installation directory has a filesystem alias or package redirection")
		}
		return nil
	}
}
