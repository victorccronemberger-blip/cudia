//go:build windows

package client

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var registrationAdvapi32 = syscall.NewLazyDLL("advapi32.dll")
var registrationConvertSDDL = registrationAdvapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
var registrationCreateMutex = kernel32.NewProc("CreateMutexW")
var registrationReleaseMutex = kernel32.NewProc("ReleaseMutex")

// Registration ownership is per user and registry key, independent of the
// installation directory and Windows session. Global mutexes, unlike global
// file mappings and symbolic links, do not require SeCreateGlobalPrivilege.
func withRegistrationLock(subkey string, fn func() error) (err error) {
	if fn == nil {
		return errors.New("registration lock requires a callback")
	}
	name, sddl, err := registrationLockIdentity(subkey)
	if err != nil {
		return err
	}
	// Windows mutex ownership belongs to the OS thread, not the Go goroutine.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	handle, err := createRegistrationMutex(name, sddl)
	if err != nil {
		return err
	}
	owned := false
	defer func() {
		if owned {
			result, _, releaseErr := registrationReleaseMutex.Call(uintptr(handle))
			if result == 0 && err == nil {
				err = fmt.Errorf("release registration lock: %w", releaseErr)
			}
		}
		if closeErr := syscall.CloseHandle(handle); closeErr != nil && err == nil {
			err = fmt.Errorf("close registration lock: %w", closeErr)
		}
	}()
	result, waitErr := syscall.WaitForSingleObject(handle, 0)
	if waitErr != nil {
		return fmt.Errorf("acquire registration lock: %w", waitErr)
	}
	switch result {
	case syscall.WAIT_OBJECT_0, syscall.WAIT_ABANDONED:
		// An abandoned mutex grants ownership but says nothing about registry
		// consistency. The callback must perform its normal full revalidation.
		owned = true
	case uint32(syscall.WAIT_TIMEOUT):
		return errors.New("another Cudia registration operation is in progress; retry when it finishes")
	default:
		return fmt.Errorf("unexpected registration lock wait result: %#x", result)
	}
	return fn()
}

func registrationLockIdentity(subkey string) (name, sddl string, err error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", "", fmt.Errorf("read registration user token: %w", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", "", fmt.Errorf("read registration user SID: %w", err)
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return "", "", err
	}
	return registrationMutexSpec(sid, subkey)
}

// PowerShell cleanup uses this same byte-level contract: canonical SID, newline,
// uppercase ASCII relative HKCU key; SHA-256 encoded as lowercase hexadecimal.
// Restricting the supported key alphabet avoids differing Unicode case rules.
func registrationMutexSpec(sid, subkey string) (name, sddl string, err error) {
	parsed, err := syscall.StringToSid(sid)
	if err != nil {
		return "", "", errors.New("invalid registration user SID")
	}
	canonicalSID, err := parsed.String()
	if err != nil || canonicalSID != sid || !strings.HasPrefix(sid, "S-1-") {
		return "", "", errors.New("registration user SID must be canonical")
	}
	if len(subkey) == 0 || len(subkey) > 1024 {
		return "", "", errors.New("registration subkey must contain 1 to 1024 ASCII bytes")
	}
	for _, char := range []byte(subkey) {
		if char < 0x20 || char > 0x7e || char == '/' {
			return "", "", errors.New("registration subkey must be a canonical ASCII registry path")
		}
	}
	for _, part := range strings.Split(subkey, `\`) {
		if part == "" || part == "." || part == ".." || strings.TrimSpace(part) != part {
			return "", "", errors.New("registration subkey must be a canonical relative registry path")
		}
	}
	digest := sha256.Sum256([]byte(sid + "\n" + strings.ToUpper(subkey)))
	return fmt.Sprintf(`Global\Cudia-Registration-%x`, digest), "O:" + sid + "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", nil
}

func createRegistrationMutex(name, sddl string) (syscall.Handle, error) {
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		return 0, err
	}
	var descriptor uintptr
	result, _, callErr := registrationConvertSDDL.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if result == 0 {
		return 0, fmt.Errorf("create registration lock security descriptor: %w", callErr)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	wideName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	result, _, callErr = registrationCreateMutex.Call(uintptr(unsafe.Pointer(&attributes)), 0, uintptr(unsafe.Pointer(wideName)))
	if result == 0 {
		return 0, fmt.Errorf("create global registration lock: %w", callErr)
	}
	handle := syscall.Handle(result)
	// CreateMutex ignores the supplied descriptor when the object already
	// exists. Inspect both new and existing objects before trusting the lock.
	if err := validateRegistrationMutexSecurity(handle, sddl); err != nil {
		syscall.CloseHandle(handle)
		return 0, err
	}
	return handle, nil
}

func validateRegistrationMutexSecurity(handle syscall.Handle, expected string) error {
	var descriptor uintptr
	result, _, _ := registrationAdvapi32.NewProc("GetSecurityInfo").Call(uintptr(handle), 6, 1|4, 0, 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if result != 0 {
		return fmt.Errorf("inspect registration lock security: %w", syscall.Errno(result))
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	expectedDescriptor, err := registrationDescriptorFromSDDL(expected)
	if err != nil {
		return fmt.Errorf("parse expected registration lock security: %w", err)
	}
	defer syscall.LocalFree(syscall.Handle(expectedDescriptor))
	expectedText, err := registrationDescriptorText(expectedDescriptor)
	if err != nil {
		return fmt.Errorf("canonicalize expected registration lock security: %w", err)
	}
	actualText, err := registrationDescriptorText(descriptor)
	if err != nil {
		return fmt.Errorf("decode registration lock security: %w", err)
	}
	if normalizeRegistrationSecurityText(actualText) != normalizeRegistrationSecurityText(expectedText) {
		return errors.New("registration lock security differs from its protected user/SYSTEM policy; refusing the existing object")
	}
	return nil
}

func registrationDescriptorFromSDDL(sddl string) (uintptr, error) {
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		return 0, err
	}
	var descriptor uintptr
	result, _, callErr := registrationConvertSDDL.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if result == 0 {
		return 0, callErr
	}
	return descriptor, nil
}

func registrationDescriptorText(descriptor uintptr) (string, error) {
	var text *uint16
	var length uint32
	result, _, callErr := registrationAdvapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW").Call(descriptor, 1, 1|4, uintptr(unsafe.Pointer(&text)), uintptr(unsafe.Pointer(&length)))
	if result == 0 {
		return "", callErr
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(text)))
	if text == nil || length == 0 || length > 2048 {
		return "", errors.New("invalid registration lock security descriptor length")
	}
	return syscall.UTF16ToString(unsafe.Slice(text, int(length))), nil
}

func normalizeRegistrationSecurityText(sddl string) string {
	// Windows expands GENERIC_ALL on mutexes to this exact access mask. Apply
	// the same normalization to both descriptors after round-tripping so SID
	// aliases (for example LA) are compared in Windows' canonical SDDL form.
	return strings.ReplaceAll(sddl, ";;0x1f0001;", ";;GA;")
}
