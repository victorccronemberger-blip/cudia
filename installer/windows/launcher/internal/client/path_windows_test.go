//go:build windows

package client

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// Every registry access in these tests uses a fresh, privately owned key. Public
// APIs are called only in the explicit negative tests with preconditions locked
// against entry, before any production registry access or notification.
func newPathTest(t *testing.T) (pathManager, string) {
	t.Helper()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	parent := `Software\Cudia\InstallerTests\` + hex.EncodeToString(id[:])
	m := pathManager{registrySubkey: parent + `\Environment`, notify: func() {}}
	root := filepath.Join(t.TempDir(), "Cúdia 空间")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// RegDeleteKeyW is nonrecursive. Only these two exact fresh keys belong
		// to this test; never remove InstallerTests, Cudia, or HKCU\Environment.
		remove := pathAdvapi.NewProc("RegDeleteKeyW")
		for _, key := range []string{m.registrySubkey, parent} {
			if !strings.HasPrefix(key, `Software\Cudia\InstallerTests\`+hex.EncodeToString(id[:])) {
				t.Fatal("unsafe test registry cleanup")
			}
			name, err := syscall.UTF16PtrFromString(key)
			if err != nil {
				t.Error(err)
				continue
			}
			r, _, _ := remove.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(name)))
			if r != 0 && r != uintptr(syscall.ERROR_FILE_NOT_FOUND) {
				t.Errorf("cleanup isolated test key: %v", syscall.Errno(r))
			}
		}
	})
	return m, root
}

func setPathTest(t *testing.T, m pathManager, value string, kind uint32) pathSnapshot {
	t.Helper()
	s := pathSnapshot{Exists: true, Type: kind, Data: pathStringBytes(value)}
	if err := writeUserPath(m.registrySubkey, s); err != nil {
		t.Fatal(err)
	}
	return s
}

func getPathTest(t *testing.T, m pathManager) pathSnapshot {
	t.Helper()
	s, err := readUserPath(m.registrySubkey)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func pathValueTest(t *testing.T, s pathSnapshot) string {
	t.Helper()
	value, err := s.value()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestUserPathPreservesTokensTypeAndRepairOwnership(t *testing.T) {
	m, root := newPathTest(t)
	processPath := os.Getenv("PATH")
	original := setPathTest(t, m, `%SystemRoot%\system32;;"C:\Odd Space";尾巴\;`, syscall.REG_EXPAND_SZ)
	notifications := 0
	m.notify = func() { notifications++ }
	status, err := m.add(root)
	if err != nil || status.Status != "added" || !status.Added || !status.Changed || status.Pending {
		t.Fatalf("add: %+v %v", status, err)
	}
	current := getPathTest(t, m)
	if current.Type != original.Type || pathValueTest(t, current) != pathValueTest(t, original)+";"+filepath.Join(root, "bin") {
		t.Fatalf("PATH token/type changed: %+v", current)
	}
	status, err = m.add(root)
	if err != nil || status.Status != "already-owned" || !status.Added || status.Changed {
		t.Fatalf("repair lost ownership: %+v %v", status, err)
	}
	unknown := filepath.Join(root, "state", "unknown-user-data.txt")
	if err := os.WriteFile(unknown, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	status, err = m.remove(root)
	if err != nil || status.Status != "removed" || status.Added || !status.Changed {
		t.Fatalf("remove: %+v %v", status, err)
	}
	if !getPathTest(t, m).equal(original) {
		t.Fatal("original PATH snapshot not restored")
	}
	if b, err := os.ReadFile(unknown); err != nil || string(b) != "keep" {
		t.Fatalf("unknown user data changed: %q %v", b, err)
	}
	if notifications != 2 || os.Getenv("PATH") != processPath {
		t.Fatal("unexpected notification count or process PATH mutation")
	}
	status, err = m.remove(root)
	if err != nil || status.Status != "not-owned" || status.Changed {
		t.Fatalf("repeat removal: %+v %v", status, err)
	}
}

func TestUserPathAbsentEmptyAndStringTypes(t *testing.T) {
	for _, kind := range []uint32{0, syscall.REG_SZ, syscall.REG_EXPAND_SZ} {
		t.Run(fmt.Sprint(kind), func(t *testing.T) {
			m, root := newPathTest(t)
			original := pathSnapshot{}
			if kind != 0 {
				original = setPathTest(t, m, "", kind)
			}
			if status, err := m.add(root); err != nil || !status.Added {
				t.Fatalf("add: %+v %v", status, err)
			}
			if kind != 0 && getPathTest(t, m).Type != kind {
				t.Fatal("string type changed")
			}
			want := filepath.Join(root, "bin")
			if kind != 0 {
				want = ";" + want
			}
			if pathValueTest(t, getPathTest(t, m)) != want {
				t.Fatal("empty PATH token lost")
			}
			if status, err := m.remove(root); err != nil || !status.Changed {
				t.Fatalf("remove: %+v %v", status, err)
			}
			if !getPathTest(t, m).equal(original) {
				t.Fatal("absent/empty/type distinction not preserved")
			}
		})
	}
}

func TestUserPathNeverClaimsPreexistingEquivalent(t *testing.T) {
	for _, variation := range []string{"quoted", "case", "trailing", "forward", "environment"} {
		t.Run(variation, func(t *testing.T) {
			m, root := newPathTest(t)
			token := filepath.Join(root, "bin")
			switch variation {
			case "quoted":
				token = `"` + token + `"`
			case "case":
				token = strings.ToUpper(token)
			case "trailing":
				token += `\`
			case "forward":
				token = strings.ReplaceAll(token, `\`, "/")
			case "environment":
				t.Setenv("CUDIA_PATH_TEST_ROOT", root)
				token = `"%CUDIA_PATH_TEST_ROOT%\bin\"`
			}
			original := setPathTest(t, m, `C:\Other;`+token+`;C:\Last`, syscall.REG_EXPAND_SZ)
			status, err := m.add(root)
			if err != nil || status.Status != "already-present" || status.Added || status.Pending || status.Changed {
				t.Fatalf("claimed preexisting token: %+v %v", status, err)
			}
			status, err = m.remove(root)
			if err != nil || status.Status != "not-owned" || !getPathTest(t, m).equal(original) {
				t.Fatalf("removed preexisting token: %+v %v", status, err)
			}
		})
	}
}

