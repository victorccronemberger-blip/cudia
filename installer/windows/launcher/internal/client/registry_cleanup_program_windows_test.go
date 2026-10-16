//go:build windows

package client

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"
	"unsafe"
)

type registryProgramFixture struct {
	key, ticket, command, file, dir string
	journal                         map[string]interface{}
	body                            []byte
}

func registryProgramUTF16(s string) []byte {
	words := utf16.Encode([]rune(s + "\x00"))
	b := make([]byte, len(words)*2)
	for i, w := range words {
		binary.LittleEndian.PutUint16(b[2*i:], w)
	}
	return b
}
func registryProgramRecord(b []byte) fileRecord {
	return fileRecord{int64(len(b)), fmt.Sprintf("%x", sha256.Sum256(b))}
}
func registryProgramNewFixture(t *testing.T) *registryProgramFixture {
	t.Helper()
	f := &registryProgramFixture{key: fmt.Sprintf(`Software\Cudia.Tests\RegistryProgram\%d-%d`, os.Getpid(), time.Now().UnixNano()), ticket: strings.Repeat("a", 64)}
	base := t.TempDir()
	f.dir = filepath.Join(base, "externo ç 中文 ' $ dados")
	if err := os.Mkdir(f.dir, 0700); err != nil {
		t.Fatal(err)
	}
	f.file = filepath.Join(f.dir, "launcher.exe")
	f.body = []byte("owned private fixture\x00\xff")
	if err := os.WriteFile(f.file, f.body, 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := cleanupSnapshot(f.file, 1024)
	if err != nil {
		t.Fatal(err)
	}
	dirID, err := cleanupDirectoryIdentity(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	normal, quiet, err := registryCleanupCommands(f.key, f.ticket)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("registered command UTF16 units normal=%d quiet=%d", len(utf16.Encode([]rune(normal)))+1, len(utf16.Encode([]rune(quiet)))+1)
	f.command = quiet
	original := wizardRegistration(filepath.Join(base, "installation"), "stable", "1.2.3")
	f.journal = map[string]interface{}{
		"schema": 1, "root": filepath.Join(base, "installation"), "ticket": f.ticket, "channel": "stable", "rootPhase": "tail", "mode": "external-remove", "handoff": true,
		"files":        []interface{}{map[string]interface{}{"path": f.file, "kind": "durable-helper", "state": "confirmed", "record": snapshot.Record, "id": snapshot.ID}},
		"directories":  []interface{}{map[string]interface{}{"path": f.dir, "state": "confirmed", "id": dirID}},
		"nativeValues": original, "nativeRetryValues": map[string]pathSnapshot{},
		"commandRecords": map[string]fileRecord{"UninstallString": registryProgramRecord(registryProgramUTF16(normal)), "QuietUninstallString": registryProgramRecord(registryProgramUTF16(quiet))},
	}
	for n, v := range original {
		if err := writeWizardValue(f.key, n, v); err != nil {
			t.Fatal(err)
		}
	}
	for n, v := range map[string]pathSnapshot{"UninstallString": {true, syscall.REG_SZ, registryProgramUTF16(normal)}, "QuietUninstallString": {true, syscall.REG_SZ, registryProgramUTF16(quiet)}, "CudiaCleanupGeneration": {true, syscall.REG_SZ, registryProgramUTF16(f.ticket)}} {
		if err := writeWizardValue(f.key, n, v); err != nil {
			t.Fatal(err)
		}
	}
	f.write(t, nil)
	t.Cleanup(func() {
		names := []string{"CudiaCleanup", "CudiaCleanupGeneration", "Foreign"}
		for n := range original {
			names = append(names, n)
		}
		for _, n := range names {
			_ = writeWizardValue(f.key, n, pathSnapshot{})
		}
		p, _ := syscall.UTF16PtrFromString(f.key)
		_, _, _ = pathAdvapi.NewProc("RegDeleteKeyW").Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(p)))
	})
	return f
}
func (f *registryProgramFixture) write(t *testing.T, raw []byte) {
	t.Helper()
	if raw == nil {
		var err error
		raw, err = json.Marshal(f.journal)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := writeWizardValue(f.key, "CudiaCleanup", pathSnapshot{true, syscall.REG_BINARY, raw}); err != nil {
		t.Fatal(err)
	}
}
func (f *registryProgramFixture) run(t *testing.T) (string, error) {
	return f.runCommand(t, f.command)
}
func (f *registryProgramFixture) runCommand(t *testing.T, command string) (string, error) {
	t.Helper()
	ps, err := systemPowerShell()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ps)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: command, HideWindow: true}
	for _, e := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(e), "CUDIA_CLEANUP_PARENT_DATA=") {
			cmd.Env = append(cmd.Env, e)
		}
	}
	b, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("bounded private cleanup process timed out: %s", b)
	}
	return string(b), err
}

