package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxInstallJournal = 2 * 1024 * 1024
const maxBootstrapBytes = int64(64 * 1024 * 1024)

type installTicket struct {
	Ticket    string `json:"ticket"`
	ReleaseID string `json:"releaseId"`
	Version   string `json:"version"`
	Variant   string `json:"variant"`
	Channel   string `json:"channel"`
}

type installPending struct {
	Schema             int        `json:"schema"`
	Ticket             string     `json:"ticket"`
	Stage              string     `json:"stage"`
	Variant            string     `json:"variant"`
	Channel            string     `json:"channel"`
	Envelope           []byte     `json:"envelope"`
	Descriptor         descriptor `json:"descriptor"`
	Bootstrap          fileRecord `json:"bootstrap"`
	PriorActivation    string     `json:"priorActivation"`
	PriorConnection    []byte     `json:"priorConnection"`
	PlannedConnection  []byte     `json:"plannedConnection"`
	ExpectedActivation string     `json:"expectedActivation"`
	Phase              string     `json:"phase"`
}

// Preparation only creates private staging and its journal. The working
// bootstrap, connection and activation remain untouched until the wizard commits.
func (u *updater) prepareInstall(ctx context.Context, variant, channel string, envelope []byte, archive, bootstrapSource string) (installTicket, error) {
	var ticket installTicket
	if !validVariant(variant) || !validChannel(channel) {
		return ticket, errors.New("invalid installation variant or channel")
	}
	if err := validateMaintenanceRoot(u.root); err != nil {
		return ticket, err
	}
	if err := ensureLayout(u.root); err != nil {
		return ticket, err
	}
	if err := installRefuseUninstall(u.root); err != nil {
		return ticket, err
	}
	lease, err := acquireLifetime(u.root, false)
	if err != nil {
		return ticket, err
	}
	defer lease.close()
	lock, err := acquireLock(u.root)
	if err != nil {
		return ticket, err
	}
	defer lock.close()
	if err := installRefuseUninstall(u.root); err != nil {
		return ticket, err
	}
	if err := refuseWizardPending(u.root); err != nil {
		return ticket, err
	}
	return u.prepareInstallLocked(ctx, variant, channel, envelope, archive, bootstrapSource)
}

func (u *updater) prepareInstallLocked(ctx context.Context, variant, channel string, envelope []byte, archive, bootstrapSource string) (installTicket, error) {
	return u.prepareInstallTicketLocked(ctx, variant, channel, envelope, archive, bootstrapSource, "")
}

