//go:build windows

package client

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// The launcher owns this fallback: a terminated child cannot restore its console.
func captureChildTerminal(program string) func(int) {
	if !strings.EqualFold(filepath.Base(program), "engine.exe") {
		return func(int) {}
	}
	getMode := kernel32.NewProc("GetConsoleMode")
	setMode := kernel32.NewProc("SetConsoleMode")
	write := kernel32.NewProc("WriteConsoleW")
	input, output := os.Stdin.Fd(), os.Stdout.Fd()
	var inputMode, outputMode uint32
	inOK, _, _ := getMode.Call(input, uintptr(unsafe.Pointer(&inputMode)))
	outOK, _, _ := getMode.Call(output, uintptr(unsafe.Pointer(&outputMode)))
	interactive := inOK != 0 && outOK != 0
	return func(code int) {
		if interactive {
			var current uint32
			if ok, _, _ := getMode.Call(output, uintptr(unsafe.Pointer(&current))); ok != 0 {
				setMode.Call(output, uintptr(current|0x0004))
				text, _ := syscall.UTF16FromString("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?1049l\x1b[0m\x1b[?25h")
				var written uint32
				write.Call(output, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(&written)), 0)
			}
			setMode.Call(input, uintptr(inputMode))
			setMode.Call(output, uintptr(outputMode))
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		data := os.Getenv("XDG_DATA_HOME")
		if data == "" {
			data = filepath.Join(home, ".local", "share")
		}
		log := filepath.Join(data, "opencode", "log", "launcher-exits.jsonl")
		if os.MkdirAll(filepath.Dir(log), 0700) == nil {
			if file, err := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
				json.NewEncoder(file).Encode(struct {
					Time        string `json:"time"`
					PID         int    `json:"pid"`
					ExitCode    int    `json:"exitCode"`
					Interactive bool   `json:"interactive"`
				}{time.Now().UTC().Format(time.RFC3339Nano), os.Getpid(), code, interactive})
				file.Close()
			}
		}
		if interactive && code != 0 {
			fmt.Fprintf(os.Stderr, "CUDIA encerrou com codigo %d. Diagnostico: %s\n", code, log)
		}
	}
}
