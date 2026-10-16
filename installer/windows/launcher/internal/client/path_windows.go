//go:build windows

package client

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const maxPathOwnershipBytes = 512 * 1024
const maxUserPathBytes = 65536
const pathAttempts = 3

var pathAdvapi = syscall.NewLazyDLL("advapi32.dll")
var pathRegCreateKeyEx = pathAdvapi.NewProc("RegCreateKeyExW")
var pathRegSetValueEx = pathAdvapi.NewProc("RegSetValueExW")
var pathRegDeleteValue = pathAdvapi.NewProc("RegDeleteValueW")
var pathRegFlushKey = pathAdvapi.NewProc("RegFlushKey")
var pathExpandEnvironmentStrings = kernel32.NewProc("ExpandEnvironmentStringsW")
var pathSendMessageTimeout = syscall.NewLazyDLL("user32.dll").NewProc("SendMessageTimeoutW")

// UserPathStatus describes registry persistence, not the environment inherited by
// this process. Pending requires attention: an interrupted write has uncertain
// ownership, so subsequent operations deliberately preserve its PATH entry.
type UserPathStatus struct {
	Status  string `json:"status"`
	Added   bool   `json:"added"`
	Changed bool   `json:"changed"`
	Pending bool   `json:"pending"`
}

// AddUserPath adds root/bin to the current user's persistent PATH. No process
// environment, machine PATH, shell command, or caller-selected key is involved.
// Callers must not already hold the installation's update.lock.
func AddUserPath(root string) (UserPathStatus, error) {
	return changeUserPath(root, false)
}

// RemoveUserPath removes only a uniquely identifiable, committed owned token.
// Callers must not already hold the installation's update.lock.
func RemoveUserPath(root string) (UserPathStatus, error) {
	return changeUserPath(root, true)
}

func changeUserPath(root string, remove bool) (UserPathStatus, error) {
	lease, err := acquireLifetime(root, false)
	if err != nil {
		return UserPathStatus{}, err
	}
	defer lease.close()
	// Keep the maintenance check and registry mutation together against other
	// installer operations. The manager uses its separate ownership-file lock.
	lock, err := acquireLock(root)
	if err != nil {
		return UserPathStatus{}, err
	}
	defer lock.close()
	if err := checkPendingMaintenance(root, true); err != nil {
		return UserPathStatus{}, err
	}
	manager := pathManager{registrySubkey: `Environment`, notify: notifyUserPath}
	if remove {
		return manager.remove(root)
	}
	return manager.add(root)
}

// The key and failure hooks are private so integration tests can use isolated
// HKCU keys. Production entry points above always select HKCU\Environment.
type pathManager struct {
	registrySubkey      string
	notify              func()
	beforeCompare       func(int)
	beforeRegistryWrite func() error
	beforeCommit        func() error
}

type pathSnapshot struct {
	Exists bool   `json:"exists"`
	Type   uint32 `json:"type"`
	Data   []byte `json:"data"`
}

type pathOwnership struct {
	Schema    int          `json:"schema"`
	Root      string       `json:"root"`
	Token     string       `json:"token"`
	Phase     string       `json:"phase"`
	Operation string       `json:"operation"`
	Added     bool         `json:"added"`
	Before    pathSnapshot `json:"before"`
	After     pathSnapshot `json:"after"`
}

