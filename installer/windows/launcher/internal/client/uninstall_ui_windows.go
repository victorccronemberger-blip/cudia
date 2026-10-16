//go:build windows

package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

type wizardRemoval struct {
	Schema       int          `json:"schema"`
	Root         string       `json:"root"`
	Owner        wizardOwner  `json:"owner"`
	Payload      *removalPlan `json:"payload"`
	ResumeHelper string       `json:"resumeHelper"`
	RecoveryID   wizardFileID `json:"recoveryId"`
	Handoff      bool         `json:"handoff"`
}

func wizardUninstall(root string) error {
	u, err := newUpdater(root)
	if err != nil {
		return err
	}
	return newWizardCoordinator(u).uninstall()
}
func (w wizardCoordinator) uninstall() error {
	return w.locked(true, func() error {
		if err := refuseRunningImages(w.u.root); err != nil {
			return err
		}
		if j, err := w.readPending(""); err == nil {
			if !w.u.installActivationMatches(j.Owner.Activation) {
				return errors.New("installation is pending; cancel or finish its wizard before uninstalling")
			}
			if err = w.finishCommitted(j); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		path := filepath.Join(w.u.root, "state", "wizard-uninstall.json")
		b, err := installReadOptional(path, maxRemovalBytes)
		if err != nil {
			return err
		}
		var j wizardRemoval
		if b == nil {
			owner, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-owner.json"), maxWizardJournal)
			if err != nil {
				return err
			}
			if owner == nil {
				return w.checkUninstalled()
			}
			if err = decodeWizardOwner(owner, w.u.root, &j.Owner); err != nil {
				return err
			}
			if err = w.verifyAppFiles(j.Owner, false); err != nil {
				return err
			}
			payload, err := prepareRemoval(w.u.root)
			if err != nil {
				return err
			}
			j.Schema, j.Root, j.Payload = 1, w.u.root, payload
			j.ResumeHelper, j.RecoveryID, err = w.makeRecoveryHelper(j.Owner)
			if err != nil {
				return err
			}
			keepRecovery := false
			defer func() {
				if !keepRecovery && w.validateRecoveryHelper(j) == nil {
					_ = os.Remove(j.ResumeHelper)
					_ = os.Remove(filepath.Dir(j.ResumeHelper))
				}
			}()
			// Refuse modified known executables and uncertain PATH before deleting any
			// application payload. User-edited connection data is deliberately preserved.
			if err = w.preflightRemoval(j); err != nil {
				return err
			}
			b, err = json.Marshal(j)
			if err != nil {
				return err
			}
			if len(b) > maxRemovalBytes {
				return errors.New("native uninstall journal exceeds limit")
			}
			if err = installWriteAtomicNew(path, b); err != nil {
				return err
			}
			keepRecovery = true
			if err = w.hook("uninstall-planned"); err != nil {
				return err
			}
		} else {
			if err = decodeWizardRemoval(b, w.u.root, &j); err != nil {
				return err
			}
			if err = w.validateRecoveryHelper(j); err != nil {
				return err
			}
			if err = w.preflightRemoval(j); err != nil {
				return err
			}
		}
		if b != nil {
			if w.recoveryOutput != nil {
				*w.recoveryOutput = j.ResumeHelper
			}
			values, _, e := readWizardRegistry(w.key(j.Owner.Channel), j.Owner.Registration)
			if e != nil {
				return e
			}
			empty := true
			for _, v := range values {
				empty = empty && !v.Exists
			}
			if empty {
				absent := true
				for _, n := range []string{"bin/cudia.exe", "maintenance/launcher.exe", "state/activation.json"} {
					if _, e = os.Lstat(filepath.Join(w.u.root, filepath.FromSlash(n))); !os.IsNotExist(e) {
						absent = false
					}
				}
				if absent {
					return w.completeRemoval(j, path)
				}
			}
		}
		// Install a durable, verified retry command before deleting the installed
		// helper. The temporary image intentionally survives its own process.
		retry := wizardRemovalRegistration(j)
		registryState, registryExists, err := w.readRegisteredCleanup(j.Owner.Channel)
		if err != nil {
			return err
		}
		if !registryExists || registryState.Ticket != j.Owner.Ticket {
			return errors.New("uninstall has no matching reserved cleanup authority")
		}
		registryState.NativeRetryValues = map[string]pathSnapshot{"UninstallString": retry["UninstallString"], "QuietUninstallString": retry["QuietUninstallString"]}
		if err = w.writeRegisteredCleanup(registryState); err != nil {
			return err
		}
		for _, name := range []string{"UninstallString", "QuietUninstallString"} {
			current, _, e := readWizardRegistry(w.key(j.Owner.Channel), map[string]pathSnapshot{name: {}})
			if e != nil {
				return e
			}
			if current[name].equal(retry[name]) {
				continue
			}
			if !current[name].equal(j.Owner.Registration[name]) {
				return errors.New("uninstall retry registration was changed")
			}
			if err = writeWizardValue(w.key(j.Owner.Channel), name, retry[name]); err != nil {
				return err
			}
			if err = w.hook("uninstall-resume:" + name); err != nil {
				return err
			}
		}
		confirmed, _, err := readWizardRegistry(w.key(j.Owner.Channel), retry)
		if err != nil {
			return err
		}
		for _, name := range []string{"UninstallString", "QuietUninstallString"} {
			if !confirmed[name].equal(retry[name]) {
				return errors.New("uninstall handoff registration changed before payload removal")
			}
		}
		if !j.Handoff {
			j.Handoff = true
			b, err = json.Marshal(j)
			if err != nil {
				return err
			}
			if err = wizardWriteRemovalJournal(path, b); err != nil {
				return err
			}
		}
		if err = w.hook("uninstall-handoff"); err != nil {
			return err
		}
		if j.Payload != nil {
			files := removalInventory(*j.Payload)
			names := make([]string, 0, len(files))
			for name := range files {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				if err = removeVerifiedFile(w.u.root, name, files[name]); err != nil {
					return err
				}
				if err = w.hook("uninstall-payload:" + name); err != nil {
					return err
				}
			}
			if err = removeVerifiedFile(w.u.root, "state/activation.json", j.Payload.Activation); err != nil {
				return err
			}
		}
		for _, name := range []string{"bin/cudia.exe", "maintenance/launcher.exe"} {
			record := j.Owner.Bootstrap
			if strings.HasPrefix(name, "maintenance/") {
				record = j.Owner.Helper
			}
			if err = removeVerifiedFile(w.u.root, name, record); err != nil {
				return err
			}
			if err = w.hook("uninstall-app:" + name); err != nil {
				return err
			}
		}
		if j.Owner.Connection != nil {
			connection, err := installReadOptional(filepath.Join(w.u.root, "connection.json"), 16*1024)
			if err != nil {
				return err
			}
			if bytes.Equal(connection, j.Owner.Connection) {
				if err = installRemoveExact(filepath.Join(w.u.root, "connection.json"), j.Owner.Connection); err != nil {
					return err
				}
			}
		}
		status, err := w.path.remove(w.u.root)
		if err != nil {
			return err
		}
		if status.Pending || status.Added {
			return errors.New("PATH was changed or ownership is uncertain; preserved for manual repair")
		}
		if err = w.hook("uninstall-before-registration"); err != nil {
			return err
		}
		// Stable OS recovery takes ownership only after root cleanup. Until then
		// keep the complete native registration and verified durable retry helper.
		return w.completeRemoval(j, path)
	})
}
func decodeWizardRemoval(b []byte, root string, j *wizardRemoval) error {
	if err := exactObject(b, "schema", "root", "owner", "payload", "resumeHelper", "recoveryId", "handoff"); err != nil {
		return err
	}
	if err := strictJSON(b, j); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	for name, value := range raw {
		if name != "payload" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("null uninstall journal field")
		}
	}
	if j.Schema != 1 || j.Root != root {
		return errors.New("invalid native uninstall identity")
	}
	if err := decodeWizardOwner(raw["owner"], root, &j.Owner); err != nil {
		return err
	}
	if err := exactObject(raw["recoveryId"], "volume", "high", "low"); err != nil {
		return err
	}
	if j.Payload != nil {
		if err := exactObject(raw["payload"], "schema", "root", "state", "activation"); err != nil {
			return err
		}
		var p map[string]json.RawMessage
		_ = json.Unmarshal(raw["payload"], &p)
		if err := validateRemovalStateJSON(p["state"]); err != nil {
			return err
		}
		if err := exactObject(p["activation"], "size", "sha256"); err != nil {
			return err
		}
		if j.Payload.Schema != 1 || j.Payload.Root != root || j.Payload.Activation.Size < 1 || j.Payload.Activation.Size > maxStateBytes || !hashPattern.MatchString(j.Payload.Activation.SHA256) {
			return errors.New("invalid native uninstall payload")
		}
		if err := validateState(j.Payload.State); err != nil {
			return err
		}
	}
	return nil
}
func (w wizardCoordinator) completeRemoval(j wizardRemoval, path string) error {
	existing := filepath.Join(filepath.Dir(j.ResumeHelper), "cleanup.json")
	if p, e := w.readCleanup(existing); e == nil {
		if p.Ticket != j.Owner.Ticket {
			return errors.New("outside cleanup belongs to another generation")
		}
		if w.cleanupOutput != nil {
			*w.cleanupOutput = existing
		}
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	completion, _ := json.Marshal(j.Owner)
	if err := wizardWriteJSON(filepath.Join(w.u.root, "state", "wizard-uninstalled.json"), completion, false); err != nil {
		return err
	}
	cleanup, err := w.prepareCleanupLocked(j)
	if err != nil {
		return err
	}
	if w.cleanupOutput != nil {
		*w.cleanupOutput = cleanup
	}
	// Outside-root authority now survives removal of the application receipts.
	{
		_ = os.Remove(filepath.Join(w.u.root, "state", "wizard-owner.json"))
		_ = os.Remove(path)
	}
	return nil
}
func (w wizardCoordinator) preflightRemoval(j wizardRemoval) error {
	if err := w.validateRecoveryHelper(j); err != nil {
		return err
	}
	if err := w.verifyAppFiles(j.Owner, true); err != nil {
		return err
	}
	if j.Payload != nil {
		for name, record := range removalInventory(*j.Payload) {
			if err := verifyRemovalFile(w.u.root, name, record); err != nil {
				return err
			}
		}
		if err := verifyRemovalFile(w.u.root, "state/activation.json", j.Payload.Activation); err != nil {
			return err
		}
	}
	_, token, err := pathIdentity(w.u.root)
	if err != nil {
		return err
	}
	ownership, exists, err := readPathOwnership(w.u.root, token)
	if err != nil {
		return err
	}
	if exists && ownership.Phase == "intent" {
		return errors.New("uncertain PATH ownership; repair manually before uninstall")
	}
	current, _, err := readWizardRegistry(w.key(j.Owner.Channel), j.Owner.Registration)
	if err != nil {
		return err
	}
	for name, want := range j.Owner.Registration {
		if current[name].Exists && !current[name].equal(want) && !current[name].equal(wizardRemovalRegistration(j)[name]) {
			return errors.New("registration was modified; refusing application removal")
		}
	}
	allowed := map[string]pathSnapshot{}
	for n, v := range j.Owner.Registration {
		allowed[n] = v
	}
	state, exists, e := w.readRegisteredCleanup(j.Owner.Channel)
	if e != nil {
		return e
	}
	if exists {
		if state.Ticket != j.Owner.Ticket || state.Mode != "native" {
			return errors.New("another cleanup generation owns registration")
		}
		allowed[registryCleanupValue] = pathSnapshot{}
		allowed[registryCleanupGeneration] = pathSnapshot{}
	}
	if err = wizardRegistryShape(w.key(j.Owner.Channel), allowed); err != nil {
		return err
	}
	return nil
}
func (w wizardCoordinator) recoveryBase() (string, error) {
	base := w.recoveryRoot
	if base == "" {
		local, err := os.UserCacheDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(local, "CudiaMaintenanceRecovery")
	}
	if !filepath.IsAbs(base) || filepath.Clean(base) != base || strings.HasPrefix(base, `\\`) {
		return "", errors.New("invalid native maintenance recovery directory")
	}
	base = filepath.Join(base, digest([]byte(w.u.root)))
	if contained(w.u.root, base) || strings.EqualFold(w.u.root, base) {
		return "", errors.New("maintenance recovery directory must be outside installation")
	}
	if err := guardMaintenancePath(base); err != nil {
		return "", err
	}
	return base, nil
}
func (w wizardCoordinator) makeRecoveryHelper(owner wizardOwner) (string, wizardFileID, error) {
	return w.makeReservedHelper(owner, false)
}
func (w wizardCoordinator) validateRecoveryHelper(j wizardRemoval) error {
	base, err := w.recoveryBase()
	if err != nil {
		return err
	}
	if !filepath.IsAbs(j.ResumeHelper) || filepath.Clean(j.ResumeHelper) != j.ResumeHelper || filepath.Base(j.ResumeHelper) != "launcher.exe" || filepath.Dir(filepath.Dir(j.ResumeHelper)) != base || !strings.HasPrefix(filepath.Base(filepath.Dir(j.ResumeHelper)), "uninstall-") {
		return errors.New("uninstall recovery helper escaped its owned directory")
	}
	if err = installVerifyFile(j.ResumeHelper, j.Owner.Helper); err != nil {
		return err
	}
	id, err := wizardFileIdentity(j.ResumeHelper)
	if err != nil {
		return err
	}
	if id != j.RecoveryID {
		return errors.New("uninstall recovery helper file identity changed")
	}
	return nil
}
func wizardWriteRemovalJournal(path string, b []byte) error {
	if len(b) > maxRemovalBytes {
		return errors.New("uninstall journal exceeds limit")
	}
	// The initial large payload inventory is written with the removal limit;
	// later atomic updates retain exactly that inventory.
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "wizard-removal-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return atomicReplace(f.Name(), path)
}
func wizardRemovalRegistration(j wizardRemoval) map[string]pathSnapshot {
	out := map[string]pathSnapshot{}
	for name, value := range j.Owner.Registration {
		out[name] = value
	}
	base := `"` + j.ResumeHelper + `" installer uninstall --root "` + j.Root + `"`
	out["UninstallString"] = pathSnapshot{true, syscall.REG_SZ, pathStringBytes(base)}
	out["QuietUninstallString"] = pathSnapshot{true, syscall.REG_SZ, pathStringBytes(base + ` --quiet`)}
	return out
}
func (w wizardCoordinator) checkUninstalled() error {
	b, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-uninstalled.json"), maxWizardJournal)
	if err != nil {
		return err
	}
	if b == nil {
		return errors.New("no native Cudia ownership receipt; refusing unowned uninstall")
	}
	var owner wizardOwner
	if err = decodeWizardOwner(b, w.u.root, &owner); err != nil {
		return err
	}
	for _, name := range []string{"bin/cudia.exe", "maintenance/launcher.exe", "state/activation.json"} {
		if _, err = os.Lstat(filepath.Join(w.u.root, filepath.FromSlash(name))); !os.IsNotExist(err) {
			return errors.New("application files appeared after completed uninstall")
		}
	}
	current, _, err := readWizardRegistry(w.key(owner.Channel), owner.Registration)
	if err != nil {
		return err
	}
	p, exists, err := w.readRegisteredCleanup(owner.Channel)
	if err != nil {
		return err
	}
	for name, v := range current {
		if !v.Exists {
			continue
		}
		if !exists || p.Ticket != owner.Ticket || (!v.equal(p.NativeValues[name]) && !v.equal(p.NativeRetryValues[name])) {
			return errors.New("registration changed after application removal")
		}
	}
	return nil
}
func wizardRegistryShape(subkey string, allowed map[string]pathSnapshot) error {
	p, _ := syscall.UTF16PtrFromString(subkey)
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, p, 0, syscall.KEY_QUERY_VALUE, &key); err == syscall.ERROR_FILE_NOT_FOUND {
		return nil
	} else if err != nil {
		return err
	}
	defer syscall.RegCloseKey(key)
	var children, values uint32
	if err := syscall.RegQueryInfoKey(key, nil, nil, nil, &children, nil, nil, &values, nil, nil, nil, nil); err != nil {
		return err
	}
	if children != 0 || values > uint32(len(allowed)) {
		return errors.New("registration contains unknown data; preserving it")
	}
	enum := pathAdvapi.NewProc("RegEnumValueW")
	for i := uint32(0); i < values; i++ {
		name := make([]uint16, 16384)
		size := uint32(len(name))
		r, _, _ := enum.Call(uintptr(key), uintptr(i), uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&size)), 0, 0, 0, 0)
		if r != 0 {
			return syscall.Errno(r)
		}
		if _, ok := allowed[syscall.UTF16ToString(name[:size])]; !ok {
			return errors.New("registration contains an unknown value; preserving it")
		}
	}
	return nil
}
func deleteWizardRegistration(subkey string, want map[string]pathSnapshot) error {
	remaining := map[string]pathSnapshot{}
	for _, n := range []string{"DisplayName", "UninstallString", "QuietUninstallString"} {
		remaining[n] = want[n]
	}
	if err := wizardRegistryShape(subkey, remaining); err != nil {
		return err
	}
	current, _, err := readWizardRegistry(subkey, remaining)
	if err != nil {
		return err
	}
	for name, v := range current {
		if v.Exists && !v.equal(remaining[name]) {
			return errors.New("final uninstall registration changed")
		}
	}
	p, _ := syscall.UTF16PtrFromString(subkey)
	r, _, _ := pathAdvapi.NewProc("RegDeleteKeyW").Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(p)))
	if r != 0 && r != uintptr(syscall.ERROR_FILE_NOT_FOUND) {
		return syscall.Errno(r)
	}
	return nil
}

