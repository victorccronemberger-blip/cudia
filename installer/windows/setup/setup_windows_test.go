//go:build windows

package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type fixtureResult struct {
	Args            []string `json:"args"`
	Cwd             string   `json:"cwd"`
	Executable      string   `json:"executable"`
	MarkerPath      string   `json:"markerPath"`
	FinalMarkerPath string   `json:"finalMarkerPath"`
}

func TestRunStagesVerifiedPayloadAndForwardsArguments(t *testing.T) {
	fixturePath, fixture := buildPayloadFixture(t)
	resultDir := t.TempDir()
	resultPhysical, err := physicalDirectory(resultDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CUDIA_SETUP_PROBE_RESULT", filepath.Join(resultPhysical, "direct-child.json"))
	t.Setenv("CUDIA_SETUP_PROBE_TOKEN", "direct-"+strings.ReplaceAll(t.Name(), "/", "-"))
	t.Setenv("CUDIA_SETUP_PROBE_EXIT", "29")

	args := []string{"/VERYSILENT", "/DIR=C:\\Program Files\\CUDIA\\", `quoted"value`, "spaces and 雪"}
	direct := exec.Command(fixturePath, args...)
	if err := direct.Run(); err == nil {
		t.Fatal("fixture unexpectedly exited successfully in direct launch")
	} else if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 29 {
		t.Fatalf("direct fixture launch error = %v, want exit code 29", err)
	}
	t.Setenv("CUDIA_SETUP_PROBE_RESULT", filepath.Join(resultPhysical, "wrapped-child.json"))
	t.Setenv("CUDIA_SETUP_PROBE_TOKEN", "wrapped-"+strings.ReplaceAll(t.Name(), "/", "-"))
	digest := sha256.Sum256(fixture)
	code, err := run(fixture, hex.EncodeToString(digest[:]), args)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(resultPhysical, "wrapped-child.json"))
	if err != nil {
		data, err = os.ReadFile(filepath.Join(resultDir, "wrapped-child.json"))
	}
	if err != nil {
		t.Fatal(err)
	}
	var got fixtureResult
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if code != 29 {
		t.Fatalf("run() exit code = %d, want 29; child result=%#v", code, got)
	}
	if len(got.Args) != len(args) {
		t.Fatalf("child args = %#v, want %#v", got.Args, args)
	}
	for i := range args {
		if got.Args[i] != args[i] {
			t.Fatalf("child args = %#v, want %#v", got.Args, args)
		}
	}
	wantCwd, err := currentPhysicalDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(filepath.Clean(stripExtendedPath(got.Cwd)), filepath.Clean(wantCwd)) {
		t.Fatalf("child cwd = %q, want physical caller cwd %q", got.Cwd, wantCwd)
	}
	if strings.EqualFold(stripExtendedPath(got.Executable), stripExtendedPath(got.MarkerPath)) {
		t.Fatalf("child executable unexpectedly equals marker path: %#v", got)
	}
	if !strings.EqualFold(filepath.Clean(stripExtendedPath(got.MarkerPath)), filepath.Clean(stripExtendedPath(got.FinalMarkerPath))) {
		t.Fatalf("child marker resolved to a redirected path: logical=%q physical=%q", got.MarkerPath, got.FinalMarkerPath)
	}
	if !strings.EqualFold(filepath.Base(got.Executable), "installer.exe") || !strings.HasPrefix(filepath.Base(filepath.Dir(got.Executable)), "cudia-setup-") {
		t.Fatalf("child executable was not launched from the owned staging directory: %q", got.Executable)
	}
	if _, err := os.Stat(got.Executable); !os.IsNotExist(err) {
		t.Fatalf("staged payload still exists after child exit: path=%q error=%v", got.Executable, err)
	}
}

func TestLaunchAndWaitUsesExplorerParent(t *testing.T) {
	_, fixture := buildPayloadFixture(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "payload.exe")
	if err := os.WriteFile(path, fixture, 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	physical, err := finalPath(file.Fd())
	closeErr := file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	physical = createProcessPath(physical)
	resultDir := t.TempDir()
	resultPhysical, err := physicalDirectory(resultDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CUDIA_SETUP_PROBE_RESULT", filepath.Join(resultPhysical, "explorer-child.json"))
	t.Setenv("CUDIA_SETUP_PROBE_TOKEN", "explorer-"+strings.ReplaceAll(t.Name(), "/", "-"))
	t.Setenv("CUDIA_SETUP_PROBE_EXIT", "29")
	parent, err := openDesktopExplorer()
	if err != nil {
		t.Skipf("desktop Explorer is unavailable for native launch test: %v", err)
	}
	defer closeHandle.Call(uintptr(parent))
	cwd, err := currentPhysicalDirectory()
	if err != nil {
		t.Fatal(err)
	}
	code, finished, err := launchAndWait(physical, cwd, []string{"/VERYSILENT"}, parent)
	if err != nil {
		t.Fatal(err)
	}
	if !finished {
		t.Fatal("launchAndWait returned before child exit")
	}
	if code != 29 {
		t.Fatalf("launchAndWait() exit code = %d, want 29", code)
	}
	if _, err := os.Stat(filepath.Join(resultPhysical, "explorer-child.json")); err != nil {
		t.Fatalf("Explorer child did not write result: %v", err)
	}
}

func TestRunRejectsEmptyOrMismatchedPayload(t *testing.T) {
	if _, err := run(nil, strings.Repeat("0", 64), nil); err == nil {
		t.Fatal("run() accepted an empty payload")
	}
	if _, err := run([]byte("not the expected payload"), strings.Repeat("0", 64), nil); err == nil {
		t.Fatal("run() accepted a mismatched payload hash")
	}
}

func TestSuppressMessageBoxOnlyForQuietInnoSwitches(t *testing.T) {
	for _, test := range []struct {
		args []string
		want bool
	}{
		{args: []string{"/verysilent"}, want: true},
		{args: []string{"/SUPPRESSMSGBOXES"}, want: true},
		{args: []string{"/silent"}, want: false},
		{args: []string{"/VERYSILENT=0"}, want: false},
	} {
		if got := suppressMessageBox(test.args); got != test.want {
			t.Errorf("suppressMessageBox(%q) = %t, want %t", test.args, got, test.want)
		}
	}
}

func buildPayloadFixture(t *testing.T) (string, []byte) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "payload.exe")
	goBinary := filepath.Join(runtime.GOROOT(), "bin", "go.exe")
	command := exec.Command(goBinary, "build", "-trimpath", "-buildvcs=false", "-o", path, "./testdata/payload")
	command.Env = fixtureEnvironment(os.Environ())
	command.Dir = "."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build payload fixture: %v\n%s", err, output)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, data
}

func fixtureEnvironment(input []string) []string {
	keys := map[string]bool{"GOTOOLCHAIN": true, "GOOS": true, "GOARCH": true, "CGO_ENABLED": true}
	result := make([]string, 0, len(input)+4)
	for _, value := range input {
		key, _, _ := strings.Cut(value, "=")
		if !keys[strings.ToUpper(key)] {
			result = append(result, value)
		}
	}
	return append(result, "GOTOOLCHAIN=local", "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
}

func physicalDirectory(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return finalPath(file.Fd())
}