// A native wizard preallocates its private ticket in a durable intent before
// this function can persist install-pending.json. Public callers cannot select it.
func (u *updater) prepareInstallTicketLocked(ctx context.Context, variant, channel string, envelope []byte, archive, bootstrapSource, preparedTicket string) (installTicket, error) {
	var ticket installTicket
	if old, err := u.readInstallPending(""); err == nil {
		if old.Phase != "committed" || !u.installActivationMatches(old.ExpectedActivation) {
			return ticket, errors.New("an installation is pending; commit or abort its ticket before starting another wizard")
		}
		if err := u.cleanupInstallPending(old); err != nil {
			return ticket, err
		}
	} else if !os.IsNotExist(err) {
		return ticket, err
	}
	p, err := verifyEnvelope(envelope, u.keys, channel, u.now())
	if err != nil {
		return ticket, err
	}
	a, err := archiveFor(p, variant)
	if err != nil {
		return ticket, err
	}
	prior, err := installReadOptional(filepath.Join(u.root, "state", "activation.json"), maxStateBytes)
	if err != nil {
		return ticket, err
	}
	if prior != nil {
		s, err := readState(u.root)
		if err != nil {
			return ticket, err
		}
		if s.Variant != variant {
			return ticket, errors.New("bundled package variant differs from installation")
		}
		if err := validateSequence(s, p, a); err != nil {
			return ticket, err
		}
	}
	conn, err := installReadOptional(filepath.Join(u.root, "connection.json"), 16*1024)
	if err != nil {
		return ticket, err
	}
	if conn != nil {
		c, err := readConnection(u.root)
		if err != nil {
			return ticket, err
		}
		if c.Channel != channel {
			return ticket, errors.New("installation channel differs from connection configuration")
		}
	}
	id := preparedTicket
	if id == "" {
		random := make([]byte, 32)
		if _, err := rand.Read(random); err != nil {
			return ticket, err
		}
		id = hex.EncodeToString(random)
	} else if !hashPattern.MatchString(id) {
		return ticket, errors.New("invalid private prepared installation ticket")
	}
	j := installPending{Schema: 1, Ticket: id, Stage: "install-" + id, Variant: variant, Channel: channel, Envelope: append([]byte(nil), envelope...), PriorConnection: conn, Phase: "prepared"}
	if prior != nil {
		j.PriorActivation = digest(prior)
	}
	if conn == nil {
		j.PlannedConnection = installerConnection(channel, true)
	}
	stage := filepath.Join(u.root, "state", "staging", j.Stage)
	if err := os.Mkdir(stage, 0700); err != nil {
		return ticket, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = safeRemove(filepath.Join(u.root, "state", "staging"), stage)
		}
	}()
	if err := installCopyVerified(ctx, archive, filepath.Join(stage, "archive.zip"), fileRecord{a.Size, a.SHA256}); err != nil {
		return ticket, err
	}
	if err := installWriteNew(filepath.Join(stage, "release.json"), envelope); err != nil {
		return ticket, err
	}
	bootstrap, err := installReadOptional(bootstrapSource, maxBootstrapBytes)
	if err != nil || len(bootstrap) == 0 {
		return ticket, errors.New("installer bootstrap unavailable or oversized")
	}
	j.Bootstrap = fileRecord{int64(len(bootstrap)), digest(bootstrap)}
	if err := installWriteNew(filepath.Join(stage, "bootstrap.exe"), bootstrap); err != nil {
		return ticket, err
	}
	if err := verifyPE(filepath.Join(stage, "bootstrap.exe")); err != nil {
		return ticket, err
	}
	existingBootstrap := filepath.Join(u.root, "bin", "cudia.exe")
	if existing, err := installReadOptional(existingBootstrap, maxBootstrapBytes); err != nil {
		return ticket, err
	} else if existing != nil {
		if int64(len(existing)) != j.Bootstrap.Size || digest(existing) != j.Bootstrap.SHA256 {
			return ticket, errors.New("existing bootstrap differs from this installer; use a matching signed installer")
		}
		if err := verifyPE(existingBootstrap); err != nil {
			return ticket, err
		}
	}
	files := filepath.Join(stage, "files")
	if err := os.Mkdir(files, 0700); err != nil {
		return ticket, err
	}
	j.Descriptor, err = extractPackage(filepath.Join(stage, "archive.zip"), files, p, a)
	if err != nil {
		return ticket, err
	}
	if err := verifyTree(files, j.Descriptor); err != nil {
		return ticket, err
	}
	if err := ctx.Err(); err != nil {
		return ticket, err
	}
	next, err := u.installNextState(j, p, a)
	if err != nil {
		return ticket, err
	}
	encoded, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return ticket, err
	}
	j.ExpectedActivation = digest(encoded)
	if err := u.writeInstallPending(j, true); err != nil {
		return ticket, err
	}
	keep = true
	return installTicket{id, releaseID(p.Sequence, a.SHA256), p.Version, variant, channel}, nil
}

func (u *updater) commitPreparedInstall(ctx context.Context, ticket string) error {
	if !hashPattern.MatchString(ticket) {
		return errors.New("invalid installation ticket")
	}
	if err := validateMaintenanceRoot(u.root); err != nil {
		return err
	}
	if err := installRefuseUninstall(u.root); err != nil {
		return err
	}
	lease, err := acquireLifetime(u.root, false)
	if err != nil {
		return err
	}
	defer lease.close()
	lock, err := acquireLock(u.root)
	if err != nil {
		return err
	}
	defer lock.close()
	if err := refuseWizardPending(u.root); err != nil {
		return err
	}
	return u.commitPreparedInstallLocked(ctx, ticket)
}

