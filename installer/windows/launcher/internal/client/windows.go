//go:build windows

package client

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var moveFileEx = kernel32.NewProc("MoveFileExW")
var lockFileEx = kernel32.NewProc("LockFileEx")
var unlockFileEx = kernel32.NewProc("UnlockFileEx")

func atomicReplace(from, to string) error {
	a, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	r, _, callErr := moveFileEx.Call(uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(b)), 0x1|0x8)
	if r == 0 {
		return callErr
	}
	return nil
}
func promote(from, to string) error {
	a, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	r, _, callErr := moveFileEx.Call(uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(b)), 0x8)
	if r == 0 {
		return callErr
	}
	return nil
}

type updateLock struct {
	file *os.File
	over syscall.Overlapped
}

func acquireLock(root string) (*updateLock, error) {
	path := filepath.Join(root, "state", "update.lock")
	if err := guardPath(filepath.Dir(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	if err := guardPath(path); err != nil {
		f.Close()
		return nil, err
	}
	l := &updateLock{file: f}
	r, _, _ := lockFileEx.Call(f.Fd(), 0x2|0x1, 0, 1, 0, uintptr(unsafe.Pointer(&l.over)))
	if r == 0 {
		f.Close()
		return nil, errors.New("another installation update is in progress")
	}
	return l, nil
}
func (l *updateLock) close() {
	unlockFileEx.Call(l.file.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&l.over)))
	l.file.Close()
}

// Reject reparse points in every existing ancestor, including junctions. The
// per-user install is not a security boundary against a concurrent same-user
// attacker; these checks prevent accidental traversal of redirected trees.
func guardPath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for {
		p, err := syscall.UTF16PtrFromString(abs)
		if err != nil {
			return err
		}
		attr, err := syscall.GetFileAttributes(p)
		if err == nil {
			if attr&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return errors.New("installation path contains a reparse point")
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			break
		}
		abs = parent
	}
	return nil
}
func contained(root, path string) bool {
	r, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(r, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func safeRemove(root, path string) error {
	if !contained(root, path) {
		return errors.New("refusing unsafe temporary cleanup")
	}
	if err := guardPath(path); err != nil {
		return err
	}
	// Check descendants too: RemoveAll must never receive a tree containing a
	// reparse point, even if Windows normally removes links without following.
	if err := filepath.WalkDir(path, func(p string, e os.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		return guardPath(p)
	}); err != nil {
		return err
	}
	return os.RemoveAll(path)
}
