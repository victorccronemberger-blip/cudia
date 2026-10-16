//go:build windows

package client

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func registrationTestKey(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf(`Software\Cudia.Tests\Registration\%d-%d`, os.Getpid(), time.Now().UnixNano())
}

func TestRegistrationMutexSpec(t *testing.T) {
	sid := "S-1-5-21-1-2-3-1001"
	key := `Software\Classes\Cudia.Tests\Registration`
	name, sddl, err := registrationMutexSpec(sid, key)
	if err != nil {
		t.Fatal(err)
	}
	// This vector was independently generated with PowerShell SHA256/UTF8.
	if name != `Global\Cudia-Registration-39b250cae0025f3e6c40731a57b6259d13a0db816b491e32f713f2ea03748acd` {
		t.Fatalf("unexpected mutex identity: %q", name)
	}
	if sddl != "O:"+sid+"D:P(A;;GA;;;SY)(A;;GA;;;"+sid+")" {
		t.Fatalf("unexpected security descriptor: %q", sddl)
	}
	other, _, err := registrationMutexSpec(sid, strings.ToUpper(key))
	if err != nil || other != name {
		t.Fatalf("registry case alias did not serialize: %q, %v", other, err)
	}
	for _, different := range []struct{ sid, key string }{{sid, key + "Preview"}, {"S-1-5-21-1-2-3-1002", key}} {
		other, _, err := registrationMutexSpec(different.sid, different.key)
		if err != nil || other == name {
			t.Fatalf("different registration identity collided: %q, %v", other, err)
		}
	}
	for _, invalid := range []string{"", `\Software`, `Software\`, `Software\\Cudia`, `Software/Cudia`, `Software\.\Cudia`, `Software\..\Cudia`, `Software\ Cudia`, `Software\Cudia `, "Software\x00Cudia", "Software\nCudia", "Software\\Cudiá", strings.Repeat("a", 1025)} {
		if _, _, err := registrationMutexSpec(sid, invalid); err == nil {
			t.Errorf("accepted noncanonical key %q", invalid)
		}
	}
	for _, invalid := range []string{"", "SY", "S-1-5-21-1-2-3-1001)D:(A;;GA;;;WD)", "S-1-5-021-1-2-3-1001"} {
		if _, _, err := registrationMutexSpec(invalid, key); err == nil {
			t.Errorf("accepted noncanonical SID %q", invalid)
		}
	}
}

func TestRegistrationMutexThreadsAndRelease(t *testing.T) {
	key := registrationTestKey(t)
	callbackError := errors.New("callback revalidation failed")
	if err := withRegistrationLock(key, func() error {
		// The same OS thread can recursively acquire a mutex. Each acquisition
		// must still be released once, including when nested callbacks fail.
		if err := withRegistrationLock(strings.ToUpper(key), func() error { return callbackError }); err != callbackError {
			return fmt.Errorf("nested callback error changed: %v", err)
		}
		result := make(chan error, 1)
		go func() {
			result <- withRegistrationLock(key, func() error { return errors.New("contending callback ran") })
		}()
		if err := <-result; err == nil || !strings.Contains(err.Error(), "in progress") {
			return fmt.Errorf("another OS thread acquired owned mutex: %v", err)
		}
		return callbackError
	}); err != callbackError {
		t.Fatalf("callback error changed: %v", err)
	}
	if err := withRegistrationLock(key, func() error { return nil }); err != nil {
		t.Fatalf("error path retained mutex: %v", err)
	}
	func() {
		defer func() {
			if recovered := recover(); recovered != "registration callback panic" {
				t.Errorf("panic changed: %v", recovered)
			}
		}()
		_ = withRegistrationLock(key, func() error { panic("registration callback panic") })
	}()
	result := make(chan error, 1)
	go func() { result <- withRegistrationLock(key, func() error { return nil }) }()
	if err := <-result; err != nil {
		t.Fatalf("panic path retained mutex: %v", err)
	}
}

// This helper only opens a private test mutex; it never writes the registry.
func TestRegistrationMutexProcessHelper(t *testing.T) {
	key := os.Getenv("CUDIA_TEST_REGISTRATION_MUTEX_KEY")
	if key == "" {
		return
	}
	if !strings.HasPrefix(key, `Software\Cudia.Tests\Registration\`) {
		t.Fatal("helper requires its private test namespace")
	}
	if err := withRegistrationLock(key, func() error {
		fmt.Println("registration-mutex-ready")
		var command [1]byte
		if _, err := os.Stdin.Read(command[:]); err != nil {
			return err
		}
		if command[0] == 'a' {
			// Deliberately bypass Go defers to exercise real kernel abandonment.
			os.Exit(0)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}

func registrationMutexChild(t *testing.T, key string) (io.WriteCloser, func()) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestRegistrationMutexProcessHelper$")
	cmd.Env = append(os.Environ(), "CUDIA_TEST_REGISTRATION_MUTEX_KEY="+key)
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var once sync.Once
	wait := func() {
		t.Helper()
		once.Do(func() {
			input.Close()
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("private registration helper exit: %v", err)
				}
			case <-time.After(10 * time.Second):
				// Only this exact freshly started helper can be terminated.
				cmd.Process.Kill()
				<-done
				t.Error("private registration helper did not exit")
			}
		})
	}
	t.Cleanup(wait)
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(output).ReadString('\n')
		ready <- strings.TrimSpace(line)
	}()
	select {
	case line := <-ready:
		if line != "registration-mutex-ready" {
			t.Fatalf("private helper did not acquire mutex: %q", line)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("private helper readiness timed out")
	}
	return input, wait
}

func TestRegistrationMutexSeparateProcessContention(t *testing.T) {
	key := registrationTestKey(t)
	input, wait := registrationMutexChild(t, key)
	called := false
	if err := withRegistrationLock(strings.ToUpper(key), func() error { called = true; return nil }); err == nil || !strings.Contains(err.Error(), "in progress") || called {
		t.Fatalf("separate process contention was not refused: called=%v, err=%v", called, err)
	}
	if _, err := input.Write([]byte("r")); err != nil {
		t.Fatal(err)
	}
	wait()
	if err := withRegistrationLock(key, func() error { return nil }); err != nil {
		t.Fatalf("exited process retained mutex: %v", err)
	}
}

func TestRegistrationMutexAbandonmentRevalidates(t *testing.T) {
	for _, inspectWait := range []bool{true, false} {
		t.Run(fmt.Sprint(inspectWait), func(t *testing.T) {
			key := registrationTestKey(t)
			input, wait := registrationMutexChild(t, key)
			name, sddl, err := registrationLockIdentity(key)
			if err != nil {
				t.Fatal(err)
			}
			// Preserve the object when the child exits: without another handle
			// Windows deletes it and there is no abandoned object left to test.
			handle, err := createRegistrationMutex(name, sddl)
			if err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(handle)
			if _, err := input.Write([]byte("a")); err != nil {
				t.Fatal(err)
			}
			wait()
			if inspectWait {
				runtime.LockOSThread()
				defer runtime.UnlockOSThread()
				result, err := syscall.WaitForSingleObject(handle, 0)
				if err != nil || result != syscall.WAIT_ABANDONED {
					t.Fatalf("expected genuine kernel abandonment: %#x, %v", result, err)
				}
				if result, _, err := registrationReleaseMutex.Call(uintptr(handle)); result == 0 {
					t.Fatal(err)
				}
				return
			}
			called := false
			revalidation := errors.New("full callback revalidation ran")
			if err := withRegistrationLock(key, func() error { called = true; return revalidation }); err != revalidation || !called {
				t.Fatalf("abandoned lock skipped callback: called=%v, err=%v", called, err)
			}
		})
	}
}

func TestRegistrationMutexActualProtectedSecurity(t *testing.T) {
	name, expected, err := registrationLockIdentity(registrationTestKey(t))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := createRegistrationMutex(name, expected)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	getSecurity := registrationAdvapi32.NewProc("GetSecurityInfo")
	convert := registrationAdvapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	var descriptor uintptr
	result, _, _ := getSecurity.Call(uintptr(handle), 6, 1|4, 0, 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if result != 0 {
		t.Fatalf("inspect mutex security: %v", syscall.Errno(result))
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	var text *uint16
	result, _, callErr := convert.Call(descriptor, 1, 1|4, uintptr(unsafe.Pointer(&text)), 0)
	if result == 0 {
		t.Fatal(callErr)
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(text)))
	length := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(text), uintptr(length)*2)) != 0 {
		length++
	}
	actual := syscall.UTF16ToString(unsafe.Slice(text, length))
	wantDescriptor, err := registrationDescriptorFromSDDL(expected)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.LocalFree(syscall.Handle(wantDescriptor))
	want, err := registrationDescriptorText(wantDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	if normalizeRegistrationSecurityText(actual) != normalizeRegistrationSecurityText(want) {
		t.Fatalf("mutex owner/DACL differs from user+SYSTEM protected policy:\nwant %s\n got %s", expected, actual)
	}
}

func TestRegistrationSecurityTextCanonicalization(t *testing.T) {
	sid := "S-1-5-21-4239583824-265399229-1323058055-500"
	full := "O:" + sid + "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")"
	masked := "O:" + sid + "D:P(A;;0x1f0001;;;SY)(A;;0x1f0001;;;" + sid + ")"
	fullDescriptor, err := registrationDescriptorFromSDDL(full)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.LocalFree(syscall.Handle(fullDescriptor))
	maskedDescriptor, err := registrationDescriptorFromSDDL(masked)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.LocalFree(syscall.Handle(maskedDescriptor))
	fullText, err := registrationDescriptorText(fullDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	maskedText, err := registrationDescriptorText(maskedDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	if normalizeRegistrationSecurityText(fullText) != normalizeRegistrationSecurityText(maskedText) {
		t.Fatalf("equivalent access masks did not canonicalize:\n%s\n%s", fullText, maskedText)
	}

	// On a machine where the local Administrator account is RID 500, Windows
	// emits its well-known LA alias. Verify that alias and the full SID compare
	// identically through the OS round-trip used by production.
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	currentSID, err := user.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasSuffix(currentSID, "-500") {
		currentRID500 := "O:" + currentSID + "D:P(A;;GA;;;SY)(A;;GA;;;" + currentSID + ")"
		currentDescriptor, err := registrationDescriptorFromSDDL(currentRID500)
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.LocalFree(syscall.Handle(currentDescriptor))
		currentText, err := registrationDescriptorText(currentDescriptor)
		if err != nil {
			t.Fatal(err)
		}
		aliasDescriptor, err := registrationDescriptorFromSDDL("O:LAD:P(A;;0x1f0001;;;SY)(A;;0x1f0001;;;LA)")
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.LocalFree(syscall.Handle(aliasDescriptor))
		aliasText, err := registrationDescriptorText(aliasDescriptor)
		if err != nil {
			t.Fatal(err)
		}
		if normalizeRegistrationSecurityText(currentText) != normalizeRegistrationSecurityText(aliasText) {
			t.Fatalf("LA alias differs from full RID-500 SID:\n%s\n%s", currentText, aliasText)
		}
	}

	for _, changed := range []string{
		"O:SYD:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")",
		"O:" + sid + "D:(A;;GA;;;SY)(A;;GA;;;" + sid + ")",
		"O:" + sid + "D:NO_ACCESS_CONTROL",
		"O:" + sid + "D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")(A;;GA;;;WD)",
		"O:" + sid + "D:P(A;;GR;;;SY)(A;;GA;;;" + sid + ")",
	} {
		changedDescriptor, err := registrationDescriptorFromSDDL(changed)
		if err != nil {
			t.Fatal(err)
		}
		changedText, err := registrationDescriptorText(changedDescriptor)
		_, _ = syscall.LocalFree(syscall.Handle(changedDescriptor))
		if err != nil {
			t.Fatal(err)
		}
		if normalizeRegistrationSecurityText(fullText) == normalizeRegistrationSecurityText(changedText) {
			t.Fatalf("accepted changed registration security: %s", changedText)
		}
	}
}

func TestRegistrationMutexRefusesPermissiveExistingObject(t *testing.T) {
	for _, kind := range []string{"unprotected", "world access", "null DACL", "extra ACE"} {
		t.Run(kind, func(t *testing.T) {
			key := registrationTestKey(t)
			name, expected, err := registrationLockIdentity(key)
			if err != nil {
				t.Fatal(err)
			}
			permissive := strings.Replace(expected, "D:P", "D:", 1)
			switch kind {
			case "world access":
				permissive = strings.SplitN(expected, "D:P", 2)[0] + "D:P(A;;GA;;;WD)"
			case "null DACL":
				permissive = strings.SplitN(expected, "D:P", 2)[0] + "D:NO_ACCESS_CONTROL"
			case "extra ACE":
				permissive = expected + "(A;;GA;;;WD)"
			}
			handle, err := createRegistrationMutex(name, permissive)
			if err != nil {
				t.Fatal("create isolated permissive fixture", err)
			}
			defer syscall.CloseHandle(handle)
			called := false
			err = withRegistrationLock(key, func() error { called = true; return nil })
			if err == nil || called || !strings.Contains(err.Error(), "security differs") {
				t.Fatalf("existing permissive object was trusted: called=%v, err=%v", called, err)
			}
		})
	}
}
