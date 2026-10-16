//go:build windows

package client

import (
	"bytes"
	"context"
	"encoding/binary"
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

const maxWizardJournal = 2 * 1024 * 1024

// All production registry destinations are derived from the signed channel.
// Overrides and fault injection are private, exclusively for isolated tests.
type wizardCoordinator struct {
	u               *updater
	registrySubkey  string
	registryChannel string
	path            pathManager
	helperSource    string
	recoveryRoot    string
	recoveryOutput  *string
	cleanupOutput   *string
	tailLog         string
	fail            func(string) error
}
type wizardOwner struct {
	Schema       int                     `json:"schema"`
	Root         string                  `json:"root"`
	Channel      string                  `json:"channel"`
	Bootstrap    fileRecord              `json:"bootstrap"`
	Helper       fileRecord              `json:"helper"`
	Connection   []byte                  `json:"connection"`
	Activation   string                  `json:"activation"`
	Ticket       string                  `json:"ticket"`
	Registration map[string]pathSnapshot `json:"registration"`
}
type wizardPending struct {
	Schema         int                     `json:"schema"`
	Root           string                  `json:"root"`
	Ticket         string                  `json:"ticket"`
	Owner          wizardOwner             `json:"owner"`
	PriorOwner     []byte                  `json:"priorOwner"`
	PriorRegistry  map[string]pathSnapshot `json:"priorRegistry"`
	Registry       map[string]string       `json:"registry"`
	Files          map[string]string       `json:"files"`
	FileIDs        map[string]wizardFileID `json:"fileIds"`
	AddPath        bool                    `json:"addPath"`
	PriorPathOwned bool                    `json:"priorPathOwned"`
	PathStarted    bool                    `json:"pathStarted"`
	PathAdded      bool                    `json:"pathAdded"`
	ReceiptWritten bool                    `json:"receiptWritten"`
}
type wizardFileID struct {
	Volume uint32 `json:"volume"`
	High   uint32 `json:"high"`
	Low    uint32 `json:"low"`
}

func wizardFileIdentity(path string) (wizardFileID, error) {
	var id wizardFileID
	if err := guardMaintenancePath(path); err != nil {
		return id, err
	}
	f, err := os.Open(path)
	if err != nil {
		return id, err
	}
	defer f.Close()
	if err = singleRegularFile(f); err != nil {
		return id, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); err != nil {
		return id, err
	}
	return wizardFileID{info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow}, nil
}

func newWizardCoordinator(u *updater) wizardCoordinator {
	helper, _ := os.Executable()
	return wizardCoordinator{u: u, helperSource: helper, path: pathManager{registrySubkey: `Environment`, notify: notifyUserPath}}
}
func (u *updater) wizardPrepare(ctx context.Context, variant, channel string, envelope []byte, archive, bootstrapSource string, addPath bool) (installTicket, error) {
	return newWizardCoordinator(u).prepare(ctx, variant, channel, envelope, archive, bootstrapSource, addPath)
}
func (u *updater) wizardFinalize(ctx context.Context, ticket string) error {
	return newWizardCoordinator(u).finalize(ctx, ticket)
}
func (u *updater) wizardAbort(ctx context.Context, ticket string) error {
	return newWizardCoordinator(u).abort(ctx, ticket)
}
func (w wizardCoordinator) hook(name string) error {
	if w.fail != nil {
		return w.fail(name)
	}
	return nil
}
func (w wizardCoordinator) key(channel string) string {
	if w.registrySubkey != "" {
		return w.registrySubkey
	}
	if channel == "preview" {
		return `Software\Microsoft\Windows\CurrentVersion\Uninstall\CudiaPreview`
	}
	return `Software\Microsoft\Windows\CurrentVersion\Uninstall\Cudia`
}
func wizardRoot(root string, create bool) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || strings.ContainsAny(root, ";\"%\x00") || strings.HasPrefix(root, `\\`) {
		return errors.New("wizard root must be a canonical local absolute path")
	}
	if filepath.Dir(root) == root {
		return errors.New("refusing a broad installation root")
	}
	for _, name := range []string{"USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"} {
		if p := os.Getenv(name); p != "" && (strings.EqualFold(filepath.Clean(p), root) || contained(root, filepath.Clean(p))) {
			return errors.New("refusing a shared user or system directory as installation root")
		}
	}
	if err := guardMaintenancePath(root); err != nil {
		return err
	}
	if _, err := os.Stat(root); os.IsNotExist(err) && create {
		if err = os.Mkdir(root, 0700); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return validateMaintenanceRoot(root)
}
func (w wizardCoordinator) locked(exclusive bool, fn func() error) error {
	if err := wizardRoot(w.u.root, false); err != nil {
		return err
	}
	if err := ensureLayout(w.u.root); err != nil {
		return err
	}
	lease, err := acquireLifetime(w.u.root, exclusive)
	if err != nil {
		return err
	}
	defer lease.close()
	lock, err := acquireLock(w.u.root)
	if err != nil {
		return err
	}
	defer lock.close()
	channel := w.registryChannel
	if channel == "" {
		if p, e := w.readPending(""); e == nil {
			channel = p.Owner.Channel
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	if channel == "" {
		if p, e := w.readIntent(); e == nil {
			channel = p.Channel
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	if channel == "" {
		b, e := installReadOptional(filepath.Join(w.u.root, "state", "wizard-owner.json"), maxWizardJournal)
		if e != nil {
			return e
		}
		if b != nil {
			var owner wizardOwner
			if e = decodeWizardOwner(b, w.u.root, &owner); e != nil {
				return e
			}
			channel = owner.Channel
		}
	}
	if channel == "" {
		b, e := installReadOptional(filepath.Join(w.u.root, "state", "wizard-uninstalled.json"), maxWizardJournal)
		if e != nil {
			return e
		}
		if b != nil {
			var owner wizardOwner
			if e = decodeWizardOwner(b, w.u.root, &owner); e != nil {
				return e
			}
			channel = owner.Channel
		}
	}
	if channel == "" {
		channel = "stable"
	}
	return withRegistrationLock(w.key(channel), fn)
}
func (w wizardCoordinator) prepare(ctx context.Context, variant, channel string, envelope []byte, archive, bootstrapSource string, addPath bool) (installTicket, error) {
	w.registryChannel = channel
	var result installTicket
	if !validVariant(variant) || !validChannel(channel) {
		return result, errors.New("invalid wizard channel or variant")
	}
	if err := wizardRoot(w.u.root, true); err != nil {
		return result, err
	}
	if contained(w.u.root, w.helperSource) {
		return result, errors.New("wizard must run from its trusted external bundled helper")
	}
	err := w.locked(false, func() error {
		if p, exists, err := w.readRegisteredCleanup(channel); err != nil {
			return err
		} else if exists {
			return fmt.Errorf("uninstall cleanup %s is pending; finish its registered recovery command before installing", p.Ticket)
		}
		if err := w.recoverIntentLocked(); err != nil {
			return err
		}
		if err := installRefuseUninstall(w.u.root); err != nil {
			return err
		}
		if b, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-uninstall.json"), maxRemovalBytes); err != nil {
			return err
		} else if b != nil {
			return errors.New("native uninstall is pending; resume it before installing")
		}
		if b, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-uninstalled.json"), maxWizardJournal); err != nil {
			return err
		} else if b != nil {
			if err = w.checkUninstalled(); err != nil {
				return err
			}
			if err = os.Remove(filepath.Join(w.u.root, "state", "wizard-uninstalled.json")); err != nil {
				return err
			}
		}
		if old, err := w.readPending(""); err == nil {
			if err = w.abortLocked(old); err != nil {
				return fmt.Errorf("recover previous wizard: %w", err)
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		ownerBytes, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-owner.json"), maxWizardJournal)
		if err != nil {
			return err
		}
		var oldOwner wizardOwner
		if ownerBytes != nil {
			if err = decodeWizardOwner(ownerBytes, w.u.root, &oldOwner); err != nil {
				return err
			}
			if oldOwner.Channel != channel {
				return errors.New("wizard channel differs from installation owner")
			}
			if err = w.verifyAppFiles(oldOwner, false); err != nil {
				return err
			}
		}
		desired := wizardRegistration(w.u.root, channel, "0.0.0")
		prior, exists, err := readWizardRegistry(w.key(channel), desired)
		if err != nil {
			return err
		}
		if exists {
			if ownerBytes == nil {
				return errors.New("Apps and Features registration already exists without Cudia ownership")
			}
			if !prior["CudiaRoot"].equal(oldOwner.Registration["CudiaRoot"]) {
				return errors.New("Apps and Features registration belongs to another installation")
			}
		}
		_, token, err := pathIdentity(w.u.root)
		if err != nil {
			return err
		}
		pathBefore, pathExists, err := readPathOwnership(w.u.root, token)
		if err != nil {
			return err
		}
		if pathExists && pathBefore.Phase == "intent" {
			return errors.New("PATH ownership is uncertain; preserve entry and repair manually")
		}
		intent, err := w.createIntentLocked(variant, channel, envelope, bootstrapSource)
		if err != nil {
			return err
		}
		// These two hooks deliberately precede the normal cleanup defer. They
		// model process death, leaving the same durable evidence as a real crash.
		if err = w.hook("wizard-intent-persisted"); err != nil {
			return err
		}
		result, err = w.u.prepareInstallTicketLocked(ctx, variant, channel, envelope, archive, bootstrapSource, intent.Ticket)
		if err != nil {
			_ = w.recoverIntentLocked()
			return err
		}
		if err = w.hook("wizard-internal-prepared"); err != nil {
			return err
		}
		p, err := w.u.readInstallPending(result.Ticket)
		if err != nil {
			return err
		}
		cleanup := true
		defer func() {
			if cleanup {
				_ = w.recoverIntentLocked()
			}
		}()
		helper := p.Descriptor.Files["launcher.exe"]
		if err = installVerifyFile(w.helperSource, helper); err != nil {
			return errors.New("installer helper does not exactly match signed bundle launcher")
		}
		if err = verifyPE(w.helperSource); err != nil {
			return err
		}
		stage := filepath.Join(w.u.root, "state", "staging", p.Stage)
		if err = installCopyVerified(ctx, w.helperSource, filepath.Join(stage, "wizard-helper.exe"), helper); err != nil {
			return err
		}
		owner := wizardOwner{Schema: 1, Root: w.u.root, Channel: channel, Bootstrap: p.Bootstrap, Helper: helper, Connection: p.PlannedConnection, Activation: p.ExpectedActivation, Ticket: result.Ticket, Registration: wizardRegistration(w.u.root, channel, result.Version)}
		if ownerBytes != nil {
			owner.Connection = oldOwner.Connection
			if oldOwner.Bootstrap != p.Bootstrap || oldOwner.Helper != helper {
				return errors.New("existing bootstrap or maintenance helper differs; use a matching installer")
			}
		}
		journal := wizardPending{Schema: 1, Root: w.u.root, Ticket: result.Ticket, Owner: owner, PriorOwner: ownerBytes, PriorRegistry: prior, Registry: map[string]string{}, Files: map[string]string{}, FileIDs: map[string]wizardFileID{}, AddPath: addPath, PriorPathOwned: pathExists && pathBefore.Phase == "owned" && pathBefore.Added}
		for name, record := range map[string]fileRecord{"bin/cudia.exe": owner.Bootstrap, "maintenance/launcher.exe": owner.Helper} {
			b, err := installReadOptional(filepath.Join(w.u.root, filepath.FromSlash(name)), maxBootstrapBytes)
			if err != nil {
				return err
			}
			if b != nil {
				if ownerBytes == nil {
					return errors.New("unowned wizard executable already exists")
				}
				if int64(len(b)) != record.Size || digest(b) != record.SHA256 {
					return errors.New("owned wizard executable was modified")
				}
				journal.Files[name] = "prior"
			} else {
				journal.Files[name] = "absent"
			}
		}
		if err = w.writePending(journal, true); err != nil {
			return err
		}
		cleanup = false
		if err = w.hook("wizard-journal-persisted"); err != nil {
			return err
		}
		if err = w.removeIntent(); err != nil {
			return err
		}
		return w.hook("prepared")
	})
	return result, err
}

func (w wizardCoordinator) finalize(ctx context.Context, ticket string) error {
	return w.locked(false, func() error {
		if err := w.recoverIntentLocked(); err != nil {
			return err
		}
		j, err := w.readPending(ticket)
		if os.IsNotExist(err) {
			b, e := installReadOptional(filepath.Join(w.u.root, "state", "wizard-owner.json"), maxWizardJournal)
			if e != nil {
				return e
			}
			var owner wizardOwner
			if e = decodeWizardOwner(b, w.u.root, &owner); e != nil {
				return e
			}
			if owner.Ticket != ticket || !w.u.installActivationMatches(owner.Activation) {
				return errors.New("wizard completion ticket does not match activation")
			}
			return w.verifyAppFiles(owner, false)
		}
		if err != nil {
			return err
		}
		if j.ReceiptWritten && w.u.installActivationMatches(j.Owner.Activation) {
			return w.finishCommitted(j)
		}
		p, err := w.u.readInstallPending(ticket)
		if err != nil {
			return err
		}
		if p.ExpectedActivation != j.Owner.Activation || p.Channel != j.Owner.Channel || p.Bootstrap != j.Owner.Bootstrap || p.Descriptor.Files["launcher.exe"] != j.Owner.Helper {
			return errors.New("wizard and prepared release identities differ")
		}
		if err = w.validatePrepared(ctx, p); err != nil {
			return err
		}
		for _, name := range []string{"bin/cudia.exe", "maintenance/launcher.exe"} {
			record, source := j.Owner.Bootstrap, "bootstrap.exe"
			if strings.HasPrefix(name, "maintenance/") {
				record, source = j.Owner.Helper, "wizard-helper.exe"
			}
			dest := filepath.Join(w.u.root, filepath.FromSlash(name))
			switch j.Files[name] {
			case "prior", "created":
				if j.Files[name] == "created" {
					id, e := wizardFileIdentity(dest)
					if e != nil {
						return e
					}
					if id != j.FileIDs[name] {
						return errors.New("created wizard file identity changed")
					}
				}
				if err = installVerifyFile(dest, record); err != nil {
					return err
				}
			case "absent", "intent":
				if err = guardMaintenancePath(filepath.Dir(dest)); err != nil {
					return err
				}
				if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
					return err
				}
				// Preserve signed staging sources: commit verifies them again immediately
				// before activation. The destination promotion never overwrites a file.
				tmp := filepath.Join(w.u.root, "state", "staging", p.Stage, "promote-"+filepath.Base(source))
				if j.Files[name] == "absent" {
					if _, err = os.Lstat(dest); !os.IsNotExist(err) {
						return errors.New("wizard executable appeared after preparation")
					}
					// A crash while copying before durable intent may leave only
					// this enumerated private staging file, never a working file.
					if err = guardMaintenancePath(tmp); err != nil {
						return err
					}
					if err = os.Remove(tmp); err != nil && !os.IsNotExist(err) {
						return err
					}
					if err = installCopyVerified(ctx, filepath.Join(w.u.root, "state", "staging", p.Stage, source), tmp, record); err != nil {
						return err
					}
					id, e := wizardFileIdentity(tmp)
					if e != nil {
						return e
					}
					j.FileIDs[name] = id
					j.Files[name] = "intent"
					if err = w.writePending(j, false); err != nil {
						return err
					}
					if err = w.hook("file-intent:" + name); err != nil {
						return err
					}
				}
				if id, e := wizardFileIdentity(dest); e == nil {
					if id != j.FileIDs[name] {
						return errors.New("wizard destination has another file identity; preserving it")
					}
					if err = installVerifyFile(dest, record); err != nil {
						return err
					}
				} else if os.IsNotExist(e) {
					id, e = wizardFileIdentity(tmp)
					if e != nil {
						return e
					}
					if id != j.FileIDs[name] {
						return errors.New("wizard staging file identity changed")
					}
					if err = installVerifyFile(tmp, record); err != nil {
						return err
					}
					if err = promote(tmp, dest); err != nil {
						return err
					}
				} else {
					return e
				}
				if err = w.hook("file-promoted:" + name); err != nil {
					return err
				}
				j.Files[name] = "created"
				if err = w.writePending(j, false); err != nil {
					return err
				}
				if err = w.hook("file-created:" + name); err != nil {
					return err
				}
			default:
				return errors.New("invalid wizard file state")
			}
		}
		if err = w.verifyAppFiles(j.Owner, false); err != nil {
			return err
		}
		for _, name := range sortedWizardNames(j.Owner.Registration) {
			current, _, err := readWizardRegistry(w.key(j.Owner.Channel), map[string]pathSnapshot{name: {}})
			if err != nil {
				return err
			}
			want := j.Owner.Registration[name]
			if j.Registry[name] == "written" {
				if !current[name].equal(want) {
					return errors.New("registration changed after wizard write")
				}
				continue
			}
			if j.Registry[name] == "intent" {
				return errors.New("registration write was interrupted; cancel wizard to restore matching attempted values")
			}
			if !current[name].equal(j.PriorRegistry[name]) {
				return errors.New("registration changed since wizard preparation")
			}
			j.Registry[name] = "intent"
			if err = w.writePending(j, false); err != nil {
				return err
			}
			if err = w.hook("registry-intent:" + name); err != nil {
				return err
			}
			if err = writeWizardValue(w.key(j.Owner.Channel), name, want); err != nil {
				return err
			}
			j.Registry[name] = "written"
			if err = w.writePending(j, false); err != nil {
				return err
			}
			if err = w.hook("registry-written:" + name); err != nil {
				return err
			}
		}
		if j.AddPath && !j.PathStarted {
			j.PathStarted = true
			if err = w.writePending(j, false); err != nil {
				return err
			}
		}
		if j.AddPath {
			status, err := w.path.add(w.u.root)
			if err != nil {
				return err
			}
			if status.Pending {
				return errors.New("PATH ownership is uncertain; entry preserved for manual repair")
			}
			if status.Added && !j.PriorPathOwned {
				j.PathAdded = true
				if err = w.writePending(j, false); err != nil {
					return err
				}
			}
			if err = w.hook("path-added"); err != nil {
				return err
			}
		}
		// Persist the complete ownership receipt before atomic activation. Activation
		// is the recovery authority if power is lost before journal cleanup.
		receipt, _ := json.Marshal(j.Owner)
		if err = wizardWriteJSON(filepath.Join(w.u.root, "state", "wizard-owner.json"), receipt, false); err != nil {
			return err
		}
		j.ReceiptWritten = true
		if err = w.writePending(j, false); err != nil {
			return err
		}
		if err = w.hook("before-activation"); err != nil {
			return err
		}
		if err = w.u.commitPreparedInstallLocked(ctx, ticket); err != nil {
			return err
		}
		_ = w.hook("after-activation")
		_ = w.finishCommitted(j)
		return nil
	})
}
func (w wizardCoordinator) validatePrepared(ctx context.Context, p installPending) error {
	signed, err := verifyEnvelope(p.Envelope, w.u.keys, p.Channel, w.u.now())
	if err != nil {
		return err
	}
	a, err := archiveFor(signed, p.Variant)
	if err != nil {
		return err
	}
	if err = w.u.installCheckPrior(p); err != nil {
		return err
	}
	stage := filepath.Join(w.u.root, "state", "staging", p.Stage)
	if err = installVerifyFile(filepath.Join(stage, "archive.zip"), fileRecord{a.Size, a.SHA256}); err != nil {
		return err
	}
	// Re-extract before any app or registration mutation to bind the descriptor
	// (including the maintenance helper) to the signed archive.
	dir, err := os.MkdirTemp(stage, "wizard-check-")
	if err != nil {
		return err
	}
	defer safeRemove(stage, dir)
	d, err := extractPackage(filepath.Join(stage, "archive.zip"), dir, signed, a)
	if err != nil {
		return err
	}
	b, _ := json.Marshal(d)
	expected, _ := json.Marshal(p.Descriptor)
	if !bytes.Equal(b, expected) {
		return errors.New("wizard descriptor differs from signed bundle")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return nil
}
func (w wizardCoordinator) abort(ctx context.Context, ticket string) error {
	return w.locked(false, func() error {
		if err := w.recoverIntentLocked(); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		j, err := w.readPending(ticket)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		return w.abortLocked(j)
	})
}
func (w wizardCoordinator) abortLocked(j wizardPending) error {
	if j.ReceiptWritten && w.u.installActivationMatches(j.Owner.Activation) {
		return w.finishCommitted(j)
	}
	// A PATH intent may have reached HKCU without committing ownership. Never
	// infer ownership from a matching registry value after an interruption.
	if j.PathStarted {
		_, token, err := pathIdentity(w.u.root)
		if err != nil {
			return err
		}
		ownership, exists, err := readPathOwnership(w.u.root, token)
		if err != nil {
			return err
		}
		if exists && ownership.Phase == "intent" {
			return errors.New("uncertain PATH write preserved; manual repair required before cancel recovery")
		}
		if !j.PriorPathOwned && exists && ownership.Phase == "owned" && ownership.Added {
			status, err := w.path.remove(w.u.root)
			if err != nil {
				return err
			}
			if status.Pending || status.Added {
				return errors.New("changed PATH entry preserved; manual repair required")
			}
		}
	}
	for _, name := range sortedWizardNames(j.Owner.Registration) {
		if j.Registry[name] == "" {
			continue
		}
		current, _, err := readWizardRegistry(w.key(j.Owner.Channel), map[string]pathSnapshot{name: {}})
		if err != nil {
			return err
		}
		if current[name].equal(j.PriorRegistry[name]) {
			continue
		}
		if !current[name].equal(j.Owner.Registration[name]) {
			return errors.New("registration edited after wizard attempt; preserving it")
		}
		if err = writeWizardValue(w.key(j.Owner.Channel), name, j.PriorRegistry[name]); err != nil {
			return err
		}
	}
	if j.PriorOwner == nil {
		if err := removeEmptyWizardKey(w.key(j.Owner.Channel)); err != nil {
			return err
		}
	}
	for _, name := range []string{"maintenance/launcher.exe", "bin/cudia.exe"} {
		state := j.Files[name]
		if state == "prior" || state == "absent" {
			continue
		}
		path := filepath.Join(w.u.root, filepath.FromSlash(name))
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		}
		if state == "intent" || state == "created" {
			id, err := wizardFileIdentity(path)
			if err != nil {
				return err
			}
			if id != j.FileIDs[name] {
				return errors.New("wizard destination identity changed; preserving it")
			}
		}
		record := j.Owner.Bootstrap
		if strings.HasPrefix(name, "maintenance/") {
			record = j.Owner.Helper
		}
		if err := removeVerifiedFile(w.u.root, name, record); err != nil {
			return err
		}
	}
	receipt, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-owner.json"), maxWizardJournal)
	if err != nil {
		return err
	}
	desired, _ := json.Marshal(j.Owner)
	if bytes.Equal(receipt, desired) {
		if j.PriorOwner == nil {
			if err = os.Remove(filepath.Join(w.u.root, "state", "wizard-owner.json")); err != nil {
				return err
			}
		} else if err = wizardWriteJSON(filepath.Join(w.u.root, "state", "wizard-owner.json"), j.PriorOwner, false); err != nil {
			return err
		}
	} else if !bytes.Equal(receipt, j.PriorOwner) {
		return errors.New("installation owner changed; preserving receipt")
	}
	if err = w.cleanupHelperStage(j.Ticket); err != nil {
		return err
	}
	if err = w.u.abortPreparedInstallLocked(j.Ticket); err != nil {
		return err
	}
	return os.Remove(filepath.Join(w.u.root, "state", "wizard-pending.json"))
}
func (w wizardCoordinator) finishCommitted(j wizardPending) error {
	if err := w.verifyAppFiles(j.Owner, false); err != nil {
		return err
	}
	_ = w.cleanupHelperStage(j.Ticket)
	if err := w.u.abortPreparedInstallLocked(j.Ticket); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(w.u.root, "state", "wizard-pending.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
func (w wizardCoordinator) cleanupHelperStage(ticket string) error {
	p, err := w.u.readInstallPending(ticket)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, name := range []string{"wizard-helper.exe", "promote-bootstrap.exe", "promote-wizard-helper.exe"} {
		path := filepath.Join(w.u.root, "state", "staging", p.Stage, name)
		if err = guardMaintenancePath(path); err != nil {
			return err
		}
		if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func (w wizardCoordinator) verifyAppFiles(o wizardOwner, missing bool) error {
	for name, record := range map[string]fileRecord{"bin/cudia.exe": o.Bootstrap, "maintenance/launcher.exe": o.Helper} {
		if missing {
			if err := verifyRemovalFile(o.Root, name, record); err != nil {
				return err
			}
		} else {
			if err := installVerifyFile(filepath.Join(o.Root, filepath.FromSlash(name)), record); err != nil {
				return err
			}
			if err := verifyPE(filepath.Join(o.Root, filepath.FromSlash(name))); err != nil {
				return err
			}
		}
	}
	return nil
}
func (w wizardCoordinator) writePending(j wizardPending, create bool) error {
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return wizardWriteJSON(filepath.Join(w.u.root, "state", "wizard-pending.json"), b, create)
}
func (w wizardCoordinator) readPending(ticket string) (wizardPending, error) {
	var j wizardPending
	b, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-pending.json"), maxWizardJournal)
	if err != nil {
		return j, err
	}
	if b == nil {
		return j, os.ErrNotExist
	}
	if err = exactObject(b, "schema", "root", "ticket", "owner", "priorOwner", "priorRegistry", "registry", "files", "fileIds", "addPath", "priorPathOwned", "pathStarted", "pathAdded", "receiptWritten"); err != nil {
		return j, err
	}
	if err = strictJSON(b, &j); err != nil {
		return j, err
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	for name, value := range raw {
		if name != "priorOwner" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return j, errors.New("null wizard journal field")
		}
	}
	if err = decodeWizardOwner(raw["owner"], w.u.root, &j.Owner); err != nil {
		return j, err
	}
	if j.Schema != 1 || j.Root != w.u.root || !hashPattern.MatchString(j.Ticket) || (ticket != "" && ticket != j.Ticket) || len(j.Files) != 2 || len(j.PriorRegistry) != len(j.Owner.Registration) || len(j.Registry) > len(j.Owner.Registration) {
		return j, errors.New("wizard journal identity invalid")
	}
	for _, name := range []string{"bin/cudia.exe", "maintenance/launcher.exe"} {
		if j.Files[name] == "intent" || j.Files[name] == "created" {
			if _, ok := j.FileIDs[name]; !ok {
				return j, errors.New("wizard file identity receipt missing")
			}
		}
		switch j.Files[name] {
		case "prior", "absent", "intent", "created":
		default:
			return j, errors.New("invalid wizard file receipt")
		}
	}
	for name, state := range j.Registry {
		if _, ok := j.Owner.Registration[name]; !ok || (state != "intent" && state != "written") {
			return j, errors.New("invalid wizard registry intent")
		}
	}
	for name, value := range j.PriorRegistry {
		if _, ok := j.Owner.Registration[name]; !ok || len(value.Data) > maxUserPathBytes || (!value.Exists && (value.Type != 0 || len(value.Data) != 0)) {
			return j, errors.New("invalid previous registry snapshot")
		}
	}
	for _, field := range []string{"priorRegistry"} {
		if err = wizardSnapshotFields(raw[field]); err != nil {
			return j, err
		}
	}
	var ids map[string]json.RawMessage
	_ = json.Unmarshal(raw["fileIds"], &ids)
	for name, id := range ids {
		if name != "bin/cudia.exe" && name != "maintenance/launcher.exe" {
			return j, errors.New("unexpected wizard file identity")
		}
		if err = exactObject(id, "volume", "high", "low"); err != nil {
			return j, err
		}
	}
	if j.PriorOwner != nil {
		var old wizardOwner
		if err = decodeWizardOwner(j.PriorOwner, w.u.root, &old); err != nil {
			return j, err
		}
		if old.Channel != j.Owner.Channel {
			return j, errors.New("wizard owner channel changed")
		}
	}
	return j, nil
}
func decodeWizardOwner(b []byte, root string, o *wizardOwner) error {
	if err := exactObject(b, "schema", "root", "channel", "bootstrap", "helper", "connection", "activation", "ticket", "registration"); err != nil {
		return err
	}
	if err := strictJSON(b, o); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	for name, value := range raw {
		if name != "connection" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("null wizard owner field")
		}
	}
	for _, field := range []string{"bootstrap", "helper"} {
		if err := exactObject(raw[field], "size", "sha256"); err != nil {
			return err
		}
	}
	if err := wizardSnapshotFields(raw["registration"]); err != nil {
		return err
	}
	if o.Schema != 1 || o.Root != root || !validChannel(o.Channel) || !hashPattern.MatchString(o.Activation) || !hashPattern.MatchString(o.Ticket) || len(o.Connection) > 16*1024 {
		return errors.New("invalid wizard ownership identity")
	}
	for _, f := range []fileRecord{o.Bootstrap, o.Helper} {
		if f.Size < 1 || f.Size > maxBootstrapBytes || !hashPattern.MatchString(f.SHA256) {
			return errors.New("invalid wizard executable receipt")
		}
	}
	wanted := wizardRegistration(root, o.Channel, "")
	if len(wanted) != len(o.Registration) {
		return errors.New("invalid registration ownership inventory")
	}
	for name, value := range o.Registration {
		if name == "DisplayVersion" {
			if s, err := value.value(); err != nil || !semverPattern.MatchString(s) {
				return errors.New("invalid registered version")
			}
			continue
		}
		expected, ok := wanted[name]
		if !ok || !value.equal(expected) {
			return errors.New("invalid owned registration value")
		}
	}
	if o.Connection != nil {
		if !validInstallerConnection(o.Channel, o.Connection) {
			return errors.New("invalid owned connection receipt")
		}
	}
	return nil
}
func wizardSnapshotFields(b []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		return err
	}
	for _, value := range fields {
		if err := exactObject(value, "exists", "type", "data"); err != nil {
			return err
		}
		var s map[string]json.RawMessage
		_ = json.Unmarshal(value, &s)
		for _, field := range []string{"exists", "type"} {
			if bytes.Equal(bytes.TrimSpace(s[field]), []byte("null")) {
				return errors.New("null registry snapshot identity")
			}
		}
	}
	return nil
}
func wizardRegistration(root, channel, version string) map[string]pathSnapshot {
	helper := filepath.Join(root, "maintenance", "launcher.exe")
	title := "CUDIA"
	if channel == "preview" {
		title = "CUDIA Preview"
	}
	values := map[string]string{"CudiaRoot": root, "DisplayName": title, "DisplayVersion": version, "Publisher": "CUDIA Project", "URLInfoAbout": "https://cyara.com.br", "InstallLocation": root, "DisplayIcon": filepath.Join(root, "bin", "cudia.exe"), "UninstallString": `"` + helper + `" installer uninstall --root "` + root + `"`, "QuietUninstallString": `"` + helper + `" installer uninstall --root "` + root + `" --quiet`}
	out := map[string]pathSnapshot{}
	for name, value := range values {
		out[name] = pathSnapshot{true, syscall.REG_SZ, pathStringBytes(value)}
	}
	for _, name := range []string{"NoModify", "NoRepair"} {
		data := make([]byte, 4)
		binary.LittleEndian.PutUint32(data, 1)
		out[name] = pathSnapshot{true, syscall.REG_DWORD, data}
	}
	return out
}
func sortedWizardNames(values map[string]pathSnapshot) []string {
	names := make([]string, 0, len(values))
	for n := range values {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
func wizardWriteJSON(path string, b []byte, create bool) error {
	if len(b) > maxWizardJournal {
		return errors.New("wizard journal exceeds size limit")
	}
	if create {
		return installWriteAtomicNew(path, b)
	}
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "wizard-*.tmp")
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
func readWizardRegistry(subkey string, names map[string]pathSnapshot) (map[string]pathSnapshot, bool, error) {
	out := map[string]pathSnapshot{}
	for name := range names {
		out[name] = pathSnapshot{}
	}
	p, err := syscall.UTF16PtrFromString(subkey)
	if err != nil {
		return nil, false, err
	}
	var key syscall.Handle
	if err = syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, p, 0, syscall.KEY_QUERY_VALUE, &key); err == syscall.ERROR_FILE_NOT_FOUND {
		return out, false, nil
	} else if err != nil {
		return nil, false, err
	}
	defer syscall.RegCloseKey(key)
	for name := range names {
		n, _ := syscall.UTF16PtrFromString(name)
		var typ, size uint32
		err = syscall.RegQueryValueEx(key, n, nil, &typ, nil, &size)
		if err == syscall.ERROR_FILE_NOT_FOUND {
			continue
		}
		if err != nil {
			return nil, true, err
		}
		if size > maxUserPathBytes {
			return nil, true, errors.New("registration value exceeds size limit")
		}
		data := make([]byte, size+2)
		err = syscall.RegQueryValueEx(key, n, nil, &typ, &data[0], &size)
		if err != nil {
			return nil, true, err
		}
		out[name] = pathSnapshot{true, typ, data[:size]}
	}
	return out, true, nil
}
func writeWizardValue(subkey, name string, value pathSnapshot) error {
	p, err := syscall.UTF16PtrFromString(subkey)
	if err != nil {
		return err
	}
	var key syscall.Handle
	var disposition uint32
	r, _, _ := pathRegCreateKeyEx.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(p)), 0, 0, 0, syscall.KEY_SET_VALUE|syscall.KEY_QUERY_VALUE, 0, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&disposition)))
	if r != 0 {
		return syscall.Errno(r)
	}
	defer syscall.RegCloseKey(key)
	n, _ := syscall.UTF16PtrFromString(name)
	if !value.Exists {
		r, _, _ = pathRegDeleteValue.Call(uintptr(key), uintptr(unsafe.Pointer(n)))
		if r == uintptr(syscall.ERROR_FILE_NOT_FOUND) {
			return nil
		}
	} else {
		var data uintptr
		if len(value.Data) > 0 {
			data = uintptr(unsafe.Pointer(&value.Data[0]))
		}
		r, _, _ = pathRegSetValueEx.Call(uintptr(key), uintptr(unsafe.Pointer(n)), 0, uintptr(value.Type), data, uintptr(len(value.Data)))
	}
	if r != 0 {
		return syscall.Errno(r)
	}
	r, _, _ = pathRegFlushKey.Call(uintptr(key))
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}
func removeEmptyWizardKey(subkey string) error {
	p, err := syscall.UTF16PtrFromString(subkey)
	if err != nil {
		return err
	}
	var key syscall.Handle
	if err = syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, p, 0, syscall.KEY_QUERY_VALUE, &key); err == syscall.ERROR_FILE_NOT_FOUND {
		return nil
	} else if err != nil {
		return err
	}
	var children, values uint32
	err = syscall.RegQueryInfoKey(key, nil, nil, nil, &children, nil, nil, &values, nil, nil, nil, nil)
	syscall.RegCloseKey(key)
	if err != nil {
		return err
	}
	if children != 0 || values != 0 {
		return nil
	}
	r, _, _ := pathAdvapi.NewProc("RegDeleteKeyW").Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(p)))
	if r != 0 && r != uintptr(syscall.ERROR_FILE_NOT_FOUND) {
		return syscall.Errno(r)
	}
	return nil
}
