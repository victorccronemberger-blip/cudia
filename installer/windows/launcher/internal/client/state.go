package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

const maxStateBytes = 8 * 1024 * 1024

type installedRecord struct {
	Version       string     `json:"version"`
	Channel       string     `json:"channel"`
	Sequence      int64      `json:"sequence"`
	ArchiveSHA256 string     `json:"archiveSha256"`
	Descriptor    descriptor `json:"descriptor"`
}
type activation struct {
	Schema            int                        `json:"schema"`
	BootstrapABI      int                        `json:"bootstrapABI"`
	Platform          string                     `json:"platform"`
	Arch              string                     `json:"arch"`
	Variant           string                     `json:"variant"`
	SelectedReleaseID string                     `json:"selectedReleaseId"`
	HighestSequence   int64                      `json:"highestSequence"`
	Installed         map[string]installedRecord `json:"installed"`
}

func releaseID(sequence int64, hash string) string {
	return "seq-" + strconv.FormatInt(sequence, 10) + "-" + hash
}
func validateState(s activation) error {
	if s.Schema != 1 || s.BootstrapABI != bootstrapABI || s.Platform != "windows" || s.Arch != "x64" || !validVariant(s.Variant) || s.HighestSequence < 1 || s.HighestSequence > maxSequence || len(s.Installed) < 1 || len(s.Installed) > 128 {
		return errors.New("installation state invalid")
	}
	if _, ok := s.Installed[s.SelectedReleaseID]; !ok {
		return errors.New("selected release is missing")
	}
	seqs := map[int64]string{}
	for id, r := range s.Installed {
		if !hashPattern.MatchString(r.ArchiveSHA256) || id != releaseID(r.Sequence, r.ArchiveSHA256) || r.Sequence > s.HighestSequence || r.Version != r.Descriptor.Version || r.Channel != r.Descriptor.Channel || r.Sequence != r.Descriptor.Sequence || r.Descriptor.Variant != s.Variant {
			return errors.New("installed release identity invalid")
		}
		if err := validateDescriptor(r.Descriptor); err != nil {
			return err
		}
		if prev, ok := seqs[r.Sequence]; ok && prev != id {
			return errors.New("installed sequence conflict")
		}
		seqs[r.Sequence] = id
	}
	return nil
}
func readState(root string) (activation, error) {
	var s activation
	path := filepath.Join(root, "state", "activation.json")
	if err := guardPath(path); err != nil {
		return s, err
	}
	f, err := os.Open(path)
	if err != nil {
		return s, errors.New("installation state unavailable; rerun the signed installer")
	}
	defer f.Close()
	b, err := readCapped(f, maxStateBytes)
	if err != nil {
		return s, err
	}
	if err := exactObject(b, "schema", "bootstrapABI", "platform", "arch", "variant", "selectedReleaseId", "highestSequence", "installed"); err != nil {
		return s, err
	}
	if err := strictJSON(b, &s); err != nil {
		return s, err
	}
	var raw struct {
		Installed map[string]json.RawMessage `json:"installed"`
	}
	_ = json.Unmarshal(jsonSource(b), &raw)
	for _, r := range raw.Installed {
		if err := exactObject(r, "version", "channel", "sequence", "archiveSha256", "descriptor"); err != nil {
			return s, err
		}
		var part struct {
			Descriptor json.RawMessage `json:"descriptor"`
		}
		_ = json.Unmarshal(r, &part)
		if _, err := parseDescriptor(part.Descriptor); err != nil {
			return s, err
		}
	}
	return s, validateState(s)
}
func writeState(root string, s activation) error {
	if err := validateState(s); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if len(b) > maxStateBytes {
		return errors.New("installation history has reached its size limit")
	}
	dir := filepath.Join(root, "state")
	if err := guardPath(dir); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "activation-*.tmp")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)
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
	if err := guardPath(filepath.Join(dir, "activation.json")); err != nil {
		return err
	}
	return atomicReplace(path, filepath.Join(dir, "activation.json"))
}
func ensureLayout(root string) error {
	if err := guardPath(root); err != nil {
		return err
	}
	for _, p := range []string{"state", "state/staging", "versions"} {
		path := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(path, 0700); err != nil {
			return err
		}
		if err := guardPath(path); err != nil {
			return err
		}
	}
	return nil
}
func recordFor(p payload, a artifact, d descriptor) installedRecord {
	return installedRecord{p.Version, p.Channel, p.Sequence, a.SHA256, d}
}
func initialState(variant string, p payload, a artifact, d descriptor) activation {
	id := releaseID(p.Sequence, a.SHA256)
	return activation{1, bootstrapABI, "windows", "x64", variant, id, p.Sequence, map[string]installedRecord{id: recordFor(p, a, d)}}
}
func validateSequence(s activation, p payload, a artifact) error {
	id := releaseID(p.Sequence, a.SHA256)
	for oldID, r := range s.Installed {
		if r.Sequence == p.Sequence && (oldID != id || r.Version != p.Version || r.Channel != p.Channel) {
			return errors.New("release sequence conflicts with verified history")
		}
	}
	if p.Sequence <= s.HighestSequence {
		if id == s.SelectedReleaseID {
			return nil
		}
		return fmt.Errorf("release sequence is not newer than installation history (%d)", s.HighestSequence)
	}
	return nil
}
