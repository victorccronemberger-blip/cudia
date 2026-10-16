//go:build windows

package client

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

type cleanupTailFile struct {
	Path string      `json:"path"`
	File cleanupFile `json:"file"`
}
type cleanupParentData struct {
	Key           string          `json:"key"`
	Ticket        string          `json:"ticket"`
	ParentPID     int             `json:"parentPid"`
	ParentCreated string          `json:"parentCreated"`
	Parent        cleanupTailFile `json:"parent"`
	Ack           string          `json:"ack"`
	Quiet         bool            `json:"quiet"`
	Selected      []string        `json:"selected"`
	Final         bool            `json:"final"`
	Message       string          `json:"message"`
}

func systemPowerShell() (string, error) {
	b := make([]uint16, 32768)
	n, _, e := kernel32.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)))
	if n == 0 || n >= uintptr(len(b)) {
		return "", e
	}
	path := filepath.Join(syscall.UTF16ToString(b[:n]), "WindowsPowerShell", "v1.0", "powershell.exe")
	if err := guardMaintenancePath(path); err != nil {
		return "", err
	}
	return path, nil
}
func currentProcessCreated() (string, error) {
	var c, e, k, u syscall.Filetime
	if err := syscall.GetProcessTimes(syscall.Handle(^uintptr(0)), &c, &e, &k, &u); err != nil {
		return "", err
	}
	return strconv.FormatUint(uint64(c.HighDateTime)<<32|uint64(c.LowDateTime), 10), nil
}
func isOwnedUninstallTemp(self string) bool {
	temp, err := maintenanceTempDir()
	return err == nil && filepath.Base(self) == "launcher.exe" && strings.EqualFold(filepath.Clean(filepath.Dir(filepath.Dir(self))), temp) && strings.HasPrefix(filepath.Base(filepath.Dir(self)), "cudia-uninstall-")
}
func (w wizardCoordinator) cleanupChannel(receipt string) (string, error) {
	if w.registryChannel != "" {
		return w.registryChannel, nil
	}
	if receipt != "" {
		p, e := w.readCleanup(receipt)
		if e != nil {
			return "", e
		}
		return p.Channel, nil
	}
	for _, name := range []string{"wizard-owner.json", "wizard-uninstalled.json"} {
		b, e := installReadOptional(filepath.Join(w.u.root, "state", name), maxWizardJournal)
		if e != nil {
			return "", e
		}
		if b != nil {
			var p wizardOwner
			if e = decodeWizardOwner(b, w.u.root, &p); e != nil {
				return "", e
			}
			return p.Channel, nil
		}
	}
	return "stable", nil
}
func createCleanupAck(subkey string) (syscall.Handle, string, error) {
	nonce, err := cleanupNonce()
	if err != nil {
		return syscall.InvalidHandle, "", err
	}
	name := "Local\\Cudia-Cleanup-Ack-" + nonce
	h, err := createNamedCleanupAck(subkey, name)
	return h, name, err
}
func createNamedCleanupAck(subkey, name string) (syscall.Handle, error) {
	_, sddl, err := registrationLockIdentity(subkey)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	var descriptor uintptr
	r, _, e := registrationConvertSDDL.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if r == 0 {
		return syscall.InvalidHandle, e
	}
	defer kernel32.NewProc("LocalFree").Call(descriptor)
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	h, _, e := kernel32.NewProc("CreateEventW").Call(uintptr(unsafe.Pointer(&attributes)), 1, 0, uintptr(unsafe.Pointer(p)))
	if h == 0 {
		return syscall.InvalidHandle, e
	}
	if e == syscall.ERROR_ALREADY_EXISTS {
		syscall.CloseHandle(syscall.Handle(h))
		return syscall.InvalidHandle, errors.New("cleanup acknowledgement already exists")
	}
	return syscall.Handle(h), nil
}
func uninstallAckName(ticket string, pid uint32) string {
	return "Local\\Cudia-Uninstall-Ack-" + ticket[:32] + "-" + strconv.FormatUint(uint64(pid), 10)
}

