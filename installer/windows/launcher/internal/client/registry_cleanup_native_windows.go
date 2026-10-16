//go:build windows

package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const maxRegistryCleanup = 32768
const registryCleanupValue = "CudiaCleanup"
const registryCleanupGeneration = "CudiaCleanupGeneration"

type registeredCleanupFile struct {
	Path   string       `json:"path"`
	Kind   string       `json:"kind"`
	State  string       `json:"state"`
	Record fileRecord   `json:"record"`
	ID     wizardFileID `json:"id"`
}
type registeredCleanupDirectory struct {
	Path  string       `json:"path"`
	State string       `json:"state"`
	ID    wizardFileID `json:"id"`
}
type registeredCleanup struct {
	Schema            int                          `json:"schema"`
	Root              string                       `json:"root"`
	Ticket            string                       `json:"ticket"`
	Channel           string                       `json:"channel"`
	Mode              string                       `json:"mode"`
	RootPhase         string                       `json:"rootPhase"`
	Handoff           bool                         `json:"handoff"`
	Files             []registeredCleanupFile      `json:"files"`
	Directories       []registeredCleanupDirectory `json:"directories"`
	NativeValues      map[string]pathSnapshot      `json:"nativeValues"`
	NativeRetryValues map[string]pathSnapshot      `json:"nativeRetryValues"`
	CommandRecords    map[string]fileRecord        `json:"commandRecords"`
}