// Fault injection is confined to this test-only command builder. Production
// command generation accepts only the compile-time program, key and generation.
func registryProgramFaultCommand(t *testing.T, command, program string) string {
	t.Helper()
	marker := "-EncodedCommand "
	i := strings.LastIndex(command, marker)
	if i < 0 {
		t.Fatal("missing command transport")
	}
	b, err := base64.StdEncoding.DecodeString(command[i+len(marker):])
	if err != nil {
		t.Fatal(err)
	}
	words := make([]uint16, len(b)/2)
	for j := range words {
		words[j] = binary.LittleEndian.Uint16(b[2*j:])
	}
	loader := string(utf16.Decode(words))
	start := strings.Index(loader, "$b=[byte[]]('") + len("$b=[byte[]]('")
	end := strings.Index(loader[start:], "'.ToCharArray()") + start
	if start < len("$b=[byte[]]('") || end < start {
		t.Fatal("missing static compressed program")
	}
	var compressed bytes.Buffer
	z, _ := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	_, _ = z.Write([]byte(program))
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	alphabet := make([]rune, compressed.Len())
	for j, v := range compressed.Bytes() {
		alphabet[j] = rune(v) + 256
	}
	loader = loader[:start] + string(alphabet) + loader[end:]
	raw := registryProgramUTF16(loader)
	raw = raw[:len(raw)-2]
	result := command[:i+len(marker)] + base64.StdEncoding.EncodeToString(raw)
	if len(utf16.Encode([]rune(result)))+1 > 32500 {
		t.Fatal("fault command exceeded Windows bound")
	}
	return result
}
func (f *registryProgramFixture) authority(t *testing.T, want bool) {
	t.Helper()
	_, exists, err := readWizardRegistry(f.key, map[string]pathSnapshot{"CudiaCleanup": {}, "CudiaCleanupGeneration": {}, "UninstallString": {}, "QuietUninstallString": {}})
	if err != nil || exists != want {
		t.Fatalf("registry authority exists=%v want=%v err=%v", exists, want, err)
	}
}
func (f *registryProgramFixture) preserved(t *testing.T) {
	t.Helper()
	f.authority(t, true)
	b, err := os.ReadFile(f.file)
	if err != nil || string(b) != string(f.body) {
		t.Fatalf("uncertain target changed: %q %v", b, err)
	}
}

func TestRegistryCleanupProgramCommandData(t *testing.T) {
	key := `Software\Cudia.Tests\RegistryProgram\quotes ' $ ; ( )`
	n, q, err := registryCleanupCommands(key, strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	ps, err := systemPowerShell()
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{n, q} {
		if !strings.HasPrefix(command, `"`+ps+`" -NoLogo -NoProfile -NonInteractive -EncodedCommand `) || strings.Contains(command, key) || len(utf16.Encode([]rune(command)))+1 > 32500 {
			t.Fatal("unsafe or unbounded command")
		}
	}
	if n == q {
		t.Fatal("quiet preference was not transported as data")
	}
	for _, ticket := range []string{"", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("a", 65)} {
		if _, _, err := registryCleanupCommands(key, ticket); err == nil {
			t.Fatal("accepted invalid generation")
		}
	}
	if _, _, err := registryCleanupCommands(`Software\Cudia.Tests\Unicodé`, strings.Repeat("a", 64)); err == nil {
		t.Fatal("accepted noncanonical registry key")
	}
}

func TestRegistryCleanupProgramRegisteredRetry(t *testing.T) {
	f := registryProgramNewFixture(t)
	out, err := f.run(t)
	if err != nil {
		t.Fatalf("actual registered quiet retry failed: %v\n%s", err, out)
	}
	f.authority(t, false)
	if _, err := os.Stat(f.dir); !os.IsNotExist(err) {
		t.Fatalf("external directory survived: %v", err)
	}
}

func TestRegistryCleanupProgramRejectsUncertainty(t *testing.T) {
	for _, kind := range []string{"malformed", "invalid-utf8", "duplicate-root", "duplicate-nested", "unknown-field", "bad-hash", "bad-file-id", "bad-directory-id", "same-bytes-new-file", "reserved-present", "reserved-directory-present", "unknown-registry-value", "changed-original", "wrong-command-raw-bytes", "wrong-generation", "handoff-not-committed", "root-target"} {
		t.Run(kind, func(t *testing.T) {
			f := registryProgramNewFixture(t)
			files := f.journal["files"].([]interface{})
			target := files[0].(map[string]interface{})
			var raw []byte
			switch kind {
			case "malformed":
				raw = []byte(`{"schema":`)
			case "invalid-utf8":
				raw = []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}
			case "duplicate-root":
				b, _ := json.Marshal(f.journal)
				raw = append([]byte(`{"schema":1,`), b[1:]...)
			case "duplicate-nested":
				b, _ := json.Marshal(f.journal)
				raw = []byte(strings.Replace(string(b), `"volume":`, `"volume":0,"volume":`, 1))
			case "unknown-field":
				f.journal["unexpected"] = true
			case "bad-hash":
				r := target["record"].(fileRecord)
				r.SHA256 = strings.Repeat("0", 64)
				target["record"] = r
			case "bad-file-id":
				id := target["id"].(wizardFileID)
				id.Low++
				target["id"] = id
			case "bad-directory-id":
				dir := f.journal["directories"].([]interface{})[0].(map[string]interface{})
				id := dir["id"].(wizardFileID)
				id.Low++
				dir["id"] = id
			case "same-bytes-new-file":
				if err := os.Rename(f.file, f.file+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(f.file, f.body, 0600); err != nil {
					t.Fatal(err)
				}
			case "reserved-present":
				target["state"] = "reserved"
			case "reserved-directory-present":
				f.journal["directories"].([]interface{})[0].(map[string]interface{})["state"] = "reserved"
			case "unknown-registry-value":
				if err := writeWizardValue(f.key, "Foreign", pathSnapshot{true, syscall.REG_BINARY, []byte("foreign")}); err != nil {
					t.Fatal(err)
				}
			case "changed-original":
				original := f.journal["nativeValues"].(map[string]pathSnapshot)
				original["Publisher"] = pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16("Other")}
				if err := writeWizardValue(f.key, "Publisher", original["Publisher"]); err != nil {
					t.Fatal(err)
				}
			case "wrong-command-raw-bytes":
				if err := writeWizardValue(f.key, "QuietUninstallString", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16(f.command + " ")}); err != nil {
					t.Fatal(err)
				}
			case "wrong-generation":
				if err := writeWizardValue(f.key, "CudiaCleanupGeneration", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16(strings.Repeat("b", 64))}); err != nil {
					t.Fatal(err)
				}
			case "handoff-not-committed":
				f.journal["handoff"] = false
			case "root-target":
				f.journal["root"] = f.dir
			}
			f.write(t, raw)
			out, err := f.run(t)
			if err == nil {
				t.Fatalf("uncertainty falsely succeeded: %s", out)
			}
			if strings.Contains(out, "Compiler errors") || strings.Contains(out, "Cannot add type") {
				t.Fatalf("test did not reach validation: %s", out)
			}
			f.preserved(t)
		})
	}
}