func (w wizardCoordinator) transferCleanupLocked(channel string) (registeredCleanup, error) {
	p, exists, err := w.readRegisteredCleanup(channel)
	if err != nil {
		return p, err
	}
	if !exists || (p.RootPhase != "tail" && p.RootPhase != "superseded") {
		return p, errors.New("root cleanup has not committed its external-only phase")
	}
	normal, quiet, err := registryCleanupCommands(w.key(channel), p.Ticket)
	if err != nil {
		return p, err
	}
	commands := map[string]string{"UninstallString": normal, "QuietUninstallString": quiet}
	p.Mode = "external-remove"
	p.Handoff = false
	p.CommandRecords = map[string]fileRecord{}
	for name, command := range commands {
		b := pathStringBytes(command)
		p.CommandRecords[name] = fileRecord{int64(len(b)), digest(b)}
	}
	if err = w.writeRegisteredCleanup(p); err != nil {
		return p, err
	}
	if err = w.hook("cleanup-handoff-intent"); err != nil {
		return p, err
	}
	allowed := map[string]pathSnapshot{}
	for n, v := range p.NativeValues {
		allowed[n] = v
	}
	allowed[registryCleanupValue] = pathSnapshot{}
	allowed[registryCleanupGeneration] = pathSnapshot{}
	if err = wizardRegistryShape(w.key(channel), allowed); err != nil {
		return p, err
	}
	for _, name := range []string{"UninstallString", "QuietUninstallString"} {
		current, _, e := readWizardRegistry(w.key(channel), map[string]pathSnapshot{name: {}})
		if e != nil {
			return p, e
		}
		want := pathSnapshot{true, syscall.REG_SZ, pathStringBytes(commands[name])}
		if !current[name].equal(want) && !current[name].equal(p.NativeValues[name]) && !current[name].equal(p.NativeRetryValues[name]) {
			return p, errors.New("uninstall recovery command changed before transfer")
		}
		if !current[name].equal(want) {
			if e = writeWizardValue(w.key(channel), name, want); e != nil {
				return p, e
			}
		}
		if e = w.hook("cleanup-handoff-command:" + name); e != nil {
			return p, e
		}
	}
	current, _, err := readWizardRegistry(w.key(channel), map[string]pathSnapshot{"UninstallString": {}, "QuietUninstallString": {}})
	if err != nil {
		return p, err
	}
	for name, command := range commands {
		if !current[name].equal(pathSnapshot{true, syscall.REG_SZ, pathStringBytes(command)}) {
			return p, errors.New("cleanup command readback failed")
		}
	}
	p.Handoff = true
	if err = w.writeRegisteredCleanup(p); err != nil {
		return p, err
	}
	if err = w.hook("cleanup-handoff-complete"); err != nil {
		return p, err
	}
	return p, nil
}
func (w wizardCoordinator) startCleanupTail(self, receipt string, success, quiet bool, message string) (result error) {
	channel, err := w.cleanupChannel(receipt)
	if err != nil {
		return err
	}
	key := w.key(channel)
	parent, err := cleanupSnapshot(self, maxBootstrapBytes)
	if err != nil {
		return err
	}
	created, err := currentProcessCreated()
	if err != nil {
		return err
	}
	ack, name, err := createCleanupAck(key)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(ack)
	var state registeredCleanup
	// Covers partial transfer as well as startup/no-ACK failure. Until ACK the
	// verified executor can only be waiting for this live parent to exit.
	if success {
		defer func() {
			if result != nil && hashPattern.MatchString(state.Ticket) {
				result = errors.Join(result, withRegistrationLock(key, func() error { return w.restoreNativeCleanupLocked(state) }))
			}
		}()
	}
	err = withRegistrationLock(key, func() error {
		var exists bool
		var e error
		if success {
			state, e = w.transferCleanupLocked(channel)
			return e
		}
		state, exists, e = w.readRegisteredCleanup(channel)
		if e != nil {
			return e
		}
		if !exists {
			return errors.New("temporary helper has no durable registry reservation")
		}
		return nil
	})
	if err != nil {
		return err
	}
	selected := []string{self}
	if !success && !isOwnedUninstallTemp(self) {
		return nil
	}
	normal, quietCommand, err := registryCleanupCommands(key, state.Ticket)
	if err != nil {
		return err
	}
	command := normal
	if quiet {
		command = quietCommand
	}
	shell, err := systemPowerShell()
	if err != nil {
		return err
	}
	// The command is generated from a compile-time program and fixed key/ticket
	// data. Its JSON parent context is an environment value, never evaluated code.
	quoted := `"` + shell + `" `
	if !strings.HasPrefix(command, quoted) {
		return errors.New("cleanup command does not select fixed System32 PowerShell")
	}
	marker := "-EncodedCommand "
	i := strings.LastIndex(command, marker)
	if i < 0 {
		return errors.New("invalid static cleanup command")
	}
	encoded := strings.TrimSpace(command[i+len(marker):])
	if strings.ContainsAny(encoded, " \"'\r\n") {
		return errors.New("invalid encoded static program")
	}
	data := cleanupParentData{key, state.Ticket, os.Getpid(), created, cleanupTailFile{self, parent}, name, quiet, selected, success, message}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	child := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "CUDIA_CLEANUP_PARENT_DATA=") {
			child.Env = append(child.Env, entry)
		}
	}
	child.Env = append(child.Env, "CUDIA_CLEANUP_PARENT_DATA="+base64.StdEncoding.EncodeToString(b))
	if w.tailLog != "" {
		log, e := os.OpenFile(w.tailLog, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		defer log.Close()
		child.Stdout = log
		child.Stderr = log
	}
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err = w.hook("cleanup-before-executor-start"); err != nil {
		return err
	}
	if err = child.Start(); err != nil {
		return err
	}
	defer child.Process.Release()
	if err = w.hook("cleanup-executor-started"); err != nil {
		return err
	}
	status, err := syscall.WaitForSingleObject(ack, 15000)
	if err != nil {
		return err
	}
	if status != syscall.WAIT_OBJECT_0 {
		return fmt.Errorf("cleanup executor did not acknowledge verified parent; registry authority retained in HKCU\\%s", key)
	}
	if err = w.hook("cleanup-executor-acknowledged"); err != nil {
		return err
	}
	return nil
}
func cleanupWizardUninstall(root string, quiet bool) error {
	u, err := newUpdater(root)
	if err != nil {
		return err
	}
	w := newWizardCoordinator(u)
	self, err := os.Executable()
	if err != nil {
		return err
	}
	receipt := filepath.Join(filepath.Dir(self), "cleanup.json")
	p, err := w.readCleanup(receipt)
	if err != nil {
		return err
	}
	if !strings.EqualFold(p.Helper, self) {
		return errors.New("cleanup must run from its recorded recovery helper")
	}
	if err = installVerifyFile(self, p.HelperFile.Record); err != nil {
		return err
	}
	id, err := wizardFileIdentity(self)
	if err != nil {
		return err
	}
	if id != p.HelperFile.ID {
		return errors.New("cleanup helper identity changed")
	}
	w.registryChannel = p.Channel
	if err = w.cleanupRoot(receipt); err != nil {
		return err
	}
	return w.startCleanupTail(self, receipt, true, quiet, "")
}

