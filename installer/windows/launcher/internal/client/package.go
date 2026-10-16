package client

import (
	"archive/zip"
	"crypto/sha256"
	"debug/pe"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

const maxFiles = 4096
const maxFileBytes = int64(512 * 1024 * 1024)
const maxUncompressed = int64(1024 * 1024 * 1024)

type fileRecord struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type descriptor struct {
	Schema       int                   `json:"schema"`
	Product      string                `json:"product"`
	Version      string                `json:"version"`
	Channel      string                `json:"channel"`
	Sequence     int64                 `json:"sequence"`
	Platform     string                `json:"platform"`
	Arch         string                `json:"arch"`
	Variant      string                `json:"variant"`
	BootstrapABI int                   `json:"bootstrapABI"`
	Files        map[string]fileRecord `json:"files"`
}

func validPath(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") || strings.ContainsAny(name, "<>\"|?*") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.TrimSpace(part) != part || strings.TrimRight(part, ". ") != part {
			return false
		}
		for _, r := range part {
			if r < 32 || r == 127 {
				return false
			}
		}
		base := strings.ToUpper(strings.TrimRight(strings.SplitN(part, ".", 2)[0], " "))
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
			return false
		}
		if (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && strings.Contains("|1|2|3|4|5|6|7|8|9|¹|²|³|", "|"+base[3:]+"|") {
			return false
		}
	}
	return true
}

// Use the complete Unicode simple-fold cycle, rather than lowercase alone
// (which misses names such as S versus long-s). Rejecting more collisions than
// a particular Windows filesystem is safe; accepting two aliases is not.
func foldedPath(s string) string {
	return strings.Map(func(r rune) rune {
		smallest := r
		for next := unicode.SimpleFold(r); next != r; next = unicode.SimpleFold(next) {
			if next < smallest {
				smallest = next
			}
		}
		return smallest
	}, s)
}
func allowedFile(name string) bool {
	return name == "launcher.exe" || name == "runtime/engine.exe" || (strings.HasPrefix(name, "defaults/") && len(name) > len("defaults/"))
}
func validateDescriptor(d descriptor) error {
	if d.Schema != 1 || d.Product != "cudia" || len(d.Version) > 128 || !semverPattern.MatchString(d.Version) || !validChannel(d.Channel) || d.Sequence < 1 || d.Sequence > maxSequence || d.Platform != "windows" || d.Arch != "x64" || !validVariant(d.Variant) || d.BootstrapABI != bootstrapABI {
		return errors.New("package identity or bootstrap ABI invalid")
	}
	if len(d.Files) < 2 || len(d.Files) > maxFiles {
		return errors.New("package file count invalid")
	}
	if _, ok := d.Files["launcher.exe"]; !ok {
		return errors.New("package launcher missing")
	}
	if _, ok := d.Files["runtime/engine.exe"]; !ok {
		return errors.New("package engine missing")
	}
	if d.Files["launcher.exe"].Size < 1 || d.Files["runtime/engine.exe"].Size < 1 {
		return errors.New("mandatory package executables must not be empty")
	}
	seen := map[string]bool{}
	var total int64
	for name, f := range d.Files {
		lower := foldedPath(name)
		if !validPath(name) || !allowedFile(name) || seen[lower] || f.Size < 0 || f.Size > maxFileBytes || !hashPattern.MatchString(f.SHA256) {
			return errors.New("package file descriptor invalid")
		}
		seen[lower] = true
		total += f.Size
		if total > maxUncompressed {
			return errors.New("package uncompressed size exceeds limit")
		}
	}
	return nil
}
func parseDescriptor(data []byte) (descriptor, error) {
	var d descriptor
	if len(data) > 1024*1024 {
		return d, errors.New("package descriptor too large")
	}
	if err := exactObject(data, "schema", "product", "version", "channel", "sequence", "platform", "arch", "variant", "bootstrapABI", "files"); err != nil {
		return d, err
	}
	if err := strictJSON(data, &d); err != nil {
		return d, err
	}
	var raw struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	_ = json.Unmarshal(jsonSource(data), &raw)
	for _, f := range raw.Files {
		if err := exactObject(f, "size", "sha256"); err != nil {
			return d, err
		}
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(f, &fields)
		size := strings.TrimSpace(string(fields["size"]))
		if size == "" || size[0] != '-' && (size[0] < '0' || size[0] > '9') {
			return d, errors.New("package file size must be a JSON number")
		}
	}
	return d, validateDescriptor(d)
}