func (m pathManager) add(root string) (UserPathStatus, error) {
	root, token, err := pathIdentity(root)
	if err != nil {
		return UserPathStatus{}, err
	}
	l, err := lockPathOwnership(root)
	if err != nil {
		return UserPathStatus{}, err
	}
	defer l.close()
	record, exists, err := readPathOwnership(root, token)
	if err != nil {
		return UserPathStatus{}, err
	}
	if exists && record.Phase == "intent" {
		return UserPathStatus{Status: "preserved-uncertain", Added: record.Added, Pending: true}, nil
	}
	for attempt := 0; attempt < pathAttempts; attempt++ {
		before, err := readUserPath(m.registrySubkey)
		if err != nil {
			return UserPathStatus{}, err
		}
		value, _ := before.value()
		if hasEquivalentPath(value, token) {
			if exists && record.Phase == "owned" && record.Added {
				return UserPathStatus{Status: "already-owned", Added: true}, nil
			}
			return UserPathStatus{Status: "already-present"}, nil
		}
		// Losing an owned token does not grant ownership of a later user's token.
		// A fresh append below creates a new journal with a new exact snapshot.
		after := before
		after.Exists = true
		if !before.Exists {
			after.Type = syscall.REG_EXPAND_SZ
		}
		if before.Exists {
			value += ";"
		}
		after.Data = pathStringBytes(value + token)
		if len(after.Data) > maxUserPathBytes {
			return UserPathStatus{}, errors.New("user PATH exceeds its size limit")
		}
		if m.beforeCompare != nil {
			m.beforeCompare(attempt)
		}
		check, err := readUserPath(m.registrySubkey)
		if err != nil {
			return UserPathStatus{}, err
		}
		if !before.equal(check) {
			continue
		}
		record = pathOwnership{1, root, token, "intent", "add", false, before, after}
		if err := savePathOwnership(root, record); err != nil {
			return UserPathStatus{}, err
		}
		// There is no registry compare-and-swap. Recheck after durable intent to
		// reduce the race window; an uncertain result is never adopted as owned.
		check, err = readUserPath(m.registrySubkey)
		if err != nil {
			return pathPending(record), err
		}
		if !before.equal(check) {
			record.Phase = "unowned"
			if err := savePathOwnership(root, record); err != nil {
				return pathPending(record), err
			}
			continue
		}
		if err := m.write(after); err != nil {
			return pathPending(record), err
		}
		if m.notify != nil {
			m.notify()
		}
		check, err = readUserPath(m.registrySubkey)
		if err != nil || !after.equal(check) {
			if err == nil {
				err = errors.New("user PATH changed during update; ownership is uncertain")
			}
			return pathPending(record), err
		}
		if m.beforeCommit != nil {
			if err := m.beforeCommit(); err != nil {
				return pathPending(record), err
			}
		}
		record.Phase, record.Added = "owned", true
		if err := savePathOwnership(root, record); err != nil {
			return pathPending(record), err
		}
		return UserPathStatus{Status: "added", Added: true, Changed: true}, nil
	}
	return UserPathStatus{}, errors.New("user PATH kept changing; retry the installer")
}

func (m pathManager) remove(root string) (UserPathStatus, error) {
	root, token, err := pathIdentity(root)
	if err != nil {
		return UserPathStatus{}, err
	}
	l, err := lockPathOwnership(root)
	if err != nil {
		return UserPathStatus{}, err
	}
	defer l.close()
	record, exists, err := readPathOwnership(root, token)
	if err != nil {
		return UserPathStatus{}, err
	}
	if !exists || !record.Added || record.Phase == "removed" || record.Phase == "unowned" {
		if exists && record.Phase == "intent" {
			return pathPending(record), nil
		}
		return UserPathStatus{Status: "not-owned"}, nil
	}
	if record.Phase == "intent" {
		return pathPending(record), nil
	}
	for attempt := 0; attempt < pathAttempts; attempt++ {
		before, err := readUserPath(m.registrySubkey)
		if err != nil {
			return UserPathStatus{}, err
		}
		value, _ := before.value()
		parts := strings.Split(value, ";")
		index, exact, equivalent := -1, 0, 0
		for i, part := range parts {
			if part == token {
				exact++
				index = i
			}
			if equivalentPath(part, token) {
				equivalent++
			}
		}
		if exact != 1 || equivalent != 1 {
			return UserPathStatus{Status: "preserved-changed", Added: true}, nil
		}
		after := before
		if before.equal(record.After) {
			after = record.Before
		} else {
			after.Data = pathStringBytes(strings.Join(append(parts[:index:index], parts[index+1:]...), ";"))
		}
		if m.beforeCompare != nil {
			m.beforeCompare(attempt)
		}
		check, err := readUserPath(m.registrySubkey)
		if err != nil {
			return UserPathStatus{}, err
		}
		if !before.equal(check) {
			continue
		}
		intent := record
		intent.Phase, intent.Operation = "intent", "remove"
		// Keep the original addition snapshots as evidence of token ownership.
		if err := savePathOwnership(root, intent); err != nil {
			return UserPathStatus{}, err
		}
		check, err = readUserPath(m.registrySubkey)
		if err != nil {
			return pathPending(intent), err
		}
		if !before.equal(check) {
			if err := savePathOwnership(root, record); err != nil {
				return pathPending(intent), err
			}
			continue
		}
		if err := m.write(after); err != nil {
			return pathPending(intent), err
		}
		if m.notify != nil {
			m.notify()
		}
		if m.beforeCommit != nil {
			if err := m.beforeCommit(); err != nil {
				return pathPending(intent), err
			}
		}
		record.Phase, record.Operation, record.Added = "removed", "remove", false
		if err := savePathOwnership(root, record); err != nil {
			return pathPending(intent), err
		}
		return UserPathStatus{Status: "removed", Changed: true}, nil
	}
	return UserPathStatus{}, errors.New("user PATH kept changing; retry removal")
}

