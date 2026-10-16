//go:build windows

package client

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

const maxCleanupReceipt = 2 * 1024 * 1024

type cleanupFile struct {
	Record fileRecord   `json:"record"`
	ID     wizardFileID `json:"id"`
}
type cleanupReceipt struct {
	Schema      int                     `json:"schema"`
	Root        string                  `json:"root"`
	Ticket      string                  `json:"ticket"`
	Channel     string                  `json:"channel"`
	Phase       string                  `json:"phase"`
	RootID      wizardFileID            `json:"rootId"`
	Metadata    map[string]cleanupFile  `json:"metadata"`
	Locks       map[string]cleanupFile  `json:"locks"`
	Directories map[string]wizardFileID `json:"directories"`
	Helper      string                  `json:"helper"`
	HelperFile  cleanupFile             `json:"helperFile"`
}

var cleanupSetInfo = kernel32.NewProc("SetFileInformationByHandle")
var errCleanupSuperseded = errors.New("cleanup superseded by a new installation")

func cleanupIdentity(handle syscall.Handle) (wizardFileID, syscall.ByHandleFileInformation, error) {
	var i syscall.ByHandleFileInformation
	err := syscall.GetFileInformationByHandle(handle, &i)
	return wizardFileID{i.VolumeSerialNumber, i.FileIndexHigh, i.FileIndexLow}, i, err
}
func cleanupOpen(path string, directory bool, exclusive bool) (syscall.Handle, error) {
	if err := guardMaintenancePath(path); err != nil {
		return syscall.InvalidHandle, err
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return syscall.InvalidHandle, err
	}
	access := uint32(0x10000 | 0x80)
	flags := uint32(syscall.FILE_FLAG_OPEN_REPARSE_POINT)
	share := uint32(0)
	if directory {
		flags |= syscall.FILE_FLAG_BACKUP_SEMANTICS
		share = 7
	} else {
		access |= syscall.GENERIC_READ
	}
	if !exclusive && !directory {
		share = 7
	}
	return syscall.CreateFile(p, access, share, nil, syscall.OPEN_EXISTING, flags, 0)
}
func cleanupDirectoryIdentity(path string) (wizardFileID, error) {
	h, err := cleanupOpen(path, true, false)
	if err != nil {
		return wizardFileID{}, err
	}
	defer syscall.CloseHandle(h)
	id, i, err := cleanupIdentity(h)
	if err == nil && (i.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || i.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0) {
		err = errors.New("cleanup directory is redirected or not a directory")
	}
	return id, err
}
func cleanupSnapshot(path string, max int64) (cleanupFile, error) {
	r, err := removalFileRecord(path, max)
	if err != nil {
		return cleanupFile{}, err
	}
	id, err := wizardFileIdentity(path)
	return cleanupFile{r, id}, err
}
func cleanupDispose(handle syscall.Handle) error {
	b := byte(1)
	r, _, err := cleanupSetInfo.Call(uintptr(handle), 4, uintptr(unsafe.Pointer(&b)), 1)
	if r == 0 {
		return err
	}
	return nil
}
func cleanupValidateHandle(h syscall.Handle, want cleanupFile) error {
	id, i, err := cleanupIdentity(h)
	if err != nil {
		return err
	}
	if id != want.ID || i.NumberOfLinks != 1 || i.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return errors.New("cleanup file identity, links or attributes changed")
	}
	if int64(uint64(i.FileSizeHigh)<<32|uint64(i.FileSizeLow)) != want.Record.Size {
		return errors.New("cleanup file size changed")
	}
	hash := sha256.New()
	buf := make([]byte, 65536)
	var total int64
	for {
		var n uint32
		e := syscall.ReadFile(h, buf, &n, nil)
		if e != nil && e != syscall.ERROR_HANDLE_EOF {
			return e
		}
		total += int64(n)
		if total > want.Record.Size {
			return errors.New("cleanup file grew")
		}
		_, _ = hash.Write(buf[:n])
		if n == 0 || e == syscall.ERROR_HANDLE_EOF {
			break
		}
	}
	if total != want.Record.Size || hex.EncodeToString(hash.Sum(nil)) != want.Record.SHA256 {
		return errors.New("cleanup file bytes changed")
	}
	return nil
}
func (w wizardCoordinator) prepareCleanupLocked(j wizardRemoval) (string, error) {
	receiptPath := filepath.Join(filepath.Dir(j.ResumeHelper), "cleanup.json")
	if b, err := installReadOptional(receiptPath, maxCleanupReceipt); err != nil {
		return "", err
	} else if b != nil {
		p, err := w.readCleanup(receiptPath)
		if err != nil {
			return "", err
		}
		if p.Ticket != j.Owner.Ticket {
			return "", errors.New("cleanup receipt belongs to another generation")
		}
		return receiptPath, nil
	}
	p := cleanupReceipt{Schema: 1, Root: w.u.root, Ticket: j.Owner.Ticket, Channel: j.Owner.Channel, Phase: "root-files", Metadata: map[string]cleanupFile{}, Locks: map[string]cleanupFile{}, Directories: map[string]wizardFileID{}, Helper: j.ResumeHelper, HelperFile: cleanupFile{j.Owner.Helper, j.RecoveryID}}
	var err error
	p.RootID, err = cleanupDirectoryIdentity(w.u.root)
	if err != nil {
		return "", err
	}
	if err = w.checkCleanupGeneration(p, false); err != nil {
		return "", err
	}
	_, token, err := pathIdentity(w.u.root)
	if err != nil {
		return "", err
	}
	ownership, exists, err := readPathOwnership(w.u.root, token)
	if err != nil {
		return "", err
	}
	if exists && (ownership.Phase != "removed" && ownership.Phase != "unowned") {
		return "", errors.New("PATH metadata is still owned or uncertain; preserving it")
	}
	for _, name := range []string{"state/wizard-owner.json", "state/wizard-uninstall.json", "state/wizard-uninstalled.json", "state/path-ownership.json"} {
		path := filepath.Join(w.u.root, filepath.FromSlash(name))
		if _, err = os.Lstat(path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return "", err
		}
		p.Metadata[name], err = cleanupSnapshot(path, maxRemovalBytes)
		if err != nil {
			return "", err
		}
	}
	if metadata, owned := automaticCacheMetadata(w.u.root); owned {
		p.Metadata["state/update-check.json"] = metadata
	}
	for _, name := range []string{"state/lifetime.lock", "state/update.lock", "state/path-ownership.lock"} {
		lockPath := filepath.Join(w.u.root, filepath.FromSlash(name))
		info, e := os.Stat(lockPath)
		if e != nil {
			return "", e
		}
		if info.Size() != 0 {
			return "", errors.New("nonempty maintenance lock preserved")
		}
		id, e := wizardFileIdentity(lockPath)
		if e != nil {
			return "", e
		}
		p.Locks[name] = cleanupFile{fileRecord{0, digest(nil)}, id}
	}
	dirs := map[string]bool{".": true, "state": true, "state/staging": true, "versions": true, "bin": true, "maintenance": true}
	if j.Payload != nil {
		for name := range removalInventory(*j.Payload) {
			for dir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(name))); dir != "."; dir = filepath.ToSlash(filepath.Dir(filepath.FromSlash(dir))) {
				dirs[dir] = true
			}
		}
	}
	for dir := range dirs {
		id, err := cleanupDirectoryIdentity(filepath.Join(w.u.root, filepath.FromSlash(dir)))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		p.Directories[dir] = id
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	if len(b) > maxCleanupReceipt {
		return "", errors.New("cleanup receipt exceeds limit")
	}
	registryState, exists, err := w.readRegisteredCleanup(j.Owner.Channel)
	if err != nil {
		return "", err
	}
	if !exists || registryState.Ticket != j.Owner.Ticket {
		return "", errors.New("cleanup receipt has no matching registry authority")
	}
	if err = w.reserveCleanupFile(&registryState, receiptPath, "root-receipt", fileRecord{int64(len(b)), digest(b)}); err != nil {
		return "", err
	}
	if err = installWriteAtomicNew(receiptPath, b); err != nil {
		return "", err
	}
	if err = w.confirmCleanupFile(&registryState, receiptPath); err != nil {
		return "", err
	}
	registryState.RootPhase = "root-files"
	if err = w.writeRegisteredCleanup(registryState); err != nil {
		return "", err
	}
	return receiptPath, nil
}
func (w wizardCoordinator) readCleanup(path string) (cleanupReceipt, error) {
	var p cleanupReceipt
	b, err := installReadOptional(path, maxCleanupReceipt)
	if err != nil {
		return p, err
	}
	if b == nil {
		return p, os.ErrNotExist
	}
	if err = exactObject(b, "schema", "root", "ticket", "channel", "phase", "rootId", "metadata", "locks", "directories", "helper", "helperFile"); err != nil {
		return p, err
	}
	if err = strictJSON(b, &p); err != nil {
		return p, err
	}
	if p.Schema != 1 || p.Root != w.u.root || !hashPattern.MatchString(p.Ticket) || !validChannel(p.Channel) || (p.Phase != "root-files" && p.Phase != "locks-only" && p.Phase != "tail" && p.Phase != "superseded") || len(p.Metadata) > 5 || len(p.Locks) != 3 || len(p.Directories) > maxFiles*128 {
		return p, errors.New("invalid cleanup receipt identity")
	}
	base, err := w.recoveryBase()
	if err != nil {
		return p, err
	}
	if filepath.Base(path) != "cleanup.json" || filepath.Dir(path) != filepath.Dir(p.Helper) || filepath.Dir(filepath.Dir(p.Helper)) != base || filepath.Base(p.Helper) != "launcher.exe" || !strings.HasPrefix(filepath.Base(filepath.Dir(p.Helper)), "uninstall-") {
		return p, errors.New("cleanup receipt escaped its fixed owned recovery directory")
	}
	allowed := map[string]bool{"state/wizard-owner.json": true, "state/wizard-uninstall.json": true, "state/wizard-uninstalled.json": true, "state/path-ownership.json": true, "state/update-check.json": true}
	for name, f := range p.Metadata {
		if !allowed[name] || f.Record.Size < 0 || f.Record.Size > maxRemovalBytes || !hashPattern.MatchString(f.Record.SHA256) {
			return p, errors.New("invalid cleanup metadata inventory")
		}
	}
	for _, name := range []string{"state/lifetime.lock", "state/update.lock", "state/path-ownership.lock"} {
		f, ok := p.Locks[name]
		if !ok || f.Record.Size != 0 || f.Record.SHA256 != digest(nil) {
			return p, errors.New("invalid cleanup lock inventory")
		}
	}
	for name := range p.Directories {
		if name != "." && (!validPath(name) || !(name == "state" || name == "state/staging" || name == "versions" || name == "bin" || name == "maintenance" || strings.HasPrefix(name, "versions/"))) {
			return p, errors.New("unexpected cleanup directory")
		}
	}
	if p.HelperFile.Record.Size < 1 || p.HelperFile.Record.Size > maxBootstrapBytes || !hashPattern.MatchString(p.HelperFile.Record.SHA256) {
		return p, errors.New("invalid recovery helper receipt")
	}
	state, exists, e := w.readRegisteredCleanup(p.Channel)
	if e != nil {
		return p, e
	}
	if !exists || state.Ticket != p.Ticket {
		return p, errors.New("outside cleanup receipt has no matching registry generation")
	}
	receiptOwned, helperOwned := false, false
	for _, f := range state.Files {
		if f.Path == path && f.Kind == "root-receipt" && f.State == "confirmed" {
			snap, e := cleanupSnapshot(path, maxCleanupReceipt)
			if e != nil {
				return p, e
			}
			if snap.Record != f.Record || snap.ID != f.ID {
				return p, errors.New("outside cleanup receipt identity changed")
			}
			receiptOwned = true
		}
		if f.Path == p.Helper && f.Kind == "durable-helper" && f.State == "confirmed" && f.Record == p.HelperFile.Record && f.ID == p.HelperFile.ID {
			helperOwned = true
		}
	}
	if !receiptOwned || !helperOwned {
		return p, errors.New("cleanup receipt inventory is not confirmed")
	}
	if state.RootPhase != "none" {
		p.Phase = state.RootPhase
	}
	return p, nil
}
func (w wizardCoordinator) writeCleanup(path string, p cleanupReceipt) error {
	state, exists, err := w.readRegisteredCleanup(p.Channel)
	if err != nil {
		return err
	}
	if !exists || state.Ticket != p.Ticket {
		return errors.New("cleanup phase has no registry authority")
	}
	state.RootPhase = p.Phase
	return w.writeRegisteredCleanup(state)
}
func (w wizardCoordinator) checkCleanupGeneration(p cleanupReceipt, allowMissing bool) error {
	id, err := cleanupDirectoryIdentity(p.Root)
	if os.IsNotExist(err) && allowMissing {
		return nil
	}
	if err != nil {
		return err
	}
	if id != p.RootID {
		return fmt.Errorf("%w: root directory identity changed", errCleanupSuperseded)
	}
	for _, name := range []string{"state/activation.json", "state/install-pending.json", "state/wizard-pending.json", "state/wizard-intent.json", "state/uninstall-pending.json", "bin/cudia.exe", "maintenance/launcher.exe"} {
		if _, err = os.Lstat(filepath.Join(p.Root, filepath.FromSlash(name))); err == nil {
			return fmt.Errorf("%w: new or unfinished installation appeared", errCleanupSuperseded)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	b, err := installReadOptional(filepath.Join(p.Root, "state", "wizard-owner.json"), maxWizardJournal)
	if err != nil {
		return err
	}
	if b != nil {
		var o wizardOwner
		if err = decodeWizardOwner(b, p.Root, &o); err != nil {
			return err
		}
		if o.Ticket != p.Ticket {
			return fmt.Errorf("%w: new installation owner appeared", errCleanupSuperseded)
		}
	}
	state, exists, err := w.readRegisteredCleanup(p.Channel)
	if err != nil {
		return err
	}
	if !exists || state.Ticket != p.Ticket {
		return fmt.Errorf("%w: registry cleanup generation changed", errCleanupSuperseded)
	}
	values, _, err := readWizardRegistry(w.key(p.Channel), state.NativeValues)
	if err != nil {
		return err
	}
	for name, v := range values {
		if !v.equal(state.NativeValues[name]) && !v.equal(state.NativeRetryValues[name]) {
			return fmt.Errorf("%w: application registration changed", errCleanupSuperseded)
		}
	}
	return nil
}
func (w wizardCoordinator) cleanupRoot(path string) error {
	p, err := w.readCleanup(path)
	if err != nil {
		return err
	}
	return withRegistrationLock(w.key(p.Channel), func() error { return w.cleanupRootLocked(path, p) })
}
func (w wizardCoordinator) cleanupRootLocked(path string, p cleanupReceipt) error {
	var err error
	if p.Phase == "tail" || p.Phase == "superseded" {
		return nil
	}
	if err = w.checkCleanupGeneration(p, true); err != nil {
		if errors.Is(err, errCleanupSuperseded) {
			p.Phase = "superseded"
			return w.writeCleanup(path, p)
		}
		return err
	}
	if _, err = os.Stat(p.Root); os.IsNotExist(err) {
		p.Phase = "tail"
		return w.writeCleanup(path, p)
	} else if err != nil {
		return err
	}
	// All original gates are mandatory in phase A. Phase B is persisted before
	// any lock is armed, and has no metadata-file deletion capability at all.
	gates := map[string]syscall.Handle{}
	defer func() {
		for _, h := range gates {
			syscall.CloseHandle(h)
		}
	}()
	for _, name := range []string{"state/lifetime.lock", "state/update.lock", "state/path-ownership.lock"} {
		h, e := cleanupOpen(filepath.Join(p.Root, filepath.FromSlash(name)), false, true)
		if os.IsNotExist(e) && p.Phase == "locks-only" {
			continue
		}
		if e != nil {
			return fmt.Errorf("cleanup gate %s: %w", name, e)
		}
		if e = cleanupValidateHandle(h, p.Locks[name]); e != nil {
			syscall.CloseHandle(h)
			return e
		}
		gates[name] = h
	}
	if err = w.checkCleanupGeneration(p, false); err != nil {
		if errors.Is(err, errCleanupSuperseded) {
			p.Phase = "superseded"
			return w.writeCleanup(path, p)
		}
		return err
	}
	directories := map[string]syscall.Handle{}
	defer func() {
		for _, h := range directories {
			syscall.CloseHandle(h)
		}
	}()
	for name, id := range p.Directories {
		h, e := cleanupOpen(filepath.Join(p.Root, filepath.FromSlash(name)), true, false)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return e
		}
		actual, i, e := cleanupIdentity(h)
		if e != nil || actual != id || i.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			syscall.CloseHandle(h)
			return errors.New("cleanup directory identity changed")
		}
		directories[name] = h
	}
	if p.Phase == "root-files" {
		metadata := map[string]syscall.Handle{}
		defer func() {
			for _, h := range metadata {
				syscall.CloseHandle(h)
			}
		}()
		names := make([]string, 0, len(p.Metadata))
		for n := range p.Metadata {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, name := range names {
			h, e := cleanupOpen(filepath.Join(p.Root, filepath.FromSlash(name)), false, true)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil {
				return e
			}
			if e = cleanupValidateHandle(h, p.Metadata[name]); e != nil {
				syscall.CloseHandle(h)
				return e
			}
			metadata[name] = h
		}
		for _, name := range names {
			h, ok := metadata[name]
			if !ok {
				continue
			}
			if err = cleanupDispose(h); err != nil {
				return err
			}
			syscall.CloseHandle(h)
			delete(metadata, name)
			if err = w.hook("cleanup-metadata:" + name); err != nil {
				return err
			}
		}
		p.Phase = "locks-only"
		if err = w.hook("cleanup-before-locks-phase"); err != nil {
			return err
		}
		if err = w.writeCleanup(path, p); err != nil {
			return err
		}
		if err = w.hook("cleanup-root-files-removed"); err != nil {
			return err
		}
	}
	for _, name := range []string{"state/path-ownership.lock", "state/update.lock", "state/lifetime.lock"} {
		if h, ok := gates[name]; ok {
			if err = cleanupDispose(h); err != nil {
				return err
			}
			if err = w.hook("cleanup-lock-armed:" + name); err != nil {
				return err
			}
		}
	}
	// From this point on, no root file is opened or deleted by name. Captured
	// directory handles can dispose only an empty old directory atomically.
	for name, h := range gates {
		syscall.CloseHandle(h)
		delete(gates, name)
		if err = w.hook("cleanup-gate-closed:" + name); err != nil {
			return err
		}
	}
	if err = w.hook("cleanup-all-gates-closed"); err != nil {
		return err
	}
	names := make([]string, 0, len(directories))
	for n := range directories {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
	for _, name := range names {
		h := directories[name]
		if err = w.hook("cleanup-directory:" + name); err != nil {
			return err
		}
		e := cleanupDispose(h)
		if e != nil && e != syscall.Errno(145) {
			return e
		}
		syscall.CloseHandle(h)
		delete(directories, name)
	}
	p.Phase = "tail"
	return w.writeCleanup(path, p)
}