// extractPackage accepts only the package's enumerated regular files. All names
// and the complete descriptor are checked before any payload file is created.
func extractPackage(archive, dest string, p payload, a artifact) (descriptor, error) {
	var d descriptor
	z, err := zip.OpenReader(archive)
	if err != nil {
		return d, errors.New("archive cannot be opened")
	}
	defer z.Close()
	if len(z.File) > maxFiles+1 || len(z.File) < 3 {
		return d, errors.New("archive file count invalid")
	}
	entries := map[string]*zip.File{}
	seen := map[string]bool{}
	for _, f := range z.File {
		name := f.Name
		lower := foldedPath(name)
		if !validPath(name) || seen[lower] || !f.Mode().IsRegular() || f.NonUTF8 {
			return d, errors.New("archive contains unsafe or duplicate entry")
		}
		seen[lower] = true
		entries[name] = f
	}
	f, ok := entries["package.json"]
	if !ok || f.UncompressedSize64 > 1024*1024 {
		return d, errors.New("archive descriptor missing or oversized")
	}
	r, err := f.Open()
	if err != nil {
		return d, err
	}
	b, readErr := readCapped(r, 1024*1024)
	closeErr := r.Close()
	if readErr != nil {
		return d, readErr
	}
	if closeErr != nil {
		return d, closeErr
	}
	d, err = parseDescriptor(b)
	if err != nil {
		return d, err
	}
	if d.Version != p.Version || d.Channel != p.Channel || d.Sequence != p.Sequence || d.Variant != a.Variant {
		return d, errors.New("archive descriptor does not match signed release")
	}
	if len(entries) != len(d.Files)+1 {
		return d, errors.New("archive contains unlisted files")
	}
	for name, f := range d.Files {
		z, ok := entries[name]
		if !ok || z.UncompressedSize64 != uint64(f.Size) {
			return d, errors.New("archive file missing or size mismatch")
		}
	}
	if err := guardPath(dest); err != nil {
		return d, err
	}
	for name, f := range d.Files {
		path := filepath.Join(dest, filepath.FromSlash(name))
		if !contained(dest, path) {
			return d, errors.New("unsafe extraction path")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return d, err
		}
		if err := guardPath(filepath.Dir(path)); err != nil {
			return d, err
		}
		out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return d, err
		}
		in, err := entries[name].Open()
		if err != nil {
			out.Close()
			return d, err
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, f.Size+1))
		inErr := in.Close()
		syncErr := out.Sync()
		outErr := out.Close()
		if copyErr != nil || inErr != nil || syncErr != nil || outErr != nil || n != f.Size || hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
			return d, errors.New("archive file verification failed")
		}
		if name == "launcher.exe" || name == "runtime/engine.exe" {
			if err := verifyPE(path); err != nil {
				return d, err
			}
		}
	}
	return d, nil
}
func verifyTree(root string, d descriptor) error {
	if err := validateDescriptor(d); err != nil {
		return err
	}
	for name, f := range d.Files {
		if err := verifyOne(root, name, f); err != nil {
			return err
		}
	}
	return nil
}
func verifyOne(root, name string, f fileRecord) error {
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := guardPath(path); err != nil {
		return err
	}
	in, err := os.Open(path)
	if err != nil {
		return errors.New("installed file missing")
	}
	stat, err := in.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() != f.Size {
		in.Close()
		return errors.New("installed file size invalid")
	}
	h := sha256.New()
	n, readErr := io.Copy(h, io.LimitReader(in, f.Size+1))
	in.Close()
	if readErr != nil || n != f.Size || hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
		return fmt.Errorf("installed file verification failed: %s", name)
	}
	if name == "launcher.exe" || name == "runtime/engine.exe" {
		return verifyPE(path)
	}
	return nil
}

func verifyPE(path string) error {
	in, err := os.Open(path)
	if err != nil {
		return errors.New("package executable unavailable")
	}
	defer in.Close()
	var dos [64]byte
	if _, err := io.ReadFull(in, dos[:]); err != nil || dos[0] != 'M' || dos[1] != 'Z' {
		return errors.New("package executable requires an MZ/PE header")
	}
	f, err := pe.NewFile(in)
	if err != nil {
		return errors.New("package executable is not a valid Windows PE")
	}
	_, ok := f.OptionalHeader.(*pe.OptionalHeader64)
	if f.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || !ok || f.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 || f.Characteristics&pe.IMAGE_FILE_DLL != 0 {
		return errors.New("package executable must be a Windows x64 PE32+ executable")
	}
	return nil
}