func (w wizardCoordinator) restoreNativeCleanupLocked(expected registeredCleanup) error {
	p, exists, err := w.readRegisteredCleanup(expected.Channel)
	if err != nil {
		return err
	}
	if !exists || p.Ticket != expected.Ticket {
		return errors.New("cleanup authority changed before native recovery restoration")
	}
	if p.Mode != "external-remove" {
		return nil
	}
	closeInventory, err := validateNativeCleanupInventory(p)
	if err != nil {
		return err
	}
	defer closeInventory()
	allowed := map[string]pathSnapshot{}
	for name, value := range p.NativeValues {
		allowed[name] = value
	}
	allowed[registryCleanupValue] = pathSnapshot{}
	allowed[registryCleanupGeneration] = pathSnapshot{}
	if err = wizardRegistryShape(w.key(p.Channel), allowed); err != nil {
		return err
	}
	originals, _, err := readWizardRegistry(w.key(p.Channel), p.NativeValues)
	if err != nil {
		return err
	}
	for name, value := range originals {
		if name != "UninstallString" && name != "QuietUninstallString" && !value.equal(p.NativeValues[name]) {
			return errors.New("native cleanup registration changed before restoration")
		}
	}

	normal, quiet, err := registryCleanupCommands(w.key(p.Channel), p.Ticket)
	if err != nil {
		return err
	}
	commands := map[string]string{"UninstallString": normal, "QuietUninstallString": quiet}
	for name, command := range commands {
		current, _, e := readWizardRegistry(w.key(p.Channel), map[string]pathSnapshot{name: {}})
		if e != nil {
			return e
		}
		if !current[name].equal(pathSnapshot{true, syscall.REG_SZ, pathStringBytes(command)}) && !current[name].equal(p.NativeRetryValues[name]) {
			return errors.New("cleanup command changed before native retry restoration")
		}
		if !p.NativeRetryValues[name].Exists {
			return errors.New("durable native retry command is missing")
		}
	}
	p.Handoff = false
	if err = w.writeRegisteredCleanup(p); err != nil {
		return err
	}
	if err = w.hook("cleanup-native-restore-intent"); err != nil {
		return err
	}
	for _, name := range []string{"UninstallString", "QuietUninstallString"} {
		if err = writeWizardValue(w.key(p.Channel), name, p.NativeRetryValues[name]); err != nil {
			return err
		}
		current, _, e := readWizardRegistry(w.key(p.Channel), map[string]pathSnapshot{name: {}})
		if e != nil {
			return e
		}
		if !current[name].equal(p.NativeRetryValues[name]) {
			return errors.New("native retry command write readback failed")
		}
		if err = w.hook("cleanup-native-restored:" + name); err != nil {
			return err
		}
	}
	p.Mode = "native"
	p.CommandRecords = map[string]fileRecord{}
	if err = w.writeRegisteredCleanup(p); err != nil {
		return err
	}
	values, _, err := readWizardRegistry(w.key(p.Channel), p.NativeRetryValues)
	if err != nil {
		return err
	}
	for name, v := range values {
		if !v.equal(p.NativeRetryValues[name]) {
			return errors.New("native retry command restoration readback failed")
		}
	}
	return w.hook("cleanup-native-restore-complete")
}

