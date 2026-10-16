package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"unsafe"
)

var (
	kernel32              = syscall.NewLazyDLL("kernel32.dll")
	createFileW           = kernel32.NewProc("CreateFileW")
	getFinalPathByHandleW = kernel32.NewProc("GetFinalPathNameByHandleW")
	closeHandle           = kernel32.NewProc("CloseHandle")
)

type result struct {
	Args            []string `json:"args"`
	Cwd             string   `json:"cwd"`
	Executable      string   `json:"executable"`
	MarkerPath      string   `json:"markerPath"`
	FinalMarkerPath string   `json:"finalMarkerPath"`
}

func main() {
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	executable, err := os.Executable()
	if err != nil {
		panic(err)
	}
	marker := filepath.Join(os.Getenv("LOCALAPPDATA"), "CudiaSetupPayload-"+os.Getenv("CUDIA_SETUP_PROBE_TOKEN")+".txt")
	if err := os.WriteFile(marker, []byte("fixture marker"), 0o600); err != nil {
		panic(err)
	}
	markerFile, err := os.Open(marker)
	if err != nil {
		panic(err)
	}
	finalMarker, err := finalPath(markerFile.Fd())
	closeErr := markerFile.Close()
	if err != nil {
		panic(err)
	}
	if closeErr != nil {
		panic(closeErr)
	}
	data, err := json.Marshal(result{Args: os.Args[1:], Cwd: cwd, Executable: executable, MarkerPath: marker, FinalMarkerPath: finalMarker})
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(os.Getenv("CUDIA_SETUP_PROBE_RESULT"), data, 0o600); err != nil {
		panic(err)
	}
	code, err := strconv.Atoi(os.Getenv("CUDIA_SETUP_PROBE_EXIT"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "missing fixture exit code:", err)
		os.Exit(2)
	}
	os.Exit(code)
}

func finalPath(handle uintptr) (string, error) {
	buffer := make([]uint16, 32768)
	length, _, callErr := getFinalPathByHandleW.Call(handle, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
	if length == 0 || length >= uintptr(len(buffer)) {
		return "", fmt.Errorf("GetFinalPathNameByHandleW: length=%d: %w", length, callErr)
	}
	return syscall.UTF16ToString(buffer[:length]), nil
}