func TestUserPathInterruptedAddPreservesUncertainEntry(t *testing.T) {
	for _, point := range []string{"before-write", "after-write"} {
		t.Run(point, func(t *testing.T) {
			m, root := newPathTest(t)
			original := setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
			failure := func() error { return errors.New("injected failure") }
			if point == "before-write" {
				m.beforeRegistryWrite = failure
			} else {
				m.beforeCommit = failure
			}
			status, err := m.add(root)
			if err == nil || !status.Pending {
				t.Fatalf("missing uncertain status: %+v %v", status, err)
			}
			after := getPathTest(t, m)
			if point == "before-write" && !after.equal(original) {
				t.Fatal("failed write changed PATH")
			}
			if point == "after-write" && after.equal(original) {
				t.Fatal("test did not reach registry mutation")
			}
			m.beforeRegistryWrite, m.beforeCommit = nil, nil
			for _, operation := range []func(string) (UserPathStatus, error){m.add, m.remove} {
				status, err := operation(root)
				if err != nil || !status.Pending || !getPathTest(t, m).equal(after) {
					t.Fatalf("uncertain operation changed PATH: %+v %v", status, err)
				}
			}
		})
	}
}

func TestUserPathRetryPreservesConcurrentChanges(t *testing.T) {
	m, root := newPathTest(t)
	setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
	calls := 0
	m.beforeCompare = func(attempt int) {
		calls++
		if attempt == 0 {
			setPathTest(t, m, `C:\Concurrent;%SystemRoot%\bin;`, syscall.REG_EXPAND_SZ)
		}
	}
	status, err := m.add(root)
	if err != nil || !status.Added || calls != 2 {
		t.Fatalf("retry: %+v %v calls=%d", status, err, calls)
	}
	current := getPathTest(t, m)
	if current.Type != syscall.REG_EXPAND_SZ || pathValueTest(t, current) != `C:\Concurrent;%SystemRoot%\bin;;`+filepath.Join(root, "bin") {
		t.Fatal("concurrent PATH change lost")
	}
	// A fresh concurrent append during removal also survives the retry.
	m.beforeCompare = func(attempt int) {
		if attempt == 0 {
			setPathTest(t, m, pathValueTest(t, current)+`;C:\Later`, syscall.REG_SZ)
		}
	}
	status, err = m.remove(root)
	if err != nil || status.Status != "removed" {
		t.Fatalf("remove retry: %+v %v", status, err)
	}
	current = getPathTest(t, m)
	if current.Type != syscall.REG_SZ || pathValueTest(t, current) != `C:\Concurrent;%SystemRoot%\bin;;C:\Later` {
		t.Fatalf("other PATH tokens/type lost: %q", pathValueTest(t, current))
	}
}

func TestUserPathRetriesAreBounded(t *testing.T) {
	m, root := newPathTest(t)
	setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
	calls := 0
	m.beforeCompare = func(attempt int) {
		calls++
		setPathTest(t, m, fmt.Sprintf(`C:\Writer%d`, attempt), syscall.REG_SZ)
	}
	status, err := m.add(root)
	if err == nil || status.Changed || calls != pathAttempts || strings.Contains(pathValueTest(t, getPathTest(t, m)), filepath.Join(root, "bin")) {
		t.Fatalf("unbounded retry or overwrite: %+v %v calls=%d", status, err, calls)
	}
}