func (w wizardCoordinator) readRegisteredCleanup(channel string) (registeredCleanup, bool, error) {
	var p registeredCleanup
	values, _, err := readWizardRegistry(w.key(channel), map[string]pathSnapshot{registryCleanupValue: {}, registryCleanupGeneration: {}})
	if err != nil {
		return p, false, err
	}
	value := values[registryCleanupValue]
	if !value.Exists {
		if values[registryCleanupGeneration].Exists {
			return p, false, errors.New("cleanup generation has no typed authority")
		}
		return p, false, nil
	}
	if value.Type != syscall.REG_BINARY || len(value.Data) > maxRegistryCleanup {
		return p, true, errors.New("unsupported or oversized registry cleanup authority")
	}
	b := value.Data
	if err = exactObject(b, "schema", "root", "ticket", "channel", "mode", "rootPhase", "handoff", "files", "directories", "nativeValues", "nativeRetryValues", "commandRecords"); err != nil {
		return p, true, err
	}
	if err = strictJSON(b, &p); err != nil {
		return p, true, err
	}
	if p.RootPhase != "none" && p.RootPhase != "root-files" && p.RootPhase != "locks-only" && p.RootPhase != "tail" && p.RootPhase != "superseded" {
		return p, true, errors.New("invalid registry cleanup root phase")
	}
	if p.Mode == "native" && (p.Handoff || len(p.CommandRecords) != 0) {
		return p, true, errors.New("invalid native cleanup handoff")
	}
	if p.Schema != 1 || p.Root != w.u.root || p.Channel != channel || !hashPattern.MatchString(p.Ticket) || (p.Mode != "native" && p.Mode != "external-remove") || len(p.Files) > 64 || len(p.Directories) > 64 || len(p.NativeValues) != len(wizardRegistration(p.Root, p.Channel, "")) || len(p.NativeRetryValues) > 2 || len(p.CommandRecords) > 2 {
		return p, true, errors.New("invalid registry cleanup identity")
	}
	generation, err := values[registryCleanupGeneration].value()
	if err != nil || generation != p.Ticket {
		return p, true, errors.New("registry cleanup generation does not match its authority")
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	for name, value := range raw {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return p, true, errors.New("null cleanup field: " + name)
		}
	}
	for _, spec := range []struct {
		name   string
		fields []string
	}{{"files", []string{"path", "kind", "state", "record", "id"}}, {"directories", []string{"path", "state", "id"}}} {
		var entries []json.RawMessage
		if err = json.Unmarshal(raw[spec.name], &entries); err != nil {
			return p, true, err
		}
		for _, entry := range entries {
			if err = exactObject(entry, spec.fields...); err != nil {
				return p, true, err
			}
			var obj map[string]json.RawMessage
			_ = json.Unmarshal(entry, &obj)
			for _, v := range obj {
				if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
					return p, true, errors.New("null cleanup entry")
				}
			}
			if err = exactObject(obj["id"], "volume", "high", "low"); err != nil {
				return p, true, err
			}
			if spec.name == "files" {
				if err = exactObject(obj["record"], "size", "sha256"); err != nil {
					return p, true, err
				}
			}
		}
	}
	if err = wizardSnapshotFields(raw["nativeValues"]); err != nil {
		return p, true, err
	}
	if err = wizardSnapshotFields(raw["nativeRetryValues"]); err != nil {
		return p, true, err
	}
	for name, value := range p.NativeValues {
		if name == "DisplayVersion" {
			s, e := value.value()
			if e != nil || value.Type != syscall.REG_SZ || !semverPattern.MatchString(s) {
				return p, true, errors.New("invalid cleanup display version")
			}
			continue
		}
		if !value.equal(wizardRegistration(p.Root, p.Channel, "")[name]) {
			return p, true, errors.New("cleanup native registration was changed")
		}
	}
	for name := range p.NativeRetryValues {
		if name != "UninstallString" && name != "QuietUninstallString" {
			return p, true, errors.New("unexpected cleanup retry value")
		}
	}
	seen := map[string]bool{}
	for _, f := range p.Files {
		if !filepath.IsAbs(f.Path) || filepath.Clean(f.Path) != f.Path || contained(p.Root, f.Path) || strings.EqualFold(p.Root, f.Path) || strings.HasPrefix(f.Path, `\\`) || seen[strings.ToUpper(f.Path)] || (f.State != "reserved" && f.State != "confirmed") || f.Record.Size < 1 || f.Record.Size > maxBootstrapBytes || !hashPattern.MatchString(f.Record.SHA256) {
			return p, true, errors.New("invalid cleanup external file inventory")
		}
		seen[strings.ToUpper(f.Path)] = true
		if f.Kind != "temp-helper" && f.Kind != "durable-helper" && f.Kind != "root-receipt" {
			return p, true, errors.New("unexpected cleanup file kind")
		}
		if f.Kind == "root-receipt" && filepath.Base(f.Path) != "cleanup.json" {
			return p, true, errors.New("invalid cleanup receipt filename")
		}
		if f.Kind != "root-receipt" && filepath.Base(f.Path) != "launcher.exe" {
			return p, true, errors.New("invalid cleanup helper filename")
		}
	}
	for _, d := range p.Directories {
		if seen[strings.ToUpper(d.Path)] {
			return p, true, errors.New("duplicate cleanup inventory path")
		}
		seen[strings.ToUpper(d.Path)] = true
		if !filepath.IsAbs(d.Path) || filepath.Clean(d.Path) != d.Path || contained(p.Root, d.Path) || strings.EqualFold(p.Root, d.Path) || (d.State != "reserved" && d.State != "confirmed") {
			return p, true, errors.New("invalid cleanup external directory inventory")
		}
	}
	return p, true, nil
}
func (w wizardCoordinator) writeRegisteredCleanup(p registeredCleanup) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if len(b) > maxRegistryCleanup {
		return errors.New("registry cleanup authority exceeds32KiB")
	}
	// Generation is installed before the typed record. A crash before both are
	// present is incomplete authority, never an invitation to adopt observed files.
	if err = writeWizardValue(w.key(p.Channel), registryCleanupGeneration, pathSnapshot{true, syscall.REG_SZ, pathStringBytes(p.Ticket)}); err != nil {
		return err
	}
	if err = writeWizardValue(w.key(p.Channel), registryCleanupValue, pathSnapshot{true, syscall.REG_BINARY, b}); err != nil {
		return err
	}
	check, exists, err := w.readRegisteredCleanup(p.Channel)
	if err != nil || !exists {
		return err
	}
	encoded, _ := json.Marshal(check)
	if string(encoded) != string(b) {
		return errors.New("registry cleanup authority changed during persistence")
	}
	return nil
}
func (w wizardCoordinator) ensureRegisteredCleanup(owner wizardOwner) (registeredCleanup, error) {
	if err := w.recoverCleanupGeneration(owner); err != nil {
		return registeredCleanup{}, err
	}
	p, exists, err := w.readRegisteredCleanup(owner.Channel)
	if err != nil {
		return p, err
	}
	if exists {
		if p.Ticket != owner.Ticket || p.Mode != "native" {
			return p, errors.New("another cleanup generation owns Apps and Features")
		}
		return p, nil
	}
	current, _, err := readWizardRegistry(w.key(owner.Channel), owner.Registration)
	if err != nil {
		return p, err
	}
	for name, want := range owner.Registration {
		if !current[name].equal(want) {
			return p, errors.New("application registration changed before cleanup reservation")
		}
	}
	p = registeredCleanup{Schema: 1, Root: owner.Root, Ticket: owner.Ticket, Channel: owner.Channel, Mode: "native", RootPhase: "none", Files: []registeredCleanupFile{}, Directories: []registeredCleanupDirectory{}, NativeValues: owner.Registration, NativeRetryValues: map[string]pathSnapshot{}, CommandRecords: map[string]fileRecord{}}
	return p, w.writeRegisteredCleanup(p)
}
func cleanupNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func (w wizardCoordinator) reserveCleanupDirectory(p *registeredCleanup, path string) error {
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return errors.New("cleanup reservation directory already exists")
	}
	p.Directories = append(p.Directories, registeredCleanupDirectory{Path: path, State: "reserved"})
	if err := w.writeRegisteredCleanup(*p); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0700); err != nil {
		return err
	}
	id, err := cleanupDirectoryIdentity(path)
	if err != nil {
		return err
	}
	p.Directories[len(p.Directories)-1].ID = id
	p.Directories[len(p.Directories)-1].State = "confirmed"
	return w.writeRegisteredCleanup(*p)
}
func (w wizardCoordinator) reserveCleanupFile(p *registeredCleanup, path, kind string, record fileRecord) error {
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return errors.New("cleanup reservation file already exists")
	}
	for i, f := range p.Files {
		if strings.EqualFold(f.Path, path) {
			if f.Path != path || f.Kind != kind || f.State != "reserved" {
				return errors.New("cleanup reservation already has confirmed or conflicting authority")
			}
			p.Files[i].Record = record
			return w.writeRegisteredCleanup(*p)
		}
	}
	p.Files = append(p.Files, registeredCleanupFile{Path: path, Kind: kind, State: "reserved", Record: record})
	return w.writeRegisteredCleanup(*p)
}
func (w wizardCoordinator) confirmCleanupFile(p *registeredCleanup, path string) error {
	for i := range p.Files {
		f := &p.Files[i]
		if f.Path != path {
			continue
		}
		if f.State != "reserved" {
			return errors.New("cleanup file was already confirmed")
		}
		if err := installVerifyFile(path, f.Record); err != nil {
			return err
		}
		id, err := wizardFileIdentity(path)
		if err != nil {
			return err
		}
		f.ID = id
		f.State = "confirmed"
		return w.writeRegisteredCleanup(*p)
	}
	return errors.New("cleanup file has no reservation")
}
func (w wizardCoordinator) makeReservedHelper(owner wizardOwner, temp bool) (string, wizardFileID, error) {
	p, err := w.ensureRegisteredCleanup(owner)
	if err != nil {
		return "", wizardFileID{}, err
	}
	base, err := w.recoveryBase()
	prefix, kind := "uninstall-", "durable-helper"
	if temp {
		base, err = maintenanceTempDir()
		prefix, kind = "cudia-uninstall-", "temp-helper"
	}
	if err != nil {
		return "", wizardFileID{}, err
	}
	if err = guardMaintenancePath(base); err != nil {
		return "", wizardFileID{}, err
	}
	if err = os.MkdirAll(base, 0700); err != nil {
		return "", wizardFileID{}, err
	}
	nonce, err := cleanupNonce()
	if err != nil {
		return "", wizardFileID{}, err
	}
	dir := filepath.Join(base, prefix+nonce)
	if err = w.reserveCleanupDirectory(&p, dir); err != nil {
		return "", wizardFileID{}, err
	}
	path := filepath.Join(dir, "launcher.exe")
	if err = w.reserveCleanupFile(&p, path, kind, owner.Helper); err != nil {
		return "", wizardFileID{}, err
	}
	if err = installCopyVerified(context.Background(), w.helperSource, path, owner.Helper); err != nil {
		return "", wizardFileID{}, err
	}
	if err = w.confirmCleanupFile(&p, path); err != nil {
		return "", wizardFileID{}, err
	}
	for _, f := range p.Files {
		if f.Path == path {
			return path, f.ID, nil
		}
	}
	return "", wizardFileID{}, errors.New("confirmed helper reservation lost")
}

