//go:build windows

package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const setupFailureExitCode = 73

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	createFileW                    = kernel32.NewProc("CreateFileW")
	getFinalPathNameByHandleW      = kernel32.NewProc("GetFinalPathNameByHandleW")
	createProcessW                 = kernel32.NewProc("CreateProcessW")
	initializeProcThreadAttributes = kernel32.NewProc("InitializeProcThreadAttributeList")
	updateProcThreadAttribute      = kernel32.NewProc("UpdateProcThreadAttribute")
	deleteProcThreadAttributeList  = kernel32.NewProc("DeleteProcThreadAttributeList")
	waitForSingleObject            = kernel32.NewProc("WaitForSingleObject")
	getExitCodeProcess             = kernel32.NewProc("GetExitCodeProcess")
	getCurrentProcess              = kernel32.NewProc("GetCurrentProcess")
	getCurrentProcessID            = kernel32.NewProc("GetCurrentProcessId")
	lstrlenW                       = kernel32.NewProc("lstrlenW")
	localFree                      = kernel32.NewProc("LocalFree")
	processIDToSessionID           = kernel32.NewProc("ProcessIdToSessionId")
	openProcess                    = kernel32.NewProc("OpenProcess")
	queryFullProcessImageNameW     = kernel32.NewProc("QueryFullProcessImageNameW")
	closeHandle                    = kernel32.NewProc("CloseHandle")
	user32                         = syscall.NewLazyDLL("user32.dll")
	getShellWindow                 = user32.NewProc("GetShellWindow")
	getWindowThreadProcessID       = user32.NewProc("GetWindowThreadProcessId")
	messageBoxW                    = user32.NewProc("MessageBoxW")
	advapi32                       = syscall.NewLazyDLL("advapi32.dll")
	openProcessToken               = advapi32.NewProc("OpenProcessToken")
	getTokenInformation            = advapi32.NewProc("GetTokenInformation")
	convertSidToStringSidW         = advapi32.NewProc("ConvertSidToStringSidW")
)

type startupInfoEx struct {
	startupInfo syscall.StartupInfo
	attributes  uintptr
}

type processInformation struct {
	process   syscall.Handle
	thread    syscall.Handle
	processID uint32
	threadID  uint32
}

type sidAndAttributes struct {
	sid        uintptr
	attributes uint32
}

// Run starts the embedded installer payload and returns its exit code. Wrapper
// failures use a distinct stable code so callers can report setup errors.
func Run(payload []byte, expectedSHA string, args []string) int {
	code, err := run(payload, expectedSHA, args)
	if err == nil {
		return code
	}
	fmt.Fprintln(os.Stderr, "CUDIA setup:", err)
	if !suppressMessageBox(args) {
		text, _ := syscall.UTF16PtrFromString("CUDIA setup could not start the installer.\n\n" + err.Error())
		caption, _ := syscall.UTF16PtrFromString("CUDIA Setup")
		messageBoxW.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), 0x10)
	}
	return setupFailureExitCode
}