func (u *updater) commitPreparedInstallLocked(ctx context.Context, ticket string) error {
	if err := installRefuseUninstall(u.root); err != nil {
		return err
	}
	j, err := u.readInstallPending(ticket)
	if err != nil {
		return err
	}
	// Actual atomic activation is the recovery authority, including a process
	// death between the activation rename and the committed journal update.
	if (j.Phase == "committed" || j.ExpectedActivation != j.PriorActivation) && u.installActivationMatches(j.ExpectedActivation) {
		if err := installVerifyFile(filepath.Join(u.root, "bin", "cudia.exe"), j.Bootstrap); err != nil {
			return err
		}
		if err := verifyPE(filepath.Join(u.root, "bin", "cudia.exe")); err != nil {
			return err
		}
		s, err := readState(u.root)
		if err != nil {
			return err
		}
		if err := installVerifyTree(filepath.Join(u.root, "versions", s.SelectedReleaseID), s.Installed[s.SelectedReleaseID].Descriptor); err != nil {
			return err
		}
		j.Phase = "committed"
		_ = u.writeInstallPending(j, false)
		_ = u.cleanupInstallStage(j)
		return nil
	}
	if j.Phase == "committed" {
		return errors.New("committed installation activation has changed")
	}
	p, err := verifyEnvelope(j.Envelope, u.keys, j.Channel, u.now())
	if err != nil {
		return err
	}
	a, err := archiveFor(p, j.Variant)
	if err != nil {
		return err
	}
	if err := u.installCheckPrior(j); err != nil {
		return err
	}
	stage := filepath.Join(u.root, "state", "staging", j.Stage)
	if err := guardPath(stage); err != nil {
		return err
	}
	b, err := installReadOptional(filepath.Join(stage, "release.json"), maxEnvelope)
	if err != nil || !bytes.Equal(b, j.Envelope) {
		return errors.New("prepared release envelope changed")
	}
	if err := installVerifyFile(filepath.Join(stage, "archive.zip"), fileRecord{a.Size, a.SHA256}); err != nil {
		return err
	}
	if err := installVerifyFile(filepath.Join(stage, "bootstrap.exe"), j.Bootstrap); err != nil {
		return err
	}
	if err := verifyPE(filepath.Join(stage, "bootstrap.exe")); err != nil {
		return err
	}
	if err := installVerifyFile(filepath.Join(u.root, "bin", "cudia.exe"), j.Bootstrap); err != nil {
		return errors.New("installed bootstrap does not match the prepared installer bootstrap")
	}
	if err := verifyPE(filepath.Join(u.root, "bin", "cudia.exe")); err != nil {
		return err
	}
	// Re-extraction binds the staged tree's descriptor to the signed archive,
	// rather than trusting descriptor metadata from the local journal alone.
	check, err := os.MkdirTemp(stage, "verify-")
	if err != nil {
		return err
	}
	defer safeRemove(stage, check)
	d, err := extractPackage(filepath.Join(stage, "archive.zip"), check, p, a)
	if err != nil {
		return err
	}
	db, _ := json.Marshal(d)
	jb, _ := json.Marshal(j.Descriptor)
	if !bytes.Equal(db, jb) {
		return errors.New("prepared descriptor changed")
	}
	if err := safeRemove(stage, check); err != nil {
		return err
	}
	files := filepath.Join(stage, "files")
	dest := filepath.Join(u.root, "versions", releaseID(p.Sequence, a.SHA256))
	if err := guardPath(dest); err != nil {
		return err
	}
	if _, err := os.Stat(dest); err == nil {
		if err := installVerifyTree(dest, d); err != nil {
			return err
		}
		if _, err := os.Stat(files); err == nil {
			if err := installVerifyTree(files, d); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	} else {
		if err := installVerifyTree(files, d); err != nil {
			return err
		}
		if err := promote(files, dest); err != nil {
			return err
		}
	}
	next, err := u.installNextState(j, p, a)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if digest(encoded) != j.ExpectedActivation {
		return errors.New("prepared activation identity changed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := u.installCheckPrior(j); err != nil {
		return err
	}
	if _, err := verifyEnvelope(j.Envelope, u.keys, j.Channel, u.now()); err != nil {
		return err
	}
	createdConnection := false
	if j.PriorConnection == nil {
		if j.Phase != "committing" {
			j.Phase = "committing"
			if err := u.writeInstallPending(j, false); err != nil {
				return err
			}
		}
		current, err := installReadOptional(filepath.Join(u.root, "connection.json"), 16*1024)
		if err != nil {
			return err
		}
		if current == nil {
			if err := installWriteAtomicNew(filepath.Join(u.root, "connection.json"), j.PlannedConnection); err != nil {
				return err
			}
			createdConnection = true
		} else if !bytes.Equal(current, j.PlannedConnection) {
			return errors.New("connection configuration changed since preparation")
		}
	}
	if err := writeState(u.root, next); err != nil {
		if createdConnection {
			_ = installRemoveExact(filepath.Join(u.root, "connection.json"), j.PlannedConnection)
		}
		return err
	}
	// All substantive work precedes activation. Cleanup may fail without turning
	// a successful atomic activation into a failed installation.
	j.Phase = "committed"
	_ = u.writeInstallPending(j, false)
	_ = u.cleanupInstallStage(j)
	return nil
}

func (u *updater) abortPreparedInstall(ticket string) error {
	if !hashPattern.MatchString(ticket) {
		return errors.New("invalid installation ticket")
	}
	if err := validateMaintenanceRoot(u.root); err != nil {
		return err
	}
	lease, err := acquireLifetime(u.root, false)
	if err != nil {
		return err
	}
	defer lease.close()
	lock, err := acquireLock(u.root)
	if err != nil {
		return err
	}
	defer lock.close()
	if err := refuseWizardPending(u.root); err != nil {
		return err
	}
	return u.abortPreparedInstallLocked(ticket)
}

func (u *updater) abortPreparedInstallLocked(ticket string) error {
	j, err := u.readInstallPending(ticket)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	// Abort never restores activation or deletes a promoted version. This also
	// makes abort safe after an interrupted successful activation.
	if j.Phase == "committing" && !u.installActivationMatches(j.ExpectedActivation) {
		current, err := installReadOptional(filepath.Join(u.root, "state", "activation.json"), maxStateBytes)
		if err != nil {
			return err
		}
		hash := ""
		if current != nil {
			hash = digest(current)
		}
		if hash == j.PriorActivation {
			path := filepath.Join(u.root, "connection.json")
			b, err := installReadOptional(path, 16*1024)
			if err != nil {
				return err
			}
			if b != nil && bytes.Equal(b, j.PlannedConnection) {
				if err := installRemoveExact(path, j.PlannedConnection); err != nil {
					return err
				}
			}
		}
	}
	return u.cleanupInstallPending(j)
}

func (u *updater) installNextState(j installPending, p payload, a artifact) (activation, error) {
	if j.PriorActivation == "" {
		return initialState(j.Variant, p, a, j.Descriptor), nil
	}
	s, err := readState(u.root)
	if err != nil {
		return s, err
	}
	if s.Variant != j.Variant {
		return s, errors.New("installation variant changed")
	}
	if err := validateSequence(s, p, a); err != nil {
		return s, err
	}
	id := releaseID(p.Sequence, a.SHA256)
	s.Installed[id] = recordFor(p, a, j.Descriptor)
	s.SelectedReleaseID = id
	if p.Sequence > s.HighestSequence {
		s.HighestSequence = p.Sequence
	}
	return s, validateState(s)
}
func (u *updater) installCheckPrior(j installPending) error {
	b, err := installReadOptional(filepath.Join(u.root, "state", "activation.json"), maxStateBytes)
	if err != nil {
		return err
	}
	actual := ""
	if b != nil {
		actual = digest(b)
	}
	if actual != j.PriorActivation {
		return errors.New("installation activation changed since preparation")
	}
	b, err = installReadOptional(filepath.Join(u.root, "connection.json"), 16*1024)
	if err != nil {
		return err
	}
	if !bytes.Equal(b, j.PriorConnection) || (b == nil) != (j.PriorConnection == nil) {
		if j.Phase == "committing" && j.PriorConnection == nil && bytes.Equal(b, j.PlannedConnection) {
			return nil
		}
		return errors.New("connection configuration changed since preparation")
	}
	return nil
}
func (u *updater) installActivationMatches(hash string) bool {
	b, err := installReadOptional(filepath.Join(u.root, "state", "activation.json"), maxStateBytes)
	if err != nil || b == nil || digest(b) != hash {
		return false
	}
	_, err = readState(u.root)
	return err == nil
}
func (u *updater) readInstallPending(ticket string) (installPending, error) {
	var j installPending
	b, err := installReadOptional(filepath.Join(u.root, "state", "install-pending.json"), maxInstallJournal)
	if err != nil {
		return j, err
	}
	if b == nil {
		return j, os.ErrNotExist
	}
	if err := exactObject(b, "schema", "ticket", "stage", "variant", "channel", "envelope", "descriptor", "bootstrap", "priorActivation", "priorConnection", "plannedConnection", "expectedActivation", "phase"); err != nil {
		return j, err
	}
	if err := strictJSON(b, &j); err != nil {
		return j, err
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	if _, err := parseDescriptor(raw["descriptor"]); err != nil {
		return j, err
	}
	if err := exactObject(raw["bootstrap"], "size", "sha256"); err != nil {
		return j, err
	}
	if j.Schema != 1 || !hashPattern.MatchString(j.Ticket) || j.Stage != "install-"+j.Ticket || !validVariant(j.Variant) || !validChannel(j.Channel) || j.Descriptor.Variant != j.Variant || j.Descriptor.Channel != j.Channel || len(j.Envelope) == 0 || len(j.Envelope) > maxEnvelope || j.Bootstrap.Size < 1 || j.Bootstrap.Size > maxBootstrapBytes || !hashPattern.MatchString(j.Bootstrap.SHA256) || (j.PriorActivation != "" && !hashPattern.MatchString(j.PriorActivation)) || !hashPattern.MatchString(j.ExpectedActivation) || (j.Phase != "prepared" && j.Phase != "committing" && j.Phase != "committed") || len(j.PriorConnection) > 16*1024 || len(j.PlannedConnection) > 16*1024 {
		return j, errors.New("installation journal invalid")
	}
	if ticket != "" && (!hashPattern.MatchString(ticket) || ticket != j.Ticket) {
		return j, errors.New("installation ticket does not match the pending installation")
	}
	if j.PriorConnection == nil {
		if !validInstallerConnection(j.Channel, j.PlannedConnection) {
			return j, errors.New("planned connection invalid")
		}
	} else if j.PlannedConnection != nil {
		return j, errors.New("installation journal connection invalid")
	}
	return j, nil
}

func installerConnection(channel string, automatic bool) []byte {
	b, _ := json.Marshal(connection{1, "cudia", channel, "https://cyara.com.br/updates/v1/" + channel + ".json", 24, automatic})
	return b
}

func validInstallerConnection(channel string, b []byte) bool {
	// Existing prepared journals and uninstall receipts retain their original
	// policy. New installations explicitly enable checks in their connection.
	return bytes.Equal(b, installerConnection(channel, false)) || bytes.Equal(b, installerConnection(channel, true))
}
func (u *updater) writeInstallPending(j installPending, create bool) error {
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	if len(b) > maxInstallJournal {
		return errors.New("installation journal exceeds limit")
	}
	path := filepath.Join(u.root, "state", "install-pending.json")
	if create {
		return installWriteAtomicNew(path, b)
	}
	if err := guardPath(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "install-journal-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
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
	return atomicReplace(tmp, path)
}
func (u *updater) cleanupInstallPending(j installPending) error {
	if err := u.cleanupInstallStage(j); err != nil {
		return err
	}
	path := filepath.Join(u.root, "state", "install-pending.json")
	if err := guardPath(path); err != nil {
		return err
	}
	return os.Remove(path)
}

// Remove only enumerated owned files. Unexpected files keep their directory
// and journal available for explicit recovery instead of being erased.
func (u *updater) cleanupInstallStage(j installPending) error {
	stage := filepath.Join(u.root, "state", "staging", j.Stage)
	if err := guardPath(stage); err != nil {
		return err
	}
	for name := range j.Descriptor.Files {
		path := filepath.Join(stage, "files", filepath.FromSlash(name))
		if err := guardPath(path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	for _, name := range []string{"archive.zip", "release.json", "bootstrap.exe"} {
		path := filepath.Join(stage, name)
		if err := guardPath(path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	// Remove directories bottom-up only when empty; never recursively delete.
	var dirs []string
	err := filepath.WalkDir(stage, func(path string, e os.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := guardPath(path); err != nil {
			return err
		}
		if !e.IsDir() {
			return errors.New("unexpected file remains in installation staging")
		}
		dirs = append(dirs, path)
		return nil
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := os.Remove(dirs[i]); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func installReadOptional(path string, limit int64) ([]byte, error) {
	if err := guardPath(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := singleRegularFile(f); err != nil {
		return nil, err
	}
	return readCapped(f, limit)
}
func installWriteNew(path string, b []byte) error {
	if err := guardPath(path); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
func installWriteAtomicNew(path string, b []byte) error {
	if err := guardPath(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "install-new-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
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
	return promote(tmp, path)
}
func installCopyVerified(ctx context.Context, source, dest string, want fileRecord) error {
	if err := guardPath(source); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := singleRegularFile(in); err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, want.Size+1))
	syncErr := out.Sync()
	closeErr := out.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	if copyErr != nil || syncErr != nil || closeErr != nil || n != want.Size || hex.EncodeToString(h.Sum(nil)) != want.SHA256 {
		return errors.New("prepared archive size or hash mismatch")
	}
	return nil
}
func installVerifyFile(path string, want fileRecord) error {
	if err := guardPath(path); err != nil {
		return err
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := singleRegularFile(in); err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(in, want.Size+1))
	if err != nil || n != want.Size || hex.EncodeToString(h.Sum(nil)) != want.SHA256 {
		return errors.New("prepared installation file hash mismatch")
	}
	return nil
}
func installRemoveExact(path string, want []byte) error {
	b, err := installReadOptional(path, int64(len(want)))
	if err != nil {
		return err
	}
	if !bytes.Equal(b, want) {
		return errors.New("connection changed; refusing cleanup")
	}
	return os.Remove(path)
}

func installRefuseUninstall(root string) error {
	for _, name := range []string{"uninstall-pending.json", "wizard-uninstall.json", "wizard-intent.json"} {
		path := filepath.Join(root, "state", name)
		if err := guardPath(path); err != nil {
			return err
		}
		if _, err := os.Lstat(path); err == nil {
			return errors.New("uninstall is pending; retry uninstall before installation")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func refuseWizardPending(root string) error {
	for _, name := range []string{"wizard-pending.json", "wizard-intent.json"} {
		path := filepath.Join(root, "state", name)
		if err := guardMaintenancePath(path); err != nil {
			return err
		}
		if _, err := os.Lstat(path); err == nil {
			return errors.New("native wizard is pending; use wizard-finalize or wizard-abort for recovery")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func installVerifyTree(root string, d descriptor) error {
	if err := verifyTree(root, d); err != nil {
		return err
	}
	dirs := map[string]bool{".": true}
	for name := range d.Files {
		for dir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(name))); dir != "."; dir = filepath.ToSlash(filepath.Dir(filepath.FromSlash(dir))) {
			dirs[dir] = true
		}
	}
	return filepath.WalkDir(root, func(path string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := guardPath(path); err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if e.IsDir() {
			if !dirs[rel] {
				return errors.New("unexpected directory in prepared package")
			}
			return nil
		}
		f, ok := d.Files[rel]
		if !ok || strings.Contains(rel, "\\") {
			return errors.New("unexpected file in prepared package")
		}
		return installVerifyFile(path, f)
	})
}
