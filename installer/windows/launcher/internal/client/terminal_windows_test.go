//go:build windows

package client

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"unsafe"
)

func TestTerminalInstalledEngineRestoresModes(t *testing.T) {
	if os.Getenv("CUDIA_TERMINAL_INSTALLED_TEST") != "1" {
		t.Skip("requires a disposable native console and explicit installation path")
	}
	get := kernel32.NewProc("GetConsoleMode")
	mode := func(handle uintptr) uint32 {
		var value uint32
		if ok, _, err := get.Call(handle, uintptr(unsafe.Pointer(&value))); ok == 0 {
			t.Fatalf("native console required: %v", err)
		}
		return value
	}
	input, output := mode(os.Stdin.Fd()), mode(os.Stdout.Fd())
	program := os.Getenv("CUDIA_TERMINAL_INSTALLED_PATH")
	if !filepath.IsAbs(program) {
		t.Fatal("absolute installation path required")
	}
	cmd := exec.Command(program, "--pure")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if report := os.Getenv("CUDIA_TERMINAL_MODE_RESULT"); filepath.IsAbs(report) {
		if err := os.WriteFile(report, []byte("waiting for installed CUDIA exit"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if report := os.Getenv("CUDIA_TERMINAL_MODE_RESULT"); filepath.IsAbs(report) {
		if err := os.WriteFile(report, []byte(fmt.Sprintf("input before=%#x after=%#x output before=%#x after=%#x", input, mode(os.Stdin.Fd()), output, mode(os.Stdout.Fd()))), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if got := mode(os.Stdin.Fd()); got != input {
		t.Fatalf("installed input mode = %#x, want %#x", got, input)
	}
	if got := mode(os.Stdout.Fd()); got != output {
		t.Fatalf("installed output mode = %#x, want %#x", got, output)
	}
	fmt.Println("CUDIA-INSTALLED-NATIVE-MODES-OK")
}

// Run explicitly in a disposable native console. The fixture exits without any
// cleanup, so only the launcher's parent-side recovery can restore these modes.
func TestTerminalParentRecoversAbnormalChild(t *testing.T) {
	if os.Getenv("CUDIA_TERMINAL_NATIVE_TEST") != "1" {
		t.Skip("requires a disposable native console")
	}
	get := kernel32.NewProc("GetConsoleMode")
	mode := func(handle uintptr) uint32 {
		var value uint32
		if ok, _, err := get.Call(handle, uintptr(unsafe.Pointer(&value))); ok == 0 {
			t.Fatalf("native console required: %v", err)
		}
		return value
	}
	input, output := mode(os.Stdin.Fd()), mode(os.Stdout.Fd())
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(t.TempDir(), "engine.exe")
	if err := os.WriteFile(child, data, 0700); err != nil {
		t.Fatal(err)
	}
	code := forward(child, []string{"-test.run=^TestTerminalAbnormalChildFixture$"}, []string{"CUDIA_TERMINAL_CHILD_FIXTURE=1"})
	if code != 23 {
		t.Fatalf("child exit code = %d, want 23", code)
	}
	if got := mode(os.Stdin.Fd()); got != input {
		t.Fatalf("input mode = %#x, want %#x", got, input)
	}
	if got := mode(os.Stdout.Fd()); got != output {
		t.Fatalf("output mode = %#x, want %#x", got, output)
	}
	fmt.Println("CUDIA-PARENT-RECOVERY-OK")
}

func TestTerminalAbnormalChildFixture(t *testing.T) {
	if os.Getenv("CUDIA_TERMINAL_CHILD_FIXTURE") != "1" {
		t.Skip("child fixture only")
	}
	set := kernel32.NewProc("SetConsoleMode")
	get := kernel32.NewProc("GetConsoleMode")
	for handle, want := range map[uintptr]uint32{os.Stdin.Fd(): 0x0200, os.Stdout.Fd(): 0x0001 | 0x0002 | 0x0004} {
		if ok, _, err := set.Call(handle, uintptr(want)); ok == 0 {
			t.Fatalf("set fixture mode: %v", err)
		}
		var got uint32
		if ok, _, err := get.Call(handle, uintptr(unsafe.Pointer(&got))); ok == 0 || got != want {
			t.Fatalf("fixture mode = %#x, want %#x: %v", got, want, err)
		}
	}
	fmt.Print("\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?25l")
	os.Exit(23)
}
