//go:build windows

package client

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

const removalJournal = "uninstall-pending.json"
const maxRemovalBytes = 32 * 1024 * 1024

type removalPlan struct {
	Schema     int        `json:"schema"`
	Root       string     `json:"root"`
	State      activation `json:"state"`
	Activation fileRecord `json:"activation"`
}

// These entry points only own the recorded version payload and activation.
// Installer-owned bootstrap, connection and registration are a separate layer.
// No operation below reads XDG directories or recursively removes a tree.
func preflightUninstall(root string) error {
	lease, err := acquireLifetime(root, true)
	if err != nil {
		return err
	}
	defer lease.close()
	lock, err := acquireLock(root)
	if err != nil {
		return err
	}
	defer lock.close()
	_, err = prepareRemoval(root)
	return err
}
func removeOwnedFiles(root string) error {
	lease, err := acquireLifetime(root, true)
	if err != nil {
		return err
	}
	defer lease.close()
	lock, err := acquireLock(root)
	if err != nil {
		return err
	}
	defer lock.close()
	return removeOwnedFilesLocked(root)
}

func removeOwnedFilesLocked(root string) error {
	plan, err := prepareRemoval(root)
	if err != nil || plan == nil {
		return err
	}
	journal := filepath.Join(root, "state", removalJournal)
	if _, err := os.Lstat(journal); os.IsNotExist(err) {
		if err := writeRemovalPlan(root, *plan); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	inventory := removalInventory(*plan)
	names := make([]string, 0, len(inventory))
	for name := range inventory {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := removeVerifiedFile(root, name, inventory[name]); err != nil {
			return err
		}
	}
	// Keep both the activation and durable plan until all payload deletions have
	// succeeded, so a sharing violation is recoverable by the same bounded plan.
	if err := removeVerifiedFile(root, "state/activation.json", plan.Activation); err != nil {
		return err
	}
	if err := guardMaintenancePath(journal); err != nil {
		return err
	}
	if err := os.Remove(journal); err != nil && !os.IsNotExist(err) {
		return err
	}
	directories := map[string]bool{}
	for _, name := range names {
		for dir := filepath.Dir(filepath.Join(root, filepath.FromSlash(name))); contained(root, dir); dir = filepath.Dir(dir) {
			directories[dir] = true
		}
	}
	dirs := make([]string, 0, len(directories))
	for dir := range directories {
		dirs = append(dirs, dir)
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, dir := range dirs {
		if err := guardMaintenancePath(dir); err != nil {
			return err
		}
		// Remove only empty known ancestor directories. Unknown files survive.
		entries, err := os.ReadDir(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			if err := os.Remove(dir); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func prepareRemoval(root string) (*removalPlan, error) {
	for _, name := range []string{"install-pending.json", "wizard-pending.json", "wizard-uninstall.json", "wizard-intent.json"} {
		pending := filepath.Join(root, "state", name)
		if err := guardMaintenancePath(pending); err != nil {
			return nil, err
		}
		if _, err := os.Lstat(pending); err == nil {
			return nil, errors.New("installation transaction is pending; finish or abort it before uninstalling")
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	if err := refuseRunningImages(root); err != nil {
		return nil, err
	}
	journal := filepath.Join(root, "state", removalJournal)
	var plan removalPlan
	if err := guardMaintenancePath(journal); err != nil {
		return nil, err
	}
	f, err := os.Open(journal)
	if err == nil {
		if err := singleRegularFile(f); err != nil {
			f.Close()
			return nil, err
		}
		data, readErr := readCapped(f, maxRemovalBytes)
		f.Close()
		if readErr != nil {
			return nil, readErr
		}
		if err := exactObject(data, "schema", "root", "state", "activation"); err != nil {
			return nil, err
		}
		if err := strictJSON(data, &plan); err != nil {
			return nil, err
		}
		// Reuse the complete strict activation parser, including nested descriptors,
		// against a bounded in-memory representation without touching disk.
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil, err
		}
		if err := validateRemovalStateJSON(raw["state"]); err != nil {
			return nil, err
		}
		if err := exactObject(raw["activation"], "size", "sha256"); err != nil {
			return nil, err
		}
		if plan.Schema != 1 || plan.Root != root || plan.Activation.Size < 1 || plan.Activation.Size > maxStateBytes || !hashPattern.MatchString(plan.Activation.SHA256) {
			return nil, errors.New("uninstall journal identity invalid")
		}
	} else if os.IsNotExist(err) {
		activationPath := filepath.Join(root, "state", "activation.json")
		if err := guardMaintenancePath(activationPath); err != nil {
			return nil, err
		}
		if _, err := os.Lstat(activationPath); os.IsNotExist(err) {
			return nil, nil
		} else if err != nil {
			return nil, err
		}
		state, err := readState(root)
		if err != nil {
			return nil, err
		}
		record, err := removalFileRecord(activationPath, maxStateBytes)
		if err != nil {
			return nil, err
		}
		plan = removalPlan{1, root, state, record}
	} else {
		return nil, err
	}
	if err := validateState(plan.State); err != nil {
		return nil, err
	}
	// Validate every present owned file before the first deletion. Missing files
	// are accepted for retry; unexpected files are never added to the inventory.
	for name, record := range removalInventory(plan) {
		if err := verifyRemovalFile(root, name, record); err != nil {
			return nil, err
		}
	}
	if err := verifyRemovalFile(root, "state/activation.json", plan.Activation); err != nil {
		return nil, err
	}
	return &plan, nil
}
func validateRemovalStateJSON(data []byte) error {
	if err := exactObject(data, "schema", "bootstrapABI", "platform", "arch", "variant", "selectedReleaseId", "highestSequence", "installed"); err != nil {
		return err
	}
	var state struct {
		Installed map[string]json.RawMessage `json:"installed"`
	}
	if err := strictJSON(data, &activation{}); err != nil {
		return err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	for _, record := range state.Installed {
		if err := exactObject(record, "version", "channel", "sequence", "archiveSha256", "descriptor"); err != nil {
			return err
		}
		var fields struct {
			Descriptor json.RawMessage `json:"descriptor"`
		}
		if err := json.Unmarshal(record, &fields); err != nil {
			return err
		}
		if _, err := parseDescriptor(fields.Descriptor); err != nil {
			return err
		}
	}
	return nil
}
func removalInventory(plan removalPlan) map[string]fileRecord {
	files := map[string]fileRecord{}
	for id, release := range plan.State.Installed {
		for name, record := range release.Descriptor.Files {
			files["versions/"+id+"/"+name] = record
		}
	}
	return files
}
func removalFileRecord(path string, max int64) (fileRecord, error) {
	var result fileRecord
	if err := guardMaintenancePath(path); err != nil {
		return result, err
	}
	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()
	if err := singleRegularFile(f); err != nil {
		return result, err
	}
	stat, err := f.Stat()
	if err != nil {
		return result, err
	}
	if stat.Size() > max {
		return result, errors.New("owned installation file exceeds its size limit")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(f, max+1))
	if err != nil {
		return result, err
	}
	if size > max {
		return result, errors.New("owned installation file exceeds its size limit")
	}
	return fileRecord{size, hex.EncodeToString(hash.Sum(nil))}, nil
}
func verifyRemovalFile(root, name string, expected fileRecord) error {
	if !validPath(name) {
		return errors.New("uninstall inventory contains an unsafe path")
	}
	path := filepath.Join(root, filepath.FromSlash(name))
	if !contained(root, path) {
		return errors.New("uninstall inventory escapes installation root")
	}
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	actual, err := removalFileRecord(path, expected.Size)
	if err != nil {
		return fmt.Errorf("preserving %s: %w", name, err)
	}
	if actual != expected {
		return fmt.Errorf("preserving modified installation file: %s", name)
	}
	return nil
}
func removeVerifiedFile(root, name string, expected fileRecord) error {
	if err := verifyRemovalFile(root, name, expected); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(name))); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cannot remove %s; close applications using this installation and retry: %w", name, err)
	}
	return nil
}
func writeRemovalPlan(root string, plan removalPlan) error {
	data, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	if len(data) > maxRemovalBytes {
		return errors.New("uninstall inventory exceeds its size limit")
	}
	dir := filepath.Join(root, "state")
	if err := guardMaintenancePath(dir); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, "uninstall-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	target := filepath.Join(dir, removalJournal)
	if err := guardMaintenancePath(target); err != nil {
		return err
	}
	return atomicReplace(file.Name(), target)
}

// Return relative preserved files for a reviewable installer result. This walk
// is bounded and reports redirected descendants without ever following them.
func uninstallRemnants(root string) ([]string, error) {
	if err := validateMaintenanceRoot(root); err != nil {
		return nil, err
	}
	var files []string
	visited := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		visited++
		if visited > maxFiles*128 {
			return errors.New("installation remainder inventory exceeds its limit")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		// A user-created redirect is itself a preserved remnant. Never inspect
		// its destination, even to list it for the installer's result.
		redirect, err := maintenanceReparse(path)
		if err != nil {
			return err
		}
		if redirect {
			files = append(files, relative)
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if err := guardMaintenancePath(path); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if relative == "state/lifetime.lock" || relative == "state/update.lock" {
			return nil
		}
		files = append(files, relative)
		return nil
	})
	sort.Strings(files)
	return files, err
}