func TestRegistryCleanupProgramReadOnlyScanner(t *testing.T) {
	f := registryProgramNewFixture(t)
	p, _ := syscall.UTF16PtrFromString(f.file)
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	out, err := f.run(t)
	if err != nil {
		t.Fatalf("read-only scanner blocked verified POSIX unlink: %v\n%s", err, out)
	}
	f.authority(t, false)
	if _, err := os.Stat(f.file); !os.IsNotExist(err) {
		t.Fatalf("name remained visible: %v", err)
	}
	b := make([]byte, len(f.body))
	var n uint32
	if err := syscall.ReadFile(h, b, &n, nil); err != nil || string(b[:n]) != string(f.body) {
		t.Fatalf("existing reader lost its original data: n=%d err=%v", n, err)
	}
}

func TestRegistryCleanupProgramWriteHolderTimeoutAndRetry(t *testing.T) {
	if testing.Short() {
		t.Skip("real global 45 second sharing deadline")
	}
	f := registryProgramNewFixture(t)
	p, _ := syscall.UTF16PtrFromString(f.file)
	h, err := syscall.CreateFile(p, syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if h != 0 {
			_ = syscall.CloseHandle(h)
		}
	}()
	start := time.Now()
	out, err := f.run(t)
	if err == nil || time.Since(start) < 45*time.Second || time.Since(start) > 65*time.Second {
		t.Fatalf("write holder did not produce bounded global timeout: %v duration=%s\n%s", err, time.Since(start), out)
	}
	f.preserved(t)
	if err := syscall.CloseHandle(h); err != nil {
		t.Fatal(err)
	}
	h = 0
	out, err = f.run(t)
	if err != nil {
		t.Fatalf("same registered command did not recover after writer exited: %v\n%s", err, out)
	}
	f.authority(t, false)
}

func TestRegistryCleanupProgramUnknownDirectoryFileRetainsReceipt(t *testing.T) {
	f := registryProgramNewFixture(t)
	foreign := filepath.Join(f.dir, "unknown-private-fixture.txt")
	if err := os.WriteFile(foreign, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := f.run(t)
	if err == nil {
		t.Fatalf("nonempty directory falsely succeeded: %s", out)
	}
	f.authority(t, true)
	if b, err := os.ReadFile(foreign); err != nil || string(b) != "preserve" {
		t.Fatalf("unknown file changed: %q %v", b, err)
	}
	if err := os.Remove(foreign); err != nil {
		t.Fatal(err)
	}
	out, err = f.run(t)
	if err != nil {
		t.Fatalf("partial registered retry did not complete: %v\n%s", err, out)
	}
	f.authority(t, false)
}

func TestRegistryCleanupProgramExistingMutexPolicy(t *testing.T) {
	for _, kind := range []string{"unprotected", "world-access", "null-dacl", "extra-ace"} {
		t.Run(kind, func(t *testing.T) {
			f := registryProgramNewFixture(t)
			name, policy, err := registrationLockIdentity(f.key)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "unprotected":
				policy = strings.Replace(policy, "D:P", "D:", 1)
			case "world-access":
				policy = strings.SplitN(policy, "D:P", 2)[0] + "D:P(A;;GA;;;WD)"
			case "null-dacl":
				policy = strings.SplitN(policy, "D:P", 2)[0] + "D:NO_ACCESS_CONTROL"
			case "extra-ace":
				policy += "(A;;GA;;;WD)"
			}
			h, err := createRegistrationMutex(name, policy)
			if err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(h)
			out, err := f.run(t)
			if err == nil || !strings.Contains(out, "Existing mutex owner or protected ACL changed") {
				t.Fatalf("permissive existing mutex trusted: %v\n%s", err, out)
			}
			f.preserved(t)
		})
	}
}