// Recovery changes only registry commands. Hold every present inventory object
// against writes/renames until the native checkpoint has been flushed.
func validateNativeCleanupInventory(p registeredCleanup) (func(), error) {
	held := []syscall.Handle{}
	closeAll := func() {
		for _, h := range held {
			syscall.CloseHandle(h)
		}
	}
	failure := func(err error) (func(), error) { closeAll(); return nil, err }
	open := func(path string, directory bool) (syscall.Handle, error) {
		if err := guardMaintenancePath(path); err != nil {
			return syscall.InvalidHandle, err
		}
		volume, err := syscall.UTF16PtrFromString(filepath.VolumeName(path) + `\`)
		if err != nil {
			return syscall.InvalidHandle, err
		}
		drive, _, _ := kernel32.NewProc("GetDriveTypeW").Call(uintptr(unsafe.Pointer(volume)))
		if drive != 2 && drive != 3 && drive != 6 {
			return syscall.InvalidHandle, errors.New("native cleanup requires a local drive")
		}

		name, err := syscall.UTF16PtrFromString(path)
		if err != nil {
			return syscall.InvalidHandle, err
		}
		access := uint32(syscall.GENERIC_READ)
		flags := uint32(syscall.FILE_FLAG_OPEN_REPARSE_POINT)
		if directory {
			access = 0x80
			flags |= syscall.FILE_FLAG_BACKUP_SEMANTICS
		}
		h, err := syscall.CreateFile(name, access, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, flags, 0)
		if err != nil {
			return syscall.InvalidHandle, err
		}
		var info syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			syscall.CloseHandle(h)
			if err == nil {
				err = errors.New("native cleanup path is redirected")
			}
			return syscall.InvalidHandle, err
		}
		buffer := make([]uint16, 32768)
		n, _, e := kernel32.NewProc("GetFinalPathNameByHandleW").Call(uintptr(h), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
		if n == 0 || n >= uintptr(len(buffer)) {
			syscall.CloseHandle(h)
			return syscall.InvalidHandle, e
		}
		actual := strings.TrimPrefix(syscall.UTF16ToString(buffer[:n]), `\\?\`)
		if !strings.EqualFold(actual, path) {
			syscall.CloseHandle(h)
			return syscall.InvalidHandle, errors.New("native cleanup path has a filesystem alias")
		}
		held = append(held, h)
		return h, nil
	}
	ancestors := map[string]bool{}
	holdAncestors := func(path string) error {
		for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
			if !ancestors[strings.ToUpper(dir)] {
				if _, err := open(dir, true); err != nil {
					return err
				}
				ancestors[strings.ToUpper(dir)] = true
			}
			if filepath.Dir(dir) == dir {
				return nil
			}
		}
	}
	present := map[string]registeredCleanupFile{}
	current := ""
	for _, f := range p.Files {
		if _, err := os.Lstat(f.Path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return failure(err)
		}
		if f.State != "confirmed" {
			return failure(errors.New("present native cleanup reservation is uncertain"))
		}
		if err := holdAncestors(f.Path); err != nil {
			return failure(err)
		}
		h, err := open(f.Path, false)
		if err != nil {
			return failure(err)
		}
		if err = cleanupValidateHandle(h, cleanupFile{f.Record, f.ID}); err != nil {
			return failure(err)
		}
		present[f.Path] = f
		if f.Kind == "durable-helper" {
			base := `"` + f.Path + `" installer uninstall --root "` + p.Root + `"`
			if p.NativeRetryValues["UninstallString"].equal(pathSnapshot{true, syscall.REG_SZ, pathStringBytes(base)}) && p.NativeRetryValues["QuietUninstallString"].equal(pathSnapshot{true, syscall.REG_SZ, pathStringBytes(base + ` --quiet`)}) {
				if current != "" {
					return failure(errors.New("multiple current native cleanup helpers"))
				}
				current = f.Path
			}
		}
	}
	if current == "" {
		return failure(errors.New("current native cleanup helper is missing or unbound"))
	}
	receipt, ok := present[filepath.Join(filepath.Dir(current), "cleanup.json")]
	if !ok || receipt.Kind != "root-receipt" {
		return failure(errors.New("current native helper has no paired cleanup receipt"))
	}
	for _, d := range p.Directories {
		if _, err := os.Lstat(d.Path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return failure(err)
		}
		if d.State != "confirmed" {
			return failure(errors.New("present native cleanup directory reservation is uncertain"))
		}
		if err := holdAncestors(d.Path); err != nil {
			return failure(err)
		}
		h, err := open(d.Path, true)
		if err != nil {
			return failure(err)
		}
		id, info, err := cleanupIdentity(h)
		if err != nil {
			return failure(err)
		}
		if id != d.ID || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return failure(errors.New("native cleanup directory identity changed"))
		}
	}
	return closeAll, nil
}