func TestUserPathRemovalPreservesAmbiguousOrEditedToken(t *testing.T) {
	for _, variation := range []string{"duplicate", "equivalent-duplicate", "case-edit", "quote-edit", "absent"} {
		t.Run(variation, func(t *testing.T) {
			m, root := newPathTest(t)
			setPathTest(t, m, `C:\Other`, syscall.REG_SZ)
			if _, err := m.add(root); err != nil {
				t.Fatal(err)
			}
			token := filepath.Join(root, "bin")
			value := `C:\Other;` + token
			switch variation {
			case "duplicate":
				value += ";" + token
			case "equivalent-duplicate":
				value += `;"` + strings.ToUpper(token) + `\"`
			case "case-edit":
				value = `C:\Other;` + strings.ToUpper(token)
			case "quote-edit":
				value = `C:\Other;"` + token + `"`
			case "absent":
				value = `C:\Other;C:\Replacement`
			}
			changed := setPathTest(t, m, value, syscall.REG_EXPAND_SZ)
			status, err := m.remove(root)
			if err != nil || status.Status != "preserved-changed" || status.Changed || !getPathTest(t, m).equal(changed) {
				t.Fatalf("ambiguous token removed: %+v %v", status, err)
			}
		})
	}
}

func TestUserPathInterruptedRemovalIsNeverRetried(t *testing.T) {
	m, root := newPathTest(t)
	setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
	if _, err := m.add(root); err != nil {
		t.Fatal(err)
	}
	m.beforeCommit = func() error { return errors.New("injected crash after removal") }
	if status, err := m.remove(root); err == nil || !status.Pending {
		t.Fatalf("remove failure: %+v %v", status, err)
	}
	// Someone subsequently added the same spelling. An interrupted removal
	// must never mistake that new token for the previous owned token.
	current := setPathTest(t, m, `C:\Original;`+filepath.Join(root, "bin"), syscall.REG_SZ)
	m.beforeCommit = nil
	for _, operation := range []func(string) (UserPathStatus, error){m.remove, m.add} {
		if status, err := operation(root); err != nil || !status.Pending || !getPathTest(t, m).equal(current) {
			t.Fatalf("recovered uncertain removal unsafely: %+v %v", status, err)
		}
	}
}