func TestRegistryCleanupProgramExactOrphanGeneration(t *testing.T) {
	for _, kind := range []string{"exact", "foreign-value", "wrong-ticket", "changed-original"} {
		t.Run(kind, func(t *testing.T) {
			f := registryProgramNewFixture(t)
			for n, v := range f.journal["nativeValues"].(map[string]pathSnapshot) {
				if err := writeWizardValue(f.key, n, v); err != nil {
					t.Fatal(err)
				}
			}
			if err := writeWizardValue(f.key, "CudiaCleanup", pathSnapshot{}); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "foreign-value":
				if err := writeWizardValue(f.key, "Foreign", pathSnapshot{true, syscall.REG_BINARY, []byte("keep")}); err != nil {
					t.Fatal(err)
				}
			case "wrong-ticket":
				if err := writeWizardValue(f.key, "CudiaCleanupGeneration", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16(strings.Repeat("b", 64))}); err != nil {
					t.Fatal(err)
				}
			case "changed-original":
				if err := writeWizardValue(f.key, "Publisher", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16("Other")}); err != nil {
					t.Fatal(err)
				}
			}
			out, err := f.run(t)
			if (err == nil) != (kind == "exact") {
				t.Fatalf("orphan boundary result: %v\n%s", err, out)
			}
			values, exists, readErr := readWizardRegistry(f.key, map[string]pathSnapshot{"CudiaCleanupGeneration": {}})
			if readErr != nil || !exists || values["CudiaCleanupGeneration"].Exists != (kind != "exact") {
				t.Fatalf("orphan authority changed unexpectedly: %#v %v", values, readErr)
			}
			if b, err := os.ReadFile(f.file); err != nil || string(b) != string(f.body) {
				t.Fatalf("orphan handling adopted a file: %q %v", b, err)
			}
		})
	}
}

func TestRegistryCleanupProgramInterruptionBoundaries(t *testing.T) {
	for _, phase := range []string{"file", "directory", "key"} {
		count := 1
		if phase == "file" {
			count = 3
		}
		if phase == "directory" {
			count = 2
		}
		for index := 1; index <= count; index++ {
			for _, when := range []string{"before", "after"} {
				t.Run(fmt.Sprintf("%s-%d-%s", phase, index, when), func(t *testing.T) {
					f := registryProgramNewFixture(t)
					second := filepath.Join(filepath.Dir(f.dir), "second helper directory")
					if err := os.Mkdir(second, 0700); err != nil {
						t.Fatal(err)
					}
					secondID, err := cleanupDirectoryIdentity(second)
					if err != nil {
						t.Fatal(err)
					}
					paths := []string{f.file, filepath.Join(second, "launcher.exe"), filepath.Join(second, "cleanup.json")}
					files := f.journal["files"].([]interface{})
					for i, p := range paths[1:] {
						if err := os.WriteFile(p, []byte("private owned interruption fixture"), 0600); err != nil {
							t.Fatal(err)
						}
						file, err := cleanupSnapshot(p, 1024)
						if err != nil {
							t.Fatal(err)
						}
						kind := "temp-helper"
						if i == 1 {
							kind = "root-receipt"
						}
						files = append(files, map[string]interface{}{"path": p, "kind": kind, "state": "confirmed", "record": file.Record, "id": file.ID})
					}
					f.journal["files"] = files
					f.journal["directories"] = append(f.journal["directories"].([]interface{}), map[string]interface{}{"path": second, "state": "confirmed", "id": secondID})
					f.write(t, nil)
					program := registryCleanupPowerShell
					failure := `throw Bad("private interruption boundary");`
					switch phase {
					case "file":
						operation := `Need(SetFileInformationByHandle(h,21,new byte[]{3,0,0,0},4),"OS/filesystem refused external POSIX file disposition");`
						guard := fmt.Sprintf("if(fileDeleteIndex==%d){%s}", index, failure)
						body := "fileDeleteIndex++;" + operation + guard
						if when == "before" {
							body = "fileDeleteIndex++;" + guard + operation
						}
						program = strings.Replace(program, "foreach(IntPtr h in held)"+operation, "int fileDeleteIndex=0;foreach(IntPtr h in held){"+body+"}", 1)
					case "directory":
						program = strings.Replace(program, "foreach(object o in order)", "int directoryDeleteIndex=0;foreach(object o in order)", 1)
						operation := `Need(SetFileInformationByHandle(h,4,new byte[]{1},1),"Owned directory is not empty or cannot be removed");`
						guard := fmt.Sprintf("if(directoryDeleteIndex==%d){%s}", index, failure)
						body := "directoryDeleteIndex++;" + operation + guard
						if when == "before" {
							body = "directoryDeleteIndex++;" + guard + operation
						}
						program = strings.Replace(program, operation, body, 1)
					case "key":
						operation := `Need(RegDeleteKeyW(HKCU,key)==0,"Cannot atomically delete cleanup registration");`
						// Keep the branch runtime-dependent: Add-Type treats C#
						// unreachable-code diagnostics as errors under Stop.
						guard := "if(ticket.Length==64){" + failure + "}"
						body := operation + guard
						if when == "before" {
							body = guard + operation
						}
						program = strings.Replace(program, operation, body, 1)
					}
					if program == registryCleanupPowerShell {
						t.Fatal("fault boundary did not match static program")
					}
					command := registryProgramFaultCommand(t, f.command, program)
					out, err := f.runCommand(t, command)
					if err == nil || !strings.Contains(out, "System.IO.IOException: private interruption boundary") {
						t.Fatalf("fault did not reach its boundary: %v\n%s", err, out)
					}
					terminal := phase == "key" && when == "after"
					f.authority(t, !terminal)
					removed := 0
					for _, p := range paths {
						if _, err := os.Stat(p); os.IsNotExist(err) {
							removed++
						} else if err != nil {
							t.Fatal(err)
						}
					}
					wantRemoved := 3
					if phase == "file" {
						wantRemoved = index
						if when == "before" {
							wantRemoved--
						}
					}
					if removed != wantRemoved {
						t.Fatalf("fault removed %d files, want %d", removed, wantRemoved)
					}
					if !terminal {
						out, err = f.run(t)
						if err != nil {
							t.Fatalf("actual untouched registered retry failed after interrupted deletion: %v\n%s", err, out)
						}
					}
					f.authority(t, false)
					for _, dir := range []string{f.dir, second} {
						if _, err := os.Stat(dir); !os.IsNotExist(err) {
							t.Fatalf("completed private cleanup directory remains: %s %v", dir, err)
						}
					}
				})
			}
		}
	}
}