func run(payload []byte, expectedSHA string, args []string) (int, error) {
	if len(payload) == 0 {
		return 0, errors.New("embedded installer payload is empty")
	}
	actualSHA := sha256.Sum256(payload)
	if len(expectedSHA) != 64 || !strings.EqualFold(hex.EncodeToString(actualSHA[:]), expectedSHA) {
		return 0, errors.New("embedded installer payload SHA-256 does not match")
	}

	redirected, err := detectLocalAppDataRedirect()
	if err != nil {
		return 0, fmt.Errorf("check local setup path: %w", err)
	}
	var parent syscall.Handle
	if redirected {
		parent, err = openDesktopExplorer()
		if err != nil {
			return 0, fmt.Errorf("select desktop process for setup: %w", err)
		}
		defer closeHandle.Call(uintptr(parent))
	}

	cwd, err := currentPhysicalDirectory()
	if err != nil {
		return 0, fmt.Errorf("resolve setup working directory: %w", err)
	}

	stageDir, err := os.MkdirTemp("", "cudia-setup-")
	if err != nil {
		return 0, fmt.Errorf("create private installer staging directory: %w", err)
	}
	payloadPath := filepath.Join(stageDir, "installer.exe")
	cleanupStage := true
	defer func() {
		if cleanupStage {
			if err := os.Remove(payloadPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(os.Stderr, "CUDIA setup: could not remove staged installer %q: %v\n", payloadPath, err)
			}
			if err := os.Remove(stageDir); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(os.Stderr, "CUDIA setup: could not remove empty staging directory %q: %v\n", stageDir, err)
			}
		}
	}()
	staged, err := os.OpenFile(payloadPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return 0, fmt.Errorf("stage installer payload: %w", err)
	}
	if _, err := staged.Write(payload); err != nil {
		staged.Close()
		os.Remove(payloadPath)
		return 0, fmt.Errorf("write installer payload: %w", err)
	}
	if err := staged.Sync(); err != nil {
		staged.Close()
		os.Remove(payloadPath)
		return 0, fmt.Errorf("flush installer payload: %w", err)
	}
	if err := staged.Close(); err != nil {
		os.Remove(payloadPath)
		return 0, fmt.Errorf("close installer payload: %w", err)
	}
	staged, err = os.Open(payloadPath)
	if err != nil {
		os.Remove(payloadPath)
		return 0, fmt.Errorf("verify staged installer payload: %w", err)
	}
	stagedHash := sha256.New()
	if _, err := io.Copy(stagedHash, staged); err != nil {
		staged.Close()
		os.Remove(payloadPath)
		return 0, fmt.Errorf("hash staged installer payload: %w", err)
	}
	if err := staged.Close(); err != nil {
		os.Remove(payloadPath)
		return 0, fmt.Errorf("close staged installer payload: %w", err)
	}
	if !strings.EqualFold(hex.EncodeToString(stagedHash.Sum(nil)), expectedSHA) {
		os.Remove(payloadPath)
		return 0, errors.New("staged installer payload SHA-256 does not match")
	}
	staged, err = os.Open(payloadPath)
	if err != nil {
		os.Remove(payloadPath)
		return 0, fmt.Errorf("resolve staged installer path: %w", err)
	}
	physicalPayload, err := finalPath(staged.Fd())
	if closeErr := staged.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(payloadPath)
		return 0, fmt.Errorf("resolve staged installer path: %w", err)
	}
	physicalPayload = createProcessPath(physicalPayload)

	code, childFinished, err := launchAndWait(physicalPayload, cwd, args, parent)
	if err != nil {
		cleanupStage = childFinished
		if !childFinished {
			fmt.Fprintf(os.Stderr, "CUDIA setup: child wait failed; staged installer remains at %q\n", payloadPath)
		}
		return 0, fmt.Errorf("run embedded installer: %w", err)
	}
	if err := os.Remove(payloadPath); err != nil {
		cleanupStage = false
		fmt.Fprintf(os.Stderr, "CUDIA setup: installer exited; could not remove staged payload %q: %v\n", payloadPath, err)
		return code, nil
	}
	if err := os.Remove(stageDir); err != nil {
		cleanupStage = false
		fmt.Fprintf(os.Stderr, "CUDIA setup: installer exited; could not remove empty staging directory %q: %v\n", stageDir, err)
		return code, nil
	}
	cleanupStage = false
	return code, nil
}

func detectLocalAppDataRedirect() (bool, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return false, errors.New("LOCALAPPDATA is not available")
	}
	root, err := filepath.Abs(localAppData)
	if err != nil {
		return false, fmt.Errorf("resolve LOCALAPPDATA: %w", err)
	}
	file, err := os.CreateTemp(root, "cudia-setup-context-*.probe")
	if err != nil {
		return false, fmt.Errorf("create unique local marker: %w", err)
	}
	name := file.Name()
	defer os.Remove(name)
	final, pathErr := finalPath(file.Fd())
	closeErr := file.Close()
	if pathErr != nil {
		return false, pathErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	logical, err := filepath.Abs(name)
	if err != nil {
		return false, fmt.Errorf("resolve local marker path: %w", err)
	}
	return !strings.EqualFold(filepath.Clean(stripExtendedPath(final)), filepath.Clean(logical)), nil
}

func currentPhysicalDirectory() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	path, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return "", err
	}
	handle, _, callErr := createFileW.Call(uintptr(unsafe.Pointer(path)), 0x0080, 0x1|0x2|0x4, 0, 3, 0x02000000, 0)
	if handle == uintptr(syscall.InvalidHandle) {
		return "", callErr
	}
	defer closeHandle.Call(handle)
	final, err := finalPath(handle)
	if err != nil {
		return "", err
	}
	return createProcessPath(final), nil
}