// The installed helper cannot delete its own Windows image. Copy only the
// verified owned helper into a new temporary directory and hand off by PID.
func launchWizardUninstall(root string, quiet bool) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	u, err := newUpdater(root)
	if err != nil {
		return err
	}
	coordinator := newWizardCoordinator(u)
	if base, e := coordinator.recoveryBase(); e == nil && filepath.Dir(filepath.Dir(self)) == base {
		if _, e = os.Stat(filepath.Join(filepath.Dir(self), "cleanup.json")); e == nil {
			return cleanupWizardUninstall(root, quiet)
		}
	}
	if err := wizardRoot(root, false); err != nil {
		return err
	}
	ownerBytes, err := installReadOptional(filepath.Join(root, "state", "wizard-owner.json"), maxWizardJournal)
	if err != nil {
		return err
	}
	var owner wizardOwner
	if err = decodeWizardOwner(ownerBytes, root, &owner); err != nil {
		return err
	}
	expected := filepath.Join(root, "maintenance", "launcher.exe")
	if !strings.EqualFold(self, expected) {
		// Apps and Features can point at the verified durable temporary helper
		// after a partial uninstall has already removed the installed executable.
		b, e := installReadOptional(filepath.Join(root, "state", "wizard-uninstall.json"), maxRemovalBytes)
		if e != nil {
			return e
		}
		var j wizardRemoval
		if e = decodeWizardRemoval(b, root, &j); e != nil {
			return e
		}
		if j.Schema != 1 || j.Root != root || !strings.EqualFold(j.ResumeHelper, self) || j.Owner.Helper != owner.Helper {
			return errors.New("uninstall must run from its recorded verified maintenance helper")
		}
		if e = installVerifyFile(self, owner.Helper); e != nil {
			return e
		}
		u, e := newUpdater(root)
		if e != nil {
			return e
		}
		if e = newWizardCoordinator(u).validateRecoveryHelper(j); e != nil {
			return e
		}
		return runWizardUninstallUI(root, self, quiet)
	}
	if err = installVerifyFile(self, owner.Helper); err != nil {
		return err
	}
	var helper string
	err = withRegistrationLock(coordinator.key(owner.Channel), func() error { var e error; helper, _, e = coordinator.makeReservedHelper(owner, true); return e })
	if err != nil {
		return err
	}
	ack, err := createNamedCleanupAck(coordinator.key(owner.Channel), uninstallAckName(owner.Ticket, uint32(os.Getpid())))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(ack)
	args := []string{"installer", "wizard-remove", "--root", root, "--parent-pid", strconv.Itoa(os.Getpid())}
	if quiet {
		args = append(args, "--quiet")
	}
	child := exec.Command(helper, args...)
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err = child.Start(); err != nil {
		return err
	}
	defer child.Process.Release()
	// Keep this parent alive until the child owns a validated wait handle.
	status, err := syscall.WaitForSingleObject(ack, 15000)
	if err != nil {
		return err
	}
	if status != syscall.WAIT_OBJECT_0 {
		return errors.New("temporary uninstaller did not acknowledge its verified parent")
	}
	return nil
}
func finishWizardUninstall(root string, parentPID uint32, quiet bool) error {
	if err := wizardRoot(root, false); err != nil {
		return err
	}
	if parentPID == 0 || parentPID == uint32(os.Getpid()) {
		return errors.New("invalid native uninstall parent")
	}
	if err := wizardVerifyParent(parentPID); err != nil {
		return err
	}
	// Validate both images before waiting. The handle grants wait/query rights
	// only; no terminate access is requested, even for an invalid supplied PID.
	b, err := installReadOptional(filepath.Join(root, "state", "wizard-owner.json"), maxWizardJournal)
	if err != nil {
		return err
	}
	var owner wizardOwner
	if err = decodeWizardOwner(b, root, &owner); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if contained(root, self) {
		return errors.New("uninstall child must run outside installation")
	}
	temp, err := maintenanceTempDir()
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(filepath.Dir(filepath.Dir(self))), temp) || !strings.HasPrefix(filepath.Base(filepath.Dir(self)), "cudia-uninstall-") {
		return errors.New("uninstall child is not in its owned temporary directory")
	}
	if err = installVerifyFile(self, owner.Helper); err != nil {
		return err
	}
	handle, err := syscall.OpenProcess(0x100000|0x1000, false, parentPID)
	if err != nil {
		return fmt.Errorf("cannot verify uninstall parent: %w", err)
	}
	defer syscall.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	result, _, queryErr := kernel32.NewProc("QueryFullProcessImageNameW").Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
	if result == 0 {
		return queryErr
	}
	image := syscall.UTF16ToString(buffer[:size])
	if !strings.EqualFold(image, filepath.Join(root, "maintenance", "launcher.exe")) {
		return errors.New("uninstall parent is not the owned installation helper")
	}
	if err = installVerifyFile(image, owner.Helper); err != nil {
		return err
	}
	ackName, _ := syscall.UTF16PtrFromString(uninstallAckName(owner.Ticket, parentPID))
	ack, _, ackErr := kernel32.NewProc("OpenEventW").Call(2, 0, uintptr(unsafe.Pointer(ackName)))
	if ack == 0 {
		return ackErr
	}
	signaled, _, ackErr := kernel32.NewProc("SetEvent").Call(ack)
	syscall.CloseHandle(syscall.Handle(ack))
	if signaled == 0 {
		return ackErr
	}
	if _, err = syscall.WaitForSingleObject(handle, syscall.INFINITE); err != nil {
		return err
	}
	return runWizardUninstallUI(root, self, quiet)
}
func wizardVerifyParent(parentPID uint32) error {
	snapshot, err := syscall.CreateToolhelp32Snapshot(2, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(snapshot)
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	err = syscall.Process32First(snapshot, &entry)
	for err == nil {
		if entry.ProcessID == uint32(os.Getpid()) {
			if entry.ParentProcessID != parentPID {
				return errors.New("uninstall PID is not this helper's actual parent")
			}
			return nil
		}
		err = syscall.Process32Next(snapshot, &entry)
	}
	return errors.New("cannot verify native uninstall parent relationship")
}
func runWizardUninstallUI(root, self string, quiet bool) error {
	if !quiet && wizardMessage("Remover CUDIA? Suas sessões, credenciais e arquivos pessoais serão preservados.", 0x4|0x20) != 6 {
		u, e := newUpdater(root)
		if e != nil {
			return e
		}
		return newWizardCoordinator(u).startCleanupTail(self, "", false, quiet, "")
	}
	u, err := newUpdater(root)
	if err != nil {
		return err
	}
	w := newWizardCoordinator(u)
	var recovery string
	var cleanup string
	w.recoveryOutput = &recovery
	w.cleanupOutput = &cleanup
	err = w.uninstall()
	if err == nil && cleanup != "" {
		err = w.cleanupRoot(cleanup)
	}
	message := ""
	if err != nil {
		message = "Não foi possível concluir a remoção. Os arquivos incertos foram preservados.\n\n" + err.Error() + "\n\nRecuperação: " + recovery
	}
	if err != nil && !isOwnedUninstallTemp(self) {
		if !quiet {
			wizardMessage(message, 0x10)
		}
		return err
	}
	if tailErr := w.startCleanupTail(self, cleanup, err == nil, quiet, message); tailErr != nil {
		combined := errors.Join(err, tailErr)
		if !quiet {
			wizardMessage("A remocao aguarda recuperacao. Os arquivos incertos foram preservados.\n\n"+combined.Error()+"\n\nRecuperacao: "+recovery, 0x10)
		}
		return combined
	}
	if quiet {
		fmt.Fprintln(os.Stderr, "bounded uninstall cleanup started; recovery authority:", cleanup)
	}
	return err
}
func wizardMessage(message string, flags uintptr) uintptr {
	text, _ := syscall.UTF16PtrFromString(message)
	caption, _ := syscall.UTF16PtrFromString("CUDIA")
	result, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), flags)
	return result
}
