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

// A shared lease belongs to each wrapper until its child exits. The kernel
// releases it after an abnormal process exit as well. Updates use a separate
// lock, so an engine may keep running while a new version is installed.
type lifetimeLock struct {
	file *os.File
	over syscall.Overlapped
}

func validateMaintenanceRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || strings.HasPrefix(root, `\\?\`) || strings.HasPrefix(root, `\\.\`) {
		return errors.New("installation root must be a canonical absolute path")
	}
	volume := filepath.VolumeName(root)
	relative := strings.TrimPrefix(root[len(volume):], string(filepath.Separator))
	if volume == "" || relative == "" || !validPath(filepath.ToSlash(relative)) {
		return errors.New("refusing an unsafe installation root")
	}
	if err := guardMaintenancePath(root); err != nil {
		return err
	}
	info, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("installation root is not a directory")
	}
	return nil
}

func acquireLifetime(root string, exclusive bool) (*lifetimeLock, error) {
	if err := validateMaintenanceRoot(root); err != nil {
		return nil, err
	}
	path := filepath.Join(root, "state", "lifetime.lock")
	if err := guardMaintenancePath(path); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := guardMaintenancePath(path); err != nil {
		f.Close()
		return nil, err
	}
	if err := singleRegularFile(f); err != nil {
		f.Close()
		return nil, err
	}
	l := &lifetimeLock{file: f}
	flags := uintptr(1) // LOCKFILE_FAIL_IMMEDIATELY; shared unless uninstalling.
	if exclusive {
		flags |= 2
	}
	result, _, _ := lockFileEx.Call(f.Fd(), flags, 0, 1, 0, uintptr(unsafe.Pointer(&l.over)))
	if result == 0 {
		f.Close()
		return nil, errors.New("Cudia is running or installation maintenance is in progress; close Cudia and retry")
	}
	return l, nil
}
func (l *lifetimeLock) close() {
	if l == nil || l.file == nil {
		return
	}
	unlockFileEx.Call(l.file.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&l.over)))
	l.file.Close()
	l.file = nil
}
func singleRegularFile(f *os.File) error {
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() {
		return errors.New("installation file is not regular")
	}
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); err != nil {
		return err
	}
	if info.NumberOfLinks != 1 {
		return errors.New("installation file has hard-link aliases")
	}
	return nil
}

// Short DOS names are aliases too: a descriptor must never name an unrelated
// long-named file through its generated 8.3 name. Check the nearest existing
// ancestor when the target is already missing during a retry.
func guardMaintenancePath(path string) error {
	if err := guardPath(path); err != nil {
		return err
	}
	for {
		_, err := os.Lstat(path)
		if os.IsNotExist(err) {
			parent := filepath.Dir(path)
			if parent == path {
				return err
			}
			path = parent
			continue
		}
		if err != nil {
			return err
		}
		pointer, err := syscall.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		buffer := make([]uint16, 32768)
		n, err := syscall.GetLongPathName(pointer, &buffer[0], uint32(len(buffer)))
		if err != nil {
			return err
		}
		if n == 0 || n >= uint32(len(buffer)) || !strings.EqualFold(path, syscall.UTF16ToString(buffer[:n])) {
			return errors.New("installation path contains a short-name alias")
		}
		return nil
	}
}

func maintenanceReparse(path string) (bool, error) {
	pointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	attributes, err := syscall.GetFileAttributes(pointer)
	return attributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0, err
}

// Leases cover new installations. Also inspect image paths for older wrappers
// and directly invoked engines that do not participate in the lease protocol.
// Opening a process here requests query access only; it never signals it.
func refuseRunningImages(root string) error {
	return refuseRunningImagesObserved(root, nil, nil)
}

// Observer hooks exercise actual Windows process-exit races in isolated tests.
// Production callers cannot select a PID to ignore or signal any process.
func refuseRunningImagesObserved(root string, beforeOpen, beforeQuery func(uint32)) error {
	snapshot, err := syscall.CreateToolhelp32Snapshot(2, 0)
	if err != nil {
		return fmt.Errorf("cannot inspect running Cudia processes: %w", err)
	}
	defer syscall.CloseHandle(snapshot)
	query := kernel32.NewProc("QueryFullProcessImageNameW")
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	err = syscall.Process32First(snapshot, &entry)
	for err == nil {
		name := strings.ToLower(syscall.UTF16ToString(entry.ExeFile[:]))
		candidate := name == "cudia.exe" || name == "launcher.exe" || name == "engine.exe"
		if beforeOpen != nil {
			beforeOpen(entry.ProcessID)
		}
		handle, openErr := syscall.OpenProcess(0x1000|0x100000, false, entry.ProcessID)
		if openErr != nil {
			// ERROR_INVALID_PARAMETER is the documented nonexistent-PID result.
			// Access-denied and all other unverifiable live candidates still block.
			if candidate && openErr != syscall.Errno(87) {
				return fmt.Errorf("cannot verify whether running %s (PID %d) belongs to this installation; close it and retry", name, entry.ProcessID)
			}
		} else {
			if beforeQuery != nil {
				beforeQuery(entry.ProcessID)
			}
			buffer := make([]uint16, 32768)
			size := uint32(len(buffer))
			result, _, queryErr := query.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
			waitResult, waitErr := syscall.WaitForSingleObject(handle, 0)
			gone := waitErr == nil && waitResult == syscall.WAIT_OBJECT_0
			syscall.CloseHandle(handle)
			if result == 0 && candidate && !gone {
				return fmt.Errorf("cannot verify running %s (PID %d): %w", name, entry.ProcessID, queryErr)
			}
			if result != 0 && !gone {
				image := syscall.UTF16ToString(buffer[:size])
				if contained(root, image) || strings.EqualFold(root, image) {
					return fmt.Errorf("Cudia executable is running from this installation (PID %d); close it and retry", entry.ProcessID)
				}
			}
		}
		err = syscall.Process32Next(snapshot, &entry)
	}
	if err != syscall.ERROR_NO_MORE_FILES {
		return fmt.Errorf("cannot finish inspecting running processes: %w", err)
	}
	return nil
}