func pathPending(record pathOwnership) UserPathStatus {
	return UserPathStatus{Status: "preserved-uncertain", Added: record.Added, Pending: true}
}

func pathIdentity(root string) (string, string, error) {
	if !filepath.IsAbs(root) || strings.ContainsAny(root, ";\"%\x00") {
		return "", "", errors.New("PATH installation root must be an absolute path without PATH metacharacters")
	}
	root = filepath.Clean(root)
	if filepath.Dir(root) == root || strings.TrimRight(root, `\/`) == filepath.VolumeName(root) {
		return "", "", errors.New("PATH installation root must not be a volume root")
	}
	if err := guardPath(root); err != nil {
		return "", "", err
	}
	return root, filepath.Join(root, "bin"), nil
}

func lockPathOwnership(root string) (*updateLock, error) {
	dir := filepath.Join(root, "state")
	if err := guardPath(dir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "path-ownership.lock")
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
		return nil, errors.New("another user PATH operation is in progress")
	}
	return l, nil
}

func readPathOwnership(root, token string) (pathOwnership, bool, error) {
	var record pathOwnership
	path := filepath.Join(root, "state", "path-ownership.json")
	if err := guardPath(path); err != nil {
		return record, false, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	defer f.Close()
	b, err := readCapped(f, maxPathOwnershipBytes)
	if err != nil {
		return record, false, err
	}
	if err := exactObject(b, "schema", "root", "token", "phase", "operation", "added", "before", "after"); err != nil {
		return record, false, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(jsonSource(b), &raw); err != nil {
		return record, false, err
	}
	for name, value := range raw {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return record, false, fmt.Errorf("null PATH ownership field: %s", name)
		}
	}
	for _, name := range []string{"before", "after"} {
		if err := exactObject(raw[name], "exists", "type", "data"); err != nil {
			return record, false, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw[name], &fields); err != nil {
			return record, false, err
		}
		if bytes.Equal(bytes.TrimSpace(fields["exists"]), []byte("null")) || bytes.Equal(bytes.TrimSpace(fields["type"]), []byte("null")) {
			return record, false, errors.New("null PATH ownership snapshot field")
		}
	}
	if err := strictJSON(b, &record); err != nil {
		return record, false, err
	}
	legalPhase := record.Operation == "add" && (record.Phase == "intent" || record.Phase == "owned" || record.Phase == "unowned") || record.Operation == "remove" && (record.Phase == "intent" || record.Phase == "removed")
	if record.Schema != 1 || record.Root != root || record.Token != token || !legalPhase {
		return record, false, errors.New("invalid PATH ownership identity")
	}
	before, err := record.Before.value()
	if err != nil {
		return record, false, err
	}
	if _, err := record.After.value(); err != nil {
		return record, false, err
	}
	if record.Before.Exists {
		before += ";"
	}
	expectedType := record.Before.Type
	if !record.Before.Exists {
		expectedType = syscall.REG_EXPAND_SZ
	}
	if !record.After.Exists || record.After.Type != expectedType || !bytes.Equal(record.After.Data, pathStringBytes(before+token)) || hasEquivalentPath(strings.TrimSuffix(before, ";"), token) || record.Added != (record.Phase == "owned" || record.Phase == "intent" && record.Operation == "remove") {
		return record, false, errors.New("invalid PATH ownership evidence")
	}
	return record, true, nil
}

func savePathOwnership(root string, record pathOwnership) error {
	b, err := json.MarshalIndent(record, "", "  ")
	if err != nil || len(b) > maxPathOwnershipBytes {
		return errors.New("PATH ownership journal exceeds size limit")
	}
	dir := filepath.Join(root, "state")
	if err := guardPath(dir); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "path-ownership-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	to := filepath.Join(dir, "path-ownership.json")
	if err := guardPath(to); err != nil {
		return err
	}
	return atomicReplace(f.Name(), to)
}

func (s pathSnapshot) equal(other pathSnapshot) bool {
	return s.Exists == other.Exists && s.Type == other.Type && bytes.Equal(s.Data, other.Data)
}

func (s pathSnapshot) value() (string, error) {
	if !s.Exists {
		if s.Type != 0 || len(s.Data) != 0 {
			return "", errors.New("invalid absent PATH snapshot")
		}
		return "", nil
	}
	if (s.Type != syscall.REG_SZ && s.Type != syscall.REG_EXPAND_SZ) || s.Data == nil || len(s.Data) > maxUserPathBytes || len(s.Data)%2 != 0 {
		return "", errors.New("unsupported user PATH registry value")
	}
	words := make([]uint16, len(s.Data)/2)
	for i := range words {
		words[i] = binary.LittleEndian.Uint16(s.Data[2*i:])
	}
	if len(words) > 0 && words[len(words)-1] == 0 {
		words = words[:len(words)-1]
	}
	for i := 0; i < len(words); i++ {
		if words[i] == 0 {
			return "", errors.New("user PATH contains an embedded NUL")
		}
		if words[i] >= 0xd800 && words[i] <= 0xdbff {
			if i+1 == len(words) || words[i+1] < 0xdc00 || words[i+1] > 0xdfff {
				return "", errors.New("user PATH contains invalid UTF-16")
			}
			i++
			continue
		}
		if words[i] >= 0xdc00 && words[i] <= 0xdfff {
			return "", errors.New("user PATH contains invalid UTF-16")
		}
	}
	return string(utf16.Decode(words)), nil
}

func pathStringBytes(value string) []byte {
	words := append(utf16.Encode([]rune(value)), 0)
	b := make([]byte, len(words)*2)
	for i, word := range words {
		binary.LittleEndian.PutUint16(b[2*i:], word)
	}
	return b
}

func hasEquivalentPath(value, token string) bool {
	for _, part := range strings.Split(value, ";") {
		if equivalentPath(part, token) {
			return true
		}
	}
	return false
}

func equivalentPath(value, token string) bool {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		value = value[1 : len(value)-1]
	}
	if value == "" {
		return false
	}
	// Expansion is for comparison only. The actual value and other tokens are
	// never expanded or normalized when written back to the registry.
	source, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		return false
	}
	n, _, _ := pathExpandEnvironmentStrings.Call(uintptr(unsafe.Pointer(source)), 0, 0)
	if n == 0 || n > maxUserPathBytes/2 {
		return false
	}
	out := make([]uint16, n)
	written, _, _ := pathExpandEnvironmentStrings.Call(uintptr(unsafe.Pointer(source)), uintptr(unsafe.Pointer(&out[0])), n)
	if written == 0 || written > n {
		return false
	}
	value = strings.ReplaceAll(syscall.UTF16ToString(out), "/", `\`)
	return filepath.IsAbs(value) && strings.EqualFold(filepath.Clean(value), filepath.Clean(token))
}

func readUserPath(subkey string) (pathSnapshot, error) {
	var snapshot pathSnapshot
	name, err := syscall.UTF16PtrFromString(subkey)
	if err != nil {
		return snapshot, err
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, name, 0, syscall.KEY_QUERY_VALUE, &key); err != nil {
		if err == syscall.ERROR_FILE_NOT_FOUND {
			return snapshot, nil
		}
		return snapshot, err
	}
	defer syscall.RegCloseKey(key)
	valueName, _ := syscall.UTF16PtrFromString("Path")
	for attempt := 0; attempt < pathAttempts; attempt++ {
		var size uint32
		err := syscall.RegQueryValueEx(key, valueName, nil, &snapshot.Type, nil, &size)
		if err == syscall.ERROR_FILE_NOT_FOUND {
			return pathSnapshot{}, nil
		}
		if err != nil {
			return pathSnapshot{}, err
		}
		if size > maxUserPathBytes {
			return pathSnapshot{}, errors.New("user PATH registry value exceeds size limit")
		}
		snapshot.Data = make([]byte, size+2)
		err = syscall.RegQueryValueEx(key, valueName, nil, &snapshot.Type, &snapshot.Data[0], &size)
		if err == syscall.ERROR_MORE_DATA {
			continue
		}
		if err != nil {
			return pathSnapshot{}, err
		}
		snapshot.Exists, snapshot.Data = true, snapshot.Data[:size]
		if _, err := snapshot.value(); err != nil {
			return pathSnapshot{}, err
		}
		return snapshot, nil
	}
	return pathSnapshot{}, errors.New("user PATH changed while reading")
}

func (m pathManager) write(snapshot pathSnapshot) error {
	if m.beforeRegistryWrite != nil {
		if err := m.beforeRegistryWrite(); err != nil {
			return err
		}
	}
	return writeUserPath(m.registrySubkey, snapshot)
}

func writeUserPath(subkey string, snapshot pathSnapshot) error {
	if _, err := snapshot.value(); err != nil {
		return err
	}
	name, err := syscall.UTF16PtrFromString(subkey)
	if err != nil {
		return err
	}
	var key syscall.Handle
	var disposition uint32
	r, _, _ := pathRegCreateKeyEx.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(name)), 0, 0, 0, syscall.KEY_SET_VALUE, 0, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&disposition)))
	if r != 0 {
		return fmt.Errorf("open user PATH: %w", syscall.Errno(r))
	}
	defer syscall.RegCloseKey(key)
	valueName, _ := syscall.UTF16PtrFromString("Path")
	if !snapshot.Exists {
		r, _, _ = pathRegDeleteValue.Call(uintptr(key), uintptr(unsafe.Pointer(valueName)))
		if r == uintptr(syscall.ERROR_FILE_NOT_FOUND) {
			return nil
		}
	} else {
		var data uintptr
		if len(snapshot.Data) > 0 {
			data = uintptr(unsafe.Pointer(&snapshot.Data[0]))
		}
		r, _, _ = pathRegSetValueEx.Call(uintptr(key), uintptr(unsafe.Pointer(valueName)), 0, uintptr(snapshot.Type), data, uintptr(len(snapshot.Data)))
	}
	if r != 0 {
		return fmt.Errorf("write user PATH: %w", syscall.Errno(r))
	}
	// Flush before committing ownership. A reported flush failure leaves intent,
	// because the registry mutation may already have occurred.
	r, _, _ = pathRegFlushKey.Call(uintptr(key))
	if r != 0 {
		return fmt.Errorf("flush user PATH: %w", syscall.Errno(r))
	}
	return nil
}

func notifyUserPath() {
	name, _ := syscall.UTF16PtrFromString("Environment")
	var result uintptr
	// SMTO_ABORTIFHUNG | SMTO_BLOCK, 200 ms timeout; best effort only.
	pathSendMessageTimeout.Call(0xffff, 0x001a, 0, uintptr(unsafe.Pointer(name)), 0x2|0x1, 200, uintptr(unsafe.Pointer(&result)))
}