func finalPath(handle uintptr) (string, error) {
	buffer := make([]uint16, 32768)
	length, _, callErr := getFinalPathNameByHandleW.Call(handle, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
	if length == 0 || length >= uintptr(len(buffer)) {
		return "", fmt.Errorf("GetFinalPathNameByHandleW: length=%d: %w", length, callErr)
	}
	return syscall.UTF16ToString(buffer[:length]), nil
}

func stripExtendedPath(path string) string {
	if strings.HasPrefix(path, `\\?\UNC\`) {
		return `\\` + path[len(`\\?\UNC\`):]
	}
	return strings.TrimPrefix(path, `\\?\`)
}

func createProcessPath(path string) string {
	plain := stripExtendedPath(path)
	if len(plain) < 240 {
		return plain
	}
	return path
}

func openDesktopExplorer() (syscall.Handle, error) {
	window, _, callErr := getShellWindow.Call()
	if window == 0 {
		return 0, fmt.Errorf("GetShellWindow: %w", callErr)
	}
	var pid uint32
	threadID, _, callErr := getWindowThreadProcessID.Call(window, uintptr(unsafe.Pointer(&pid)))
	if threadID == 0 || pid == 0 {
		return 0, fmt.Errorf("GetWindowThreadProcessId: %w", callErr)
	}
	handle, _, callErr := openProcess.Call(0x0080|0x1000, 0, uintptr(pid))
	if handle == 0 {
		return 0, fmt.Errorf("OpenProcess desktop: %w", callErr)
	}
	if err := verifyDesktopProcess(syscall.Handle(handle), pid); err != nil {
		closeHandle.Call(handle)
		return 0, err
	}
	return syscall.Handle(handle), nil
}

func verifyDesktopProcess(handle syscall.Handle, pid uint32) error {
	image := make([]uint16, 32768)
	imageSize := uint32(len(image))
	ok, _, callErr := queryFullProcessImageNameW.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&image[0])), uintptr(unsafe.Pointer(&imageSize)))
	if ok == 0 {
		return fmt.Errorf("QueryFullProcessImageNameW: %w", callErr)
	}
	if !strings.EqualFold(filepath.Base(syscall.UTF16ToString(image[:imageSize])), "explorer.exe") {
		return errors.New("shell window is not owned by explorer.exe")
	}

	var callerSession, desktopSession uint32
	callerPID, _, _ := getCurrentProcessID.Call()
	if ok, _, callErr := processIDToSessionID.Call(callerPID, uintptr(unsafe.Pointer(&callerSession))); ok == 0 {
		return fmt.Errorf("ProcessIdToSessionId caller: %w", callErr)
	}
	if ok, _, callErr := processIDToSessionID.Call(uintptr(pid), uintptr(unsafe.Pointer(&desktopSession))); ok == 0 {
		return fmt.Errorf("ProcessIdToSessionId desktop: %w", callErr)
	}
	if callerSession != desktopSession {
		return errors.New("desktop process belongs to a different session")
	}
	callerSID, err := processSID(syscall.Handle(getCurrentProcessPseudoHandle()))
	if err != nil {
		return fmt.Errorf("read caller user SID: %w", err)
	}
	desktopSID, err := processSID(handle)
	if err != nil {
		return fmt.Errorf("read desktop user SID: %w", err)
	}
	if callerSID != desktopSID {
		return errors.New("desktop process belongs to a different user")
	}
	return nil
}

func getCurrentProcessPseudoHandle() uintptr {
	handle, _, _ := getCurrentProcess.Call()
	return handle
}

func processSID(process syscall.Handle) (string, error) {
	var token syscall.Handle
	if ok, _, callErr := openProcessToken.Call(uintptr(process), 0x0008, uintptr(unsafe.Pointer(&token))); ok == 0 {
		return "", callErr
	}
	defer closeHandle.Call(uintptr(token))
	var size uint32
	getTokenInformation.Call(uintptr(token), 1, 0, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return "", errors.New("GetTokenInformation did not return TOKEN_USER size")
	}
	buffer := make([]byte, size)
	if ok, _, callErr := getTokenInformation.Call(uintptr(token), 1, uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return "", callErr
	}
	var sidText *uint16
	if ok, _, callErr := convertSidToStringSidW.Call((*sidAndAttributes)(unsafe.Pointer(&buffer[0])).sid, uintptr(unsafe.Pointer(&sidText))); ok == 0 {
		runtime.KeepAlive(buffer)
		return "", callErr
	}
	length, _, _ := lstrlenW.Call(uintptr(unsafe.Pointer(sidText)))
	if length == 0 {
		localFree.Call(uintptr(unsafe.Pointer(sidText)))
		runtime.KeepAlive(buffer)
		return "", errors.New("ConvertSidToStringSidW returned an empty SID")
	}
	value := syscall.UTF16ToString(unsafe.Slice(sidText, int(length)))
	localFree.Call(uintptr(unsafe.Pointer(sidText)))
	runtime.KeepAlive(buffer)
	return value, nil
}

func launchAndWait(executable, cwd string, args []string, parent syscall.Handle) (int, bool, error) {
	app, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return 0, true, err
	}
	workingDirectory, err := syscall.UTF16PtrFromString(cwd)
	if err != nil {
		return 0, true, err
	}
	commandLine := syscall.EscapeArg(executable)
	for _, arg := range args {
		commandLine += " " + syscall.EscapeArg(arg)
	}
	command, err := syscall.UTF16FromString(commandLine)
	if err != nil {
		return 0, true, err
	}
	startup := startupInfoEx{}
	startup.startupInfo.Cb = uint32(unsafe.Sizeof(syscall.StartupInfo{}))
	creationFlags := uintptr(0x08000000)
	var attributeList []byte
	if parent != 0 {
		var size uintptr
		initializeProcThreadAttributes.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
		if size == 0 {
			return 0, true, errors.New("InitializeProcThreadAttributeList sizing failed")
		}
		attributeList = make([]byte, size)
		if ok, _, callErr := initializeProcThreadAttributes.Call(uintptr(unsafe.Pointer(&attributeList[0])), 1, 0, uintptr(unsafe.Pointer(&size))); ok == 0 {
			return 0, true, fmt.Errorf("InitializeProcThreadAttributeList: %w", callErr)
		}
		defer deleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(&attributeList[0])))
		if ok, _, callErr := updateProcThreadAttribute.Call(uintptr(unsafe.Pointer(&attributeList[0])), 0, 0x00020000, uintptr(unsafe.Pointer(&parent)), unsafe.Sizeof(parent), 0, 0); ok == 0 {
			return 0, true, fmt.Errorf("UpdateProcThreadAttribute parent: %w", callErr)
		}
		startup.attributes = uintptr(unsafe.Pointer(&attributeList[0]))
		startup.startupInfo.Cb = uint32(unsafe.Sizeof(startup))
		creationFlags |= 0x00080000
	}
	var process processInformation
	ok, _, callErr := createProcessW.Call(uintptr(unsafe.Pointer(app)), uintptr(unsafe.Pointer(&command[0])), 0, 0, 0, creationFlags, 0, uintptr(unsafe.Pointer(workingDirectory)), uintptr(unsafe.Pointer(&startup)), uintptr(unsafe.Pointer(&process)))
	if ok == 0 {
		return 0, true, fmt.Errorf("CreateProcessW: %w", callErr)
	}
	defer closeHandle.Call(uintptr(process.thread))
	defer closeHandle.Call(uintptr(process.process))
	if waited, _, callErr := waitForSingleObject.Call(uintptr(process.process), 0xFFFFFFFF); waited != 0 {
		return 0, false, fmt.Errorf("WaitForSingleObject: result=%d: %w", waited, callErr)
	}
	var exitCode uint32
	if ok, _, callErr := getExitCodeProcess.Call(uintptr(process.process), uintptr(unsafe.Pointer(&exitCode))); ok == 0 {
		return 0, true, fmt.Errorf("GetExitCodeProcess: %w", callErr)
	}
	return int(exitCode), true, nil
}

func suppressMessageBox(args []string) bool {
	for _, arg := range args {
		if strings.EqualFold(arg, "/verysilent") || strings.EqualFold(arg, "/suppressmsgboxes") {
			return true
		}
	}
	return false
}