// A generation-only value is created before the first reservation and may also
// survive cancellation between the two control-value deletions. With no typed
// file authority it can only be removed after exact original owner readback.
func (w wizardCoordinator) recoverCleanupGeneration(owner wizardOwner) error {
	values, _, err := readWizardRegistry(w.key(owner.Channel), map[string]pathSnapshot{registryCleanupValue: {}, registryCleanupGeneration: {}})
	if err != nil {
		return err
	}
	if values[registryCleanupValue].Exists || !values[registryCleanupGeneration].Exists {
		return nil
	}
	if !values[registryCleanupGeneration].equal(pathSnapshot{true, syscall.REG_SZ, pathStringBytes(owner.Ticket)}) {
		return errors.New("unowned orphan cleanup generation")
	}
	allowed := map[string]pathSnapshot{}
	for name, v := range owner.Registration {
		allowed[name] = v
	}
	allowed[registryCleanupGeneration] = values[registryCleanupGeneration]
	if err = wizardRegistryShape(w.key(owner.Channel), allowed); err != nil {
		return err
	}
	current, _, err := readWizardRegistry(w.key(owner.Channel), owner.Registration)
	if err != nil {
		return err
	}
	for name, want := range owner.Registration {
		if !current[name].equal(want) {
			return errors.New("orphan cleanup generation has changed registration")
		}
	}
	return writeWizardValue(w.key(owner.Channel), registryCleanupGeneration, pathSnapshot{})
}