func TestUserPathJournalFailuresDoNotMutateRegistry(t *testing.T) {
	for _, variation := range []string{"unknown-field", "truncated", "oversized", "wrong-root", "directory"} {
		t.Run(variation, func(t *testing.T) {
			m, root := newPathTest(t)
			original := setPathTest(t, m, `C:\Existing`, syscall.REG_EXPAND_SZ)
			if err := os.Mkdir(filepath.Join(root, "state"), 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "state", "path-ownership.json")
			var data []byte
			switch variation {
			case "unknown-field":
				data = []byte(`{"unrecognizedUserData":"keep"}`)
			case "truncated":
				data = []byte(`{"schema":`)
			case "oversized":
				data = []byte(strings.Repeat("x", maxPathOwnershipBytes+1))
			case "wrong-root":
				after := pathSnapshot{true, original.Type, pathStringBytes(`C:\Existing;` + filepath.Join(root, "bin"))}
				data, _ = json.Marshal(pathOwnership{1, root + "-wrong", filepath.Join(root, "bin"), "owned", "add", true, original, after})
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if variation != "directory" {
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, operation := range []func(string) (UserPathStatus, error){m.add, m.remove} {
				if status, err := operation(root); err == nil || status.Changed || !getPathTest(t, m).equal(original) {
					t.Fatalf("journal failure changed PATH: %+v %v", status, err)
				}
			}
			if variation != "directory" {
				if b, err := os.ReadFile(path); err != nil || string(b) != string(data) {
					t.Fatal("unknown or invalid journal overwritten")
				}
			}
		})
	}
}

func TestUserPathCannotCommitOwnershipAfterFileFailure(t *testing.T) {
	m, root := newPathTest(t)
	setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
	journal := filepath.Join(root, "state", "path-ownership.json")
	m.beforeCommit = func() error {
		// Force the actual atomic replacement to fail after the registry write.
		if err := os.Remove(journal); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(journal, 0700); err != nil {
			t.Fatal(err)
		}
		return nil
	}
	if status, err := m.add(root); err == nil || !status.Pending {
		t.Fatalf("file failure not pending: %+v %v", status, err)
	}
	current := getPathTest(t, m)
	m.beforeCommit = nil
	if _, err := m.remove(root); err == nil || !getPathTest(t, m).equal(current) {
		t.Fatal("file failure permitted removal")
	}
}

func TestUserPathIntentMustPersistBeforeRegistryMutation(t *testing.T) {
	m, root := newPathTest(t)
	original := setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
	m.beforeCompare = func(int) {
		if err := os.Mkdir(filepath.Join(root, "state", "path-ownership.json"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if status, err := m.add(root); err == nil || status.Changed || !getPathTest(t, m).equal(original) {
		t.Fatalf("mutated PATH before intent persisted: %+v %v", status, err)
	}
}

func TestUserPathStrictOwnershipEvidence(t *testing.T) {
	for _, variation := range []string{"null-added", "null-exists", "null-data", "duplicate-field", "wrong-token", "false-owner", "wrong-phase", "unknown-snapshot-field"} {
		t.Run(variation, func(t *testing.T) {
			m, root := newPathTest(t)
			setPathTest(t, m, `C:\Original`, syscall.REG_SZ)
			if _, err := m.add(root); err != nil {
				t.Fatal(err)
			}
			current := getPathTest(t, m)
			journal := filepath.Join(root, "state", "path-ownership.json")
			data, err := os.ReadFile(journal)
			if err != nil {
				t.Fatal(err)
			}
			var record map[string]json.RawMessage
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatal(err)
			}
			switch variation {
			case "null-added":
				record["added"] = json.RawMessage("null")
			case "null-exists", "null-data", "unknown-snapshot-field":
				var snapshot map[string]json.RawMessage
				if err := json.Unmarshal(record["before"], &snapshot); err != nil {
					t.Fatal(err)
				}
				if variation == "null-exists" {
					snapshot["exists"] = json.RawMessage("null")
				} else if variation == "null-data" {
					snapshot["data"] = json.RawMessage("null")
				} else {
					snapshot["userNote"] = json.RawMessage(`"keep"`)
				}
				record["before"], _ = json.Marshal(snapshot)
			case "wrong-token":
				record["token"] = json.RawMessage(`"C:\\Other"`)
			case "false-owner":
				record["added"] = json.RawMessage("false")
			case "wrong-phase":
				record["operation"] = json.RawMessage(`"remove"`)
			}
			data, _ = json.Marshal(record)
			if variation == "duplicate-field" {
				data = append([]byte(`{"schema":1,`), data[1:]...)
			}
			if err := os.WriteFile(journal, data, 0600); err != nil {
				t.Fatal(err)
			}
			for _, operation := range []func(string) (UserPathStatus, error){m.add, m.remove} {
				if _, err := operation(root); err == nil || !getPathTest(t, m).equal(current) {
					t.Fatal("invalid ownership evidence allowed a registry change")
				}
			}
		})
	}
}

func TestUserPathRejectsUnsafeInstallationRoots(t *testing.T) {
	m, _ := newPathTest(t)
	for _, root := range []string{"relative", `C:\`, `\\server\share\`, `C:\has;separator`, `C:\has"quote`, `C:\has%expansion%`} {
		if _, err := m.add(root); err == nil {
			t.Errorf("accepted unsafe root %q", root)
		}
	}
	if getPathTest(t, m).Exists {
		t.Fatal("invalid root mutated registry")
	}
}

func TestUserPathProductionRejectsMaintenanceLocksBeforeRegistryAccess(t *testing.T) {
	for _, blocked := range []string{"lifetime", "update"} {
		t.Run(blocked, func(t *testing.T) {
			_, root := newPathTest(t)
			if err := os.Mkdir(filepath.Join(root, "state"), 0700); err != nil {
				t.Fatal(err)
			}
			if blocked == "lifetime" {
				lease, err := acquireLifetime(root, true)
				if err != nil {
					t.Fatal(err)
				}
				defer lease.close()
			} else {
				lock, err := acquireLock(root)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.close()
			}
			// The held native lock guarantees both calls return before the
			// fixed-key production manager is constructed or invoked.
			for _, operation := range []func(string) (UserPathStatus, error){AddUserPath, RemoveUserPath} {
				status, err := operation(root)
				if err == nil || status.Changed || status.Pending {
					t.Fatalf("public API bypassed %s lock: %+v %v", blocked, status, err)
				}
				want := "another installation update is in progress"
				if blocked == "lifetime" {
					want = "Cudia is running or installation maintenance is in progress"
				}
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("public API failed at unexpected stage: %v", err)
				}
			}
			if _, err := os.Lstat(filepath.Join(root, "state", "path-ownership.json")); !os.IsNotExist(err) {
				t.Fatalf("blocked public API reached PATH ownership state: %v", err)
			}
		})
	}
}