func TestRegistryCleanupProgramRejectsLocalDOSAlias(t *testing.T) {
	f := registryProgramNewFixture(t)
	// Define only a currently unused DOS drive name, pointing exclusively to
	// this fresh private fixture. Exact-match removal cannot remove another
	// target's definition even if another process changes the device stack.
	var device string
	logical, _, _ := kernel32.NewProc("GetLogicalDrives").Call()
	for c := byte('Z'); c >= 'P'; c-- {
		if logical&(uintptr(1)<<uint(c-'A')) == 0 {
			candidate := string([]byte{c, ':'})
			p, _ := syscall.UTF16PtrFromString(candidate)
			var b [32768]uint16
			n, _, err := kernel32.NewProc("QueryDosDeviceW").Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)))
			if n == 0 && err == syscall.ERROR_FILE_NOT_FOUND {
				device = candidate
				break
			}
		}
	}
	if device == "" {
		t.Skip("no unused private drive name available")
	}
	name, _ := syscall.UTF16PtrFromString(device)
	target, _ := syscall.UTF16PtrFromString(`\??\` + filepath.Dir(f.dir))
	define := kernel32.NewProc("DefineDosDeviceW")
	r, _, err := define.Call(1, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(target)))
	if r == 0 {
		t.Fatalf("define fresh private DOS alias: %v", err)
	}
	t.Cleanup(func() {
		if r, _, err := define.Call(1|2|4, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(target))); r == 0 {
			t.Errorf("remove exact private DOS alias: %v", err)
		}
	})
	aliasDir := device + `\` + filepath.Base(f.dir)
	f.journal["files"].([]interface{})[0].(map[string]interface{})["path"] = filepath.Join(aliasDir, "launcher.exe")
	f.journal["directories"].([]interface{})[0].(map[string]interface{})["path"] = aliasDir
	f.write(t, nil)
	out, err := f.run(t)
	if err == nil || !strings.Contains(out, "Held cleanup path is a filesystem alias") {
		t.Fatalf("local drive alias was accepted or validation was not reached: %v\n%s", err, out)
	}
	f.preserved(t)
	t.Log("fresh local DOS alias rejected by normalized held-handle path; original Unicode target and registry authority preserved")
}

func registryProgramHandoffFixture(t *testing.T) *registryProgramFixture {
	t.Helper()
	f := registryProgramNewFixture(t)
	// This is an immutable PE fixture only. These tests never invoke its CLI.
	ps, err := systemPowerShell()
	if err != nil {
		t.Fatal(err)
	}
	f.body, err = os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(ps))), "where.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(f.file, f.body, 0600); err != nil {
		t.Fatal(err)
	}
	helper, err := cleanupSnapshot(f.file, maxBootstrapBytes)
	if err != nil {
		t.Fatal(err)
	}
	file := f.journal["files"].([]interface{})[0].(map[string]interface{})
	file["record"], file["id"] = helper.Record, helper.ID
	receipt := filepath.Join(f.dir, "cleanup.json")
	if err = os.WriteFile(receipt, []byte(`{"private":"immutable root receipt fixture"}`), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := cleanupSnapshot(receipt, maxBootstrapBytes)
	if err != nil {
		t.Fatal(err)
	}
	f.journal["files"] = append(f.journal["files"].([]interface{}), map[string]interface{}{"path": receipt, "kind": "root-receipt", "state": "confirmed", "record": r.Record, "id": r.ID})
	f.journal["handoff"] = false
	command := `"` + f.file + `" installer uninstall --root "` + f.journal["root"].(string) + `"`
	f.journal["nativeRetryValues"] = map[string]pathSnapshot{"UninstallString": {true, syscall.REG_SZ, registryProgramUTF16(command)}, "QuietUninstallString": {true, syscall.REG_SZ, registryProgramUTF16(command + " --quiet")}}
	f.write(t, nil)
	return f
}
func (f *registryProgramFixture) recoveryState(t *testing.T) (registeredCleanup, map[string]pathSnapshot) {
	t.Helper()
	values, exists, err := readWizardRegistry(f.key, map[string]pathSnapshot{"CudiaCleanup": {}, "CudiaCleanupGeneration": {}, "UninstallString": {}, "QuietUninstallString": {}})
	if err != nil || !exists {
		t.Fatalf("missing recovery registration: %v", err)
	}
	var journal registeredCleanup
	if err := json.Unmarshal(values["CudiaCleanup"].Data, &journal); err != nil {
		t.Fatal(err)
	}
	return journal, values
}
func (f *registryProgramFixture) restoredNative(t *testing.T) {
	t.Helper()
	j, values := f.recoveryState(t)
	if j.Mode != "native" || j.Handoff || len(j.CommandRecords) != 0 {
		t.Fatalf("native checkpoint was not completed: mode=%s handoff=%v records=%d", j.Mode, j.Handoff, len(j.CommandRecords))
	}
	for n, v := range f.journal["nativeRetryValues"].(map[string]pathSnapshot) {
		if !values[n].equal(v) {
			t.Fatalf("%s was not restored exactly", n)
		}
	}
	if !values["CudiaCleanupGeneration"].equal(pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16(f.ticket)}) {
		t.Fatal("generation changed")
	}
	f.preserved(t)
	for _, entry := range f.journal["files"].([]interface{}) {
		file := entry.(map[string]interface{})
		if filepath.Dir(file["path"].(string)) != f.dir {
			continue
		}
		snapshot, err := cleanupSnapshot(file["path"].(string), maxBootstrapBytes)
		if err != nil || snapshot.Record != file["record"].(fileRecord) || snapshot.ID != file["id"].(wizardFileID) {
			t.Fatalf("current recovery pair changed: %#v %v", snapshot, err)
		}
	}
}

type registryProgramFileState struct {
	exists bool
	file   cleanupFile
}

func (f *registryProgramFixture) fileStates(t *testing.T) map[string]registryProgramFileState {
	t.Helper()
	states := map[string]registryProgramFileState{}
	for _, o := range f.journal["files"].([]interface{}) {
		path := o.(map[string]interface{})["path"].(string)
		file, err := cleanupSnapshot(path, maxBootstrapBytes)
		if os.IsNotExist(err) {
			states[path] = registryProgramFileState{}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		states[path] = registryProgramFileState{true, file}
	}
	return states
}
func (f *registryProgramFixture) filesUnchanged(t *testing.T, before map[string]registryProgramFileState) {
	t.Helper()
	after := f.fileStates(t)
	for path, state := range before {
		if after[path] != state {
			t.Fatalf("file existence, hash/size or identity changed: %s before=%#v after=%#v", path, state, after[path])
		}
	}
}
func (f *registryProgramFixture) history(t *testing.T, kind string) {
	t.Helper()
	dir := filepath.Join(filepath.Dir(f.dir), "prior owned attempt")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	id, err := cleanupDirectoryIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	f.journal["directories"] = append(f.journal["directories"].([]interface{}), map[string]interface{}{"path": dir, "state": "confirmed", "id": id})
	for _, name := range []string{"launcher.exe", "cleanup.json"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("private historical owned fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		file, err := cleanupSnapshot(path, maxBootstrapBytes)
		if err != nil {
			t.Fatal(err)
		}
		fileKind := "durable-helper"
		if name == "cleanup.json" {
			fileKind = "root-receipt"
		}
		state := "confirmed"
		if kind == "reserved" {
			state = "reserved"
		}
		f.journal["files"] = append(f.journal["files"].([]interface{}), map[string]interface{}{"path": path, "kind": fileKind, "state": state, "record": file.Record, "id": file.ID})
		if kind == "absent" {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}
	}
	if kind == "absent" {
		if err := os.Remove(dir); err != nil {
			t.Fatal(err)
		}
	}
	if kind == "changed-file" {
		if err := os.WriteFile(filepath.Join(dir, "launcher.exe"), []byte("changed owned fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if kind == "changed-directory" {
		d := f.journal["directories"].([]interface{})[1].(map[string]interface{})
		id := d["id"].(wizardFileID)
		id.Low++
		d["id"] = id
	}
	f.write(t, nil)
}

func TestRegistryCleanupProgramInterruptedHandoffRestoresNative(t *testing.T) {
	for _, state := range []string{"both-powershell", "normal-native", "quiet-native", "both-native", "superseded", "normal-instruction-stub", "history-absent", "history-present"} {
		t.Run(state, func(t *testing.T) {
			f := registryProgramHandoffFixture(t)
			if state == "history-absent" {
				f.history(t, "absent")
			}
			if state == "history-present" {
				f.history(t, "present")
			}
			retry := f.journal["nativeRetryValues"].(map[string]pathSnapshot)
			if state == "normal-native" || state == "both-native" {
				if err := writeWizardValue(f.key, "UninstallString", retry["UninstallString"]); err != nil {
					t.Fatal(err)
				}
			}
			if state == "quiet-native" || state == "both-native" {
				if err := writeWizardValue(f.key, "QuietUninstallString", retry["QuietUninstallString"]); err != nil {
					t.Fatal(err)
				}
			}
			if state == "superseded" {
				f.journal["rootPhase"] = "superseded"
				f.write(t, nil)
			}
			command := f.command
			if state == "normal-instruction-stub" {
				values, _, err := readWizardRegistry(f.key, map[string]pathSnapshot{"UninstallString": {}})
				if err != nil {
					t.Fatal(err)
				}
				normal, err := values["UninstallString"].value()
				if err != nil {
					t.Fatal(err)
				}
				program := strings.Replace(registryCleanupPowerShell, `[DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int MessageBoxW(IntPtr h,string t,string c,uint f);`, `static int MessageBoxW(IntPtr h,string t,string c,uint f){Console.WriteLine("private-messagebox:"+t);return 1;}`, 1)
				command = registryProgramFaultCommand(t, normal, program)
			}
			before := f.fileStates(t)
			out, err := f.runCommand(t, command)
			if err == nil || !strings.Contains(out, "Execute a desinstalacao novamente") {
				t.Fatalf("recovery did not report repeat-uninstall required: %v\n%s", err, out)
			}
			if state == "normal-instruction-stub" && !strings.Contains(out, "private-messagebox:A entrada de desinstalacao foi recuperada") {
				t.Fatalf("normal presentation did not select repeat-uninstall instruction: %s", out)
			}
			f.restoredNative(t)
			f.filesUnchanged(t, before)
			// A previously queued external executor cannot acquire deletion
			// authority after the durable native checkpoint revokes its handoff.
			out, err = f.run(t)
			if err == nil || !strings.Contains(out, "External cleanup handoff is not committed") {
				t.Fatalf("delayed external executor accepted native mode: %v\n%s", err, out)
			}
			f.restoredNative(t)
			f.filesUnchanged(t, before)
		})
	}
}

func TestRegistryCleanupProgramInterruptedHandoffRejectsChanges(t *testing.T) {
	for _, change := range []string{"helper-hash", "helper-id", "helper-missing", "helper-reserved", "receipt-hash", "receipt-id", "receipt-missing", "receipt-reserved", "unpaired-receipt", "arbitrary-native-command", "native-expand-string", "generation", "registered-command", "original-value", "incomplete-root", "reserved-directory", "directory-id", "history-changed-file", "history-changed-directory", "history-reserved"} {
		t.Run(change, func(t *testing.T) {
			f := registryProgramHandoffFixture(t)
			if strings.HasPrefix(change, "history-") {
				f.history(t, strings.TrimPrefix(change, "history-"))
			}
			files := f.journal["files"].([]interface{})
			helper := files[0].(map[string]interface{})
			receipt := files[1].(map[string]interface{})
			switch change {
			case "helper-hash", "receipt-hash":
				file := helper
				if change == "receipt-hash" {
					file = receipt
				}
				r := file["record"].(fileRecord)
				r.SHA256 = strings.Repeat("0", 64)
				file["record"] = r
			case "helper-id", "receipt-id":
				file := helper
				if change == "receipt-id" {
					file = receipt
				}
				id := file["id"].(wizardFileID)
				id.Low++
				file["id"] = id
			case "helper-missing", "receipt-missing":
				file := helper
				if change == "receipt-missing" {
					file = receipt
				}
				if err := os.Remove(file["path"].(string)); err != nil {
					t.Fatal(err)
				}
			case "helper-reserved":
				helper["state"] = "reserved"
			case "receipt-reserved":
				receipt["state"] = "reserved"
			case "unpaired-receipt":
				dir := filepath.Join(filepath.Dir(f.dir), "unpaired")
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(dir, "cleanup.json")
				if err := os.Rename(receipt["path"].(string), path); err != nil {
					t.Fatal(err)
				}
				receipt["path"] = path
			case "arbitrary-native-command":
				f.journal["nativeRetryValues"].(map[string]pathSnapshot)["UninstallString"] = pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16("arbitrary native command")}
			case "native-expand-string":
				v := f.journal["nativeRetryValues"].(map[string]pathSnapshot)["QuietUninstallString"]
				v.Type = syscall.REG_EXPAND_SZ
				f.journal["nativeRetryValues"].(map[string]pathSnapshot)["QuietUninstallString"] = v
			case "generation":
				if err := writeWizardValue(f.key, "CudiaCleanupGeneration", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16(strings.Repeat("b", 64))}); err != nil {
					t.Fatal(err)
				}
			case "registered-command":
				if err := writeWizardValue(f.key, "UninstallString", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16("changed registered command")}); err != nil {
					t.Fatal(err)
				}
			case "original-value":
				if err := writeWizardValue(f.key, "Publisher", pathSnapshot{true, syscall.REG_SZ, registryProgramUTF16("changed")}); err != nil {
					t.Fatal(err)
				}
			case "incomplete-root":
				f.journal["rootPhase"] = "root-files"
			case "reserved-directory":
				f.journal["directories"].([]interface{})[0].(map[string]interface{})["state"] = "reserved"
			case "directory-id":
				d := f.journal["directories"].([]interface{})[0].(map[string]interface{})
				id := d["id"].(wizardFileID)
				id.Low++
				d["id"] = id
			}
			f.write(t, nil)
			names := map[string]pathSnapshot{"CudiaCleanup": {}, "CudiaCleanupGeneration": {}, "UninstallString": {}, "QuietUninstallString": {}, "Publisher": {}}
			before, _, err := readWizardRegistry(f.key, names)
			if err != nil {
				t.Fatal(err)
			}
			fileStates := f.fileStates(t)
			out, err := f.run(t)
			if err == nil || strings.Contains(out, "Execute a desinstalacao novamente") {
				t.Fatalf("changed authority was restored: %v\n%s", err, out)
			}
			after, _, err := readWizardRegistry(f.key, names)
			if err != nil {
				t.Fatal(err)
			}
			for n, v := range before {
				if !after[n].equal(v) {
					t.Fatalf("uncertain %s changed", n)
				}
			}
			f.filesUnchanged(t, fileStates)
		})
	}
}

func TestRegistryCleanupProgramInterruptedRestoreCrashBoundaries(t *testing.T) {
	for _, stage := range []string{"command-1", "command-2", "journal"} {
		for _, when := range []string{"before", "after"} {
			t.Run(stage+"-"+when, func(t *testing.T) {
				f := registryProgramHandoffFixture(t)
				before := f.fileStates(t)
				program := registryCleanupPowerShell
				failure := `if(ticket.Length==64)Environment.Exit(86);`
				if stage == "journal" {
					operation := `Need(next.Length<=32768&&RegSetValueExW(k,"CudiaCleanup",0,3,next,(uint)next.Length)==0,"Cannot checkpoint restored native recovery");`
					body := operation + failure
					if when == "before" {
						body = failure + operation
					}
					program = strings.Replace(program, operation, body, 1)
				} else {
					index := 1
					if stage == "command-2" {
						index = 2
					}
					loop := `foreach(string name in new string[]{"UninstallString","QuietUninstallString"}){byte[] bytes=B64(Obj(retry[name])["data"]);`
					program = strings.Replace(program, loop, "int restoreWriteIndex=0;"+loop, 1)
					operation := `Need(RegSetValueExW(k,name,0,1,bytes,(uint)bytes.Length)==0,"Cannot restore durable native retry command");`
					guard := fmt.Sprintf("if(restoreWriteIndex==%d){%s}", index, failure)
					body := "restoreWriteIndex++;" + operation + guard
					if when == "before" {
						body = "restoreWriteIndex++;" + guard + operation
					}
					program = strings.Replace(program, operation, body, 1)
				}
				if program == registryCleanupPowerShell {
					t.Fatal("restore fault did not match static program")
				}
				// Keep the real named mutex alive to exercise WAIT_ABANDONED on retry.
				name, policy, err := registrationLockIdentity(f.key)
				if err != nil {
					t.Fatal(err)
				}
				mutex, err := createRegistrationMutex(name, policy)
				if err != nil {
					t.Fatal(err)
				}
				defer syscall.CloseHandle(mutex)
				out, err := f.runCommand(t, registryProgramFaultCommand(t, f.command, program))
				exit, ok := err.(*exec.ExitError)
				if !ok || exit.ExitCode() != 86 {
					t.Fatalf("private executor did not abruptly exit at restoration boundary: %v\n%s", err, out)
				}
				f.filesUnchanged(t, before)
				j, values := f.recoveryState(t)
				terminal := stage == "journal" && when == "after"
				if terminal {
					f.restoredNative(t)
				} else {
					if j.Mode != "external-remove" || j.Handoff || len(j.CommandRecords) != 2 {
						t.Fatalf("restoration discarded external intent prematurely: mode=%s handoff=%v records=%d", j.Mode, j.Handoff, len(j.CommandRecords))
					}
				}
				restored := 0
				if stage == "command-1" && when == "after" {
					restored = 1
				}
				if stage == "command-2" {
					restored = 1
					if when == "after" {
						restored = 2
					}
				}
				if stage == "journal" {
					restored = 2
				}
				retry := f.journal["nativeRetryValues"].(map[string]pathSnapshot)
				for i, n := range []string{"UninstallString", "QuietUninstallString"} {
					if i < restored {
						if !values[n].equal(retry[n]) {
							t.Fatalf("%s was not restored at boundary", n)
						}
					} else {
						record := j.CommandRecords[n]
						if values[n].Type != syscall.REG_SZ || registryProgramRecord(values[n].Data) != record {
							t.Fatalf("%s lost its literal registered PS recovery", n)
						}
					}
				}
				// When QuietUninstallString is still PS, this is the exact currently
				// registered retry. Once both commands are native, it models an already
				// queued PS executor; the parent integration exercises literal native CLI.
				out, err = f.run(t)
				if terminal {
					if err == nil || !strings.Contains(out, "External cleanup handoff is not committed") {
						t.Fatalf("queued PS accepted completed native checkpoint: %v\n%s", err, out)
					}
				} else {
					if err == nil || !strings.Contains(out, "Execute a desinstalacao novamente") {
						t.Fatalf("interrupted restoration was not recoverable: %v\n%s", err, out)
					}
				}
				f.restoredNative(t)
				f.filesUnchanged(t, before)
			})
		}
	}
}
