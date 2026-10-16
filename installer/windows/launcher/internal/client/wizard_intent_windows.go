//go:build windows

package client

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const maxWizardIntent = 32 * 1024

type wizardIntent struct {
	Schema          int        `json:"schema"`
	Root            string     `json:"root"`
	Ticket          string     `json:"ticket"`
	Variant         string     `json:"variant"`
	Channel         string     `json:"channel"`
	EnvelopeSHA256  string     `json:"envelopeSha256"`
	Bootstrap       fileRecord `json:"bootstrap"`
	PriorActivation string     `json:"priorActivation"`
	PriorConnection []byte     `json:"priorConnection"`
}

func (w wizardCoordinator) createIntentLocked(variant, channel string, envelope []byte, bootstrapSource string) (wizardIntent, error) {
	var intent wizardIntent
	// Never turn a manual low-level prepare (including a committed one) into
	// wizard ownership. Absence is checked while holding the same update lock.
	if _, err := w.u.readInstallPending(""); err == nil {
		return intent, errors.New("a low-level installation transaction exists; recover its original ticket before starting the wizard")
	} else if !os.IsNotExist(err) {
		return intent, err
	}
	bootstrap, err := installReadOptional(bootstrapSource, maxBootstrapBytes)
	if err != nil {
		return intent, err
	}
	if len(bootstrap) == 0 {
		return intent, errors.New("wizard bootstrap unavailable")
	}
	prior, err := installReadOptional(filepath.Join(w.u.root, "state", "activation.json"), maxStateBytes)
	if err != nil {
		return intent, err
	}
	conn, err := installReadOptional(filepath.Join(w.u.root, "connection.json"), 16*1024)
	if err != nil {
		return intent, err
	}
	random := make([]byte, 32)
	if _, err = rand.Read(random); err != nil {
		return intent, err
	}
	intent = wizardIntent{Schema: 1, Root: w.u.root, Ticket: hex.EncodeToString(random), Variant: variant, Channel: channel, EnvelopeSHA256: digest(envelope), Bootstrap: fileRecord{int64(len(bootstrap)), digest(bootstrap)}, PriorConnection: conn}
	if prior != nil {
		intent.PriorActivation = digest(prior)
	}
	b, err := json.Marshal(intent)
	if err != nil {
		return intent, err
	}
	if len(b) > maxWizardIntent {
		return intent, errors.New("wizard intent exceeds limit")
	}
	return intent, installWriteAtomicNew(filepath.Join(w.u.root, "state", "wizard-intent.json"), b)
}
func (w wizardCoordinator) readIntent() (wizardIntent, error) {
	var intent wizardIntent
	b, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-intent.json"), maxWizardIntent)
	if err != nil {
		return intent, err
	}
	if b == nil {
		return intent, os.ErrNotExist
	}
	if err = exactObject(b, "schema", "root", "ticket", "variant", "channel", "envelopeSha256", "bootstrap", "priorActivation", "priorConnection"); err != nil {
		return intent, err
	}
	if err = strictJSON(b, &intent); err != nil {
		return intent, err
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	for name, value := range raw {
		if name != "priorConnection" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return intent, errors.New("null wizard intent field")
		}
	}
	if err = exactObject(raw["bootstrap"], "size", "sha256"); err != nil {
		return intent, err
	}
	if intent.Schema != 1 || intent.Root != w.u.root || !hashPattern.MatchString(intent.Ticket) || !validVariant(intent.Variant) || !validChannel(intent.Channel) || !hashPattern.MatchString(intent.EnvelopeSHA256) || intent.Bootstrap.Size < 1 || intent.Bootstrap.Size > maxBootstrapBytes || !hashPattern.MatchString(intent.Bootstrap.SHA256) || (intent.PriorActivation != "" && !hashPattern.MatchString(intent.PriorActivation)) || len(intent.PriorConnection) > 16*1024 {
		return intent, errors.New("invalid wizard intent identity")
	}
	return intent, nil
}
func (w wizardCoordinator) removeIntent() error {
	path := filepath.Join(w.u.root, "state", "wizard-intent.json")
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
func wizardIntentMatches(intent wizardIntent, p installPending) bool {
	return p.Ticket == intent.Ticket && p.Stage == "install-"+intent.Ticket && p.Variant == intent.Variant && p.Channel == intent.Channel && digest(p.Envelope) == intent.EnvelopeSHA256 && p.Bootstrap == intent.Bootstrap && p.PriorActivation == intent.PriorActivation && bytes.Equal(p.PriorConnection, intent.PriorConnection) && (p.PriorConnection == nil) == (intent.PriorConnection == nil)
}
func (w wizardCoordinator) recoverIntentLocked() error {
	intent, err := w.readIntent()
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	p, pendingErr := w.u.readInstallPending("")
	if pendingErr != nil && !os.IsNotExist(pendingErr) {
		return pendingErr
	}
	if pendingErr == nil && !wizardIntentMatches(intent, p) {
		return errors.New("low-level installation does not match durable wizard intent; preserving both journals")
	}
	if wizard, err := w.readPending(""); err == nil {
		if wizard.Ticket != intent.Ticket || wizard.Owner.Ticket != intent.Ticket || wizard.Owner.Channel != intent.Channel || wizard.Owner.Bootstrap != intent.Bootstrap {
			return errors.New("native wizard journal does not match its intent; preserving recovery metadata")
		}
		if pendingErr == nil && (wizard.Owner.Activation != p.ExpectedActivation || wizard.Owner.Helper != p.Descriptor.Files["launcher.exe"]) {
			return errors.New("complete wizard journal differs from its prepared transaction")
		}
		if pendingErr != nil && !(wizard.ReceiptWritten && w.u.installActivationMatches(wizard.Owner.Activation)) {
			return errors.New("wizard intent has no matching prepared or committed transaction")
		}
		// The complete coordinator journal now owns recovery. Do not abort it or
		// rewrite activation just because removing this earlier intent was interrupted.
		return w.removeIntent()
	} else if !os.IsNotExist(err) {
		return err
	}
	if pendingErr != nil {
		// A completed wizard may have cleaned both journals before a stale intent
		// cleanup reached disk. Only its exact ticket receipt grants that exception.
		b, err := installReadOptional(filepath.Join(w.u.root, "state", "wizard-owner.json"), maxWizardJournal)
		if err != nil {
			return err
		}
		if b != nil {
			var owner wizardOwner
			if err = decodeWizardOwner(b, w.u.root, &owner); err != nil {
				return err
			}
			if owner.Ticket == intent.Ticket && owner.Channel == intent.Channel && owner.Bootstrap == intent.Bootstrap && w.u.installActivationMatches(owner.Activation) {
				if err = w.verifyAppFiles(owner, false); err != nil {
					return err
				}
				return w.removeIntent()
			}
		}
	}
	current, err := installReadOptional(filepath.Join(w.u.root, "state", "activation.json"), maxStateBytes)
	if err != nil {
		return err
	}
	hash := ""
	if current != nil {
		hash = digest(current)
	}
	conn, err := installReadOptional(filepath.Join(w.u.root, "connection.json"), 16*1024)
	if err != nil {
		return err
	}
	if hash != intent.PriorActivation || !bytes.Equal(conn, intent.PriorConnection) || (conn == nil) != (intent.PriorConnection == nil) {
		return errors.New("activation or connection changed after wizard intent; preserving recovery metadata")
	}
	if pendingErr == nil {
		if p.Phase != "prepared" {
			return errors.New("wizard intent cannot claim a committing or committed low-level installation")
		}
		if err = w.cleanupHelperStage(intent.Ticket); err != nil {
			return err
		}
		if err = w.u.abortPreparedInstallLocked(intent.Ticket); err != nil {
			return err
		}
	}
	// No prepared journal means preparation never committed its private staging.
	// Leave any unreceipted partial staging alone; never adopt or recursively
	// erase an observed directory merely because its name resembles this ticket.
	return w.removeIntent()
}
