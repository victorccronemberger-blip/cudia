package client

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipEntry struct {
	name string
	data []byte
	mode os.FileMode
}

func zipBytes(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func packageBytes(t *testing.T, p payload, variant string, files map[string][]byte) ([]byte, descriptor) {
	t.Helper()
	d := descriptor{1, "cudia", p.Version, p.Channel, p.Sequence, "windows", "x64", variant, 1, map[string]fileRecord{}}
	entries := []zipEntry{}
	for name, b := range files {
		d.Files[name] = fileRecord{int64(len(b)), digest(b)}
		entries = append(entries, zipEntry{name, b, 0})
	}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, zipEntry{"package.json", b, 0})
	return zipBytes(t, entries), d
}
func testPE(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(os.Getenv("SystemRoot"), "System32", "where.exe"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func smallPackage(t *testing.T, p payload) ([]byte, descriptor) {
	// Real, nonexecuted OS PE input keeps package-level tests independent of
	// compiler output. Only the native workflow executes its own test engine.
	return packageBytes(t, p, "normal", map[string][]byte{"launcher.exe": testPE(t), "runtime/engine.exe": testPE(t), "defaults/release.txt": []byte(p.Version)})
}
func writeArchive(t *testing.T, b []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func TestPackageVerification(t *testing.T) {
	p := testPayload()
	b, d := smallPackage(t, p)
	a := p.Artifacts[0]
	a.Size = int64(len(b))
	a.SHA256 = digest(b)
	dest := t.TempDir()
	out, err := extractPackage(writeArchive(t, b), dest, p, a)
	if err != nil {
		t.Fatal(err)
	}
	if out.Sequence != d.Sequence {
		t.Fatal("descriptor changed")
	}
	if err := verifyTree(dest, d); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dest, "defaults", "release.txt"), []byte("tamper"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyTree(dest, d); err == nil {
		t.Fatal("modified installed file accepted")
	}
}
func TestUnsafePackageNames(t *testing.T) {
	for _, name := range []string{"../evil", "/root", "C:/root", "\\\\server\\share", "a\\b", "a:b", "CON", "con.txt", "CON .txt", "PRN.md", "COM1.txt", "COM1 .txt", "Lpt9", "COM¹.txt", "NUL", "a/../x", "a//b", "a/./b", "a ", "a.", " a", "a\x00b", "a?b", "a\nb", "defaults/"} {
		t.Run(name, func(t *testing.T) {
			if validPath(name) {
				t.Fatal("accepted unsafe path")
			}
		})
	}
	for _, name := range []string{"launcher.exe", "runtime/engine.exe", "defaults/agent/main.md", "defaults/versão.txt"} {
		if !validPath(name) {
			t.Fatal("rejected safe name", name)
		}
	}
	if foldedPath("defaults/S.txt") != foldedPath("defaults/ſ.txt") || foldedPath("defaults/K.txt") != foldedPath("defaults/K.txt") {
		t.Fatal("Unicode case aliases escaped collision check")
	}
}
func TestArchiveAttacks(t *testing.T) {
	p := testPayload()
	_, d := smallPackage(t, p)
	db, _ := json.Marshal(d)
	base := []zipEntry{{"package.json", db, 0}, {"launcher.exe", testPE(t), 0}, {"runtime/engine.exe", testPE(t), 0}, {"defaults/release.txt", []byte(p.Version), 0}}
	cases := []struct {
		name string
		edit func([]zipEntry) []zipEntry
	}{
		{"traversal", func(e []zipEntry) []zipEntry { return append(e, zipEntry{"../outside", nil, 0}) }},
		{"backslash", func(e []zipEntry) []zipEntry { return append(e, zipEntry{"defaults\\evil", nil, 0}) }},
		{"case collision", func(e []zipEntry) []zipEntry { return append(e, zipEntry{"LAUNCHER.EXE", nil, 0}) }},
		{"duplicate", func(e []zipEntry) []zipEntry { return append(e, e[1]) }},
		{"extra", func(e []zipEntry) []zipEntry { return append(e, zipEntry{"extra.txt", nil, 0}) }},
		{"missing", func(e []zipEntry) []zipEntry { return e[:len(e)-1] }},
		{"symlink", func(e []zipEntry) []zipEntry { e[1].mode = os.ModeSymlink | 0777; return e }},
		{"directory", func(e []zipEntry) []zipEntry { return append(e, zipEntry{"defaults/", nil, os.ModeDir | 0700}) }},
		{"corrupt hash", func(e []zipEntry) []zipEntry { e[1].data = []byte(strings.Repeat("x", len(e[1].data))); return e }},
		{"oversized descriptor", func(e []zipEntry) []zipEntry { e[0].data = []byte(strings.Repeat(" ", 1024*1024+1)); return e }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			e := append([]zipEntry{}, base...)
			e = tt.edit(e)
			b := zipBytes(t, e)
			a := p.Artifacts[0]
			a.Size = int64(len(b))
			a.SHA256 = digest(b)
			if _, err := extractPackage(writeArchive(t, b), t.TempDir(), p, a); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
	for _, mutate := range []func(*descriptor){func(d *descriptor) { d.BootstrapABI = 2 }, func(d *descriptor) { d.Files["launcher.exe"] = fileRecord{maxFileBytes + 1, strings.Repeat("a", 64)} }, func(d *descriptor) {
		d.Files["runtime/engine.exe"] = fileRecord{maxFileBytes, strings.Repeat("a", 64)}
		d.Files["launcher.exe"] = fileRecord{maxFileBytes, strings.Repeat("a", 64)}
		d.Files["defaults/extra"] = fileRecord{1, strings.Repeat("a", 64)}
	}} {
		_, d := smallPackage(t, p)
		mutate(&d)
		b, _ := json.Marshal(d)
		if _, err := parseDescriptor(b); err == nil {
			t.Fatal("descriptor limits accepted")
		}
	}
	_, valid := smallPackage(t, p)
	valid.Files["launcher.exe"] = fileRecord{0, digest(nil)}
	raw, _ := json.Marshal(valid)
	if _, err := parseDescriptor(raw); err == nil {
		t.Fatal("empty mandatory executable accepted")
	}
	_, valid = smallPackage(t, p)
	raw, _ = json.Marshal(valid)
	raw = []byte(strings.Replace(string(raw), `"size":`+fmt.Sprint(valid.Files["defaults/release.txt"].Size), `"size":null`, 1))
	if _, err := parseDescriptor(raw); err == nil {
		t.Fatal("null file size accepted")
	}
	files := map[string][]byte{"launcher.exe": []byte("not a PE but hash-valid"), "runtime/engine.exe": testPE(t)}
	badPE, _ := packageBytes(t, p, "normal", files)
	a := p.Artifacts[0]
	if _, err := extractPackage(writeArchive(t, badPE), t.TempDir(), p, a); err == nil {
		t.Fatal("non-PE signed package accepted")
	}
	p2 := p
	p2.Sequence++
	b, _ := smallPackage(t, p2)
	a = p.Artifacts[0]
	if _, err := extractPackage(writeArchive(t, b), t.TempDir(), p, a); err == nil {
		t.Fatal("wrong signed identity accepted")
	}
}
func TestExecutableArchitectureGate(t *testing.T) {
	p := testPayload()
	for _, kind := range []string{"arm64", "dll", "no MZ"} {
		t.Run(kind, func(t *testing.T) {
			b := append([]byte{}, testPE(t)...)
			offset := int(binary.LittleEndian.Uint32(b[0x3c:0x40]))
			switch kind {
			case "arm64":
				binary.LittleEndian.PutUint16(b[offset+4:offset+6], 0xaa64)
			case "dll":
				bits := binary.LittleEndian.Uint16(b[offset+22 : offset+24])
				binary.LittleEndian.PutUint16(b[offset+22:offset+24], bits|0x2000)
			case "no MZ":
				b[0] = 'X'
			}
			archive, _ := packageBytes(t, p, "normal", map[string][]byte{"launcher.exe": b, "runtime/engine.exe": testPE(t)})
			if _, err := extractPackage(writeArchive(t, archive), t.TempDir(), p, p.Artifacts[0]); err == nil {
				t.Fatal("unsupported executable activated")
			}
		})
	}
}
