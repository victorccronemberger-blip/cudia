package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(to), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func buildNative(t *testing.T, target, out string) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	module := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go.exe"), "build", "-trimpath", "-o", out, target)
	cmd.Dir = module
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOTOOLCHAIN=local")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("native build: %s: %v", b, err)
	}
}

type engineOutput struct {
	Args     []string          `json:"args"`
	Cwd      string            `json:"cwd"`
	Defaults string            `json:"defaults"`
	Release  string            `json:"release"`
	Env      map[string]string `json:"env"`
}

func cleanEngineEnv(extra ...string) []string {
	env := []string{}
	for _, s := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(s, "=", 2)[0])
		if key == "PATH" || key == "CUDIA_DISTRIBUTION_DIR" || key == "CUDIA_CONTEXT_MODE" || strings.HasPrefix(key, "OPENCODE_") {
			continue
		}
		env = append(env, s)
	}
	return append(env, extra...)
}
func waitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("test helper did not become ready")
}
func TestNativeBootstrapPreservesInvocationAcrossUpdate(t *testing.T) {
	build := t.TempDir()
	bootstrap := filepath.Join(build, "cudia.exe")
	launcher := filepath.Join(build, "launcher.exe")
	engine := filepath.Join(build, "test-engine.exe")
	buildNative(t, "./cmd/bootstrap", bootstrap)
	buildNative(t, "./cmd/launcher", launcher)
	buildNative(t, "./internal/client/testdata/engine", engine)
	launcherBytes, err := os.ReadFile(launcher)
	if err != nil {
		t.Fatal(err)
	}
	engineBytes, err := os.ReadFile(engine)
	if err != nil {
		t.Fatal(err)
	}
	keys, priv := testKeys(t)
	server, u := testServer(t, keys)
	root := filepath.Join(u.root, "Cudia instalação com espaços")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	copyFile(t, filepath.Join(u.root, "connection.json"), filepath.Join(root, "connection.json"))
	u.root = root
	p := testPayload()
	archive, _ := packageBytes(t, p, "normal", map[string][]byte{"launcher.exe": launcherBytes, "runtime/engine.exe": engineBytes, "defaults/release.txt": []byte("old")})
	server.set(t, p, archive, priv)
	if err := u.initialize(context.Background(), "normal", server.manifest, writeArchive(t, archive)); err != nil {
		t.Fatal(err)
	}
	initial, _ := readState(root)
	installed := filepath.Join(root, "bin", "cudia.exe")
	copyFile(t, bootstrap, installed)
	bootstrapBefore, err := os.ReadFile(installed)
	if err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(t.TempDir(), "Projeto ação 東京 with spaces")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	args := []string{"plain", "", "with spaces", `quote"inside`, `C:\trailing\`, `ends space \\`, "Olá 世界", "--version"}
	run := func(args []string, extra ...string) (engineOutput, error, string) {
		cmd := exec.Command(installed, args...)
		cmd.Dir = cwd
		cmd.Env = cleanEngineEnv(append([]string{"PATH=" + filepath.Join(root, "bin")}, extra...)...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		var out engineOutput
		_ = json.Unmarshal(stdout.Bytes(), &out)
		return out, err, stderr.String()
	}
	out, err, stderr := run(args)
	if err != nil {
		t.Fatalf("native forward: %v %s", err, stderr)
	}
	if !reflect.DeepEqual(out.Args, args) || out.Cwd != cwd || out.Release != "old" || out.Defaults != filepath.Join(root, "versions", initial.SelectedReleaseID, "defaults") {
		t.Fatalf("forwarded invocation changed: %#v", out)
	}
	for key, value := range map[string]string{"OPENCODE_DISABLE_CHANNEL_DB": "1", "OPENCODE_EXPERIMENTAL_CODE_MODE": "1", "CUDIA_CONTEXT_MODE": "lean", "OPENCODE_ENABLE_EXA": "1", "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_CONFIG_DIR": ""} {
		if out.Env[key] != value {
			t.Fatalf("%s = %q, want %q", key, out.Env[key], value)
		}
	}
	out, err, stderr = run([]string{"--test-exit", "37"}, "OPENCODE_DISABLE_AUTOUPDATE=0", "CUDIA_DISTRIBUTION_DIR=C:\\untrusted", "CUDIA_CONTEXT_MODE=custom", "OPENCODE_ENABLE_EXA=0", "OPENCODE_CONFIG_DIR=C:\\existing-user-config")
	var exit *exec.ExitError
	if err == nil {
		t.Fatal("lost engine exit code")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 37 {
		t.Fatalf("wrong child exit: %v %s", err, stderr)
	}
	if out.Env["CUDIA_CONTEXT_MODE"] != "custom" || out.Env["OPENCODE_ENABLE_EXA"] != "0" || out.Env["OPENCODE_DISABLE_AUTOUPDATE"] != "1" || out.Env["OPENCODE_CONFIG_DIR"] != "C:\\existing-user-config" {
		t.Fatalf("operator environment changed: %#v", out.Env)
	}
	// This invokes cmd's PATH lookup with no Git/Bun/Node directory on PATH.
	cmd := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "cudia", "path-dispatch")
	cmd.Dir = cwd
	cmd.Env = cleanEngineEnv("PATH=" + filepath.Join(root, "bin"))
	b, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("PATH dispatch failed: %s %v", b, err)
	}
	var viaPath engineOutput
	if err := json.Unmarshal(b, &viaPath); err != nil || !reflect.DeepEqual(viaPath.Args, []string{"path-dispatch"}) {
		t.Fatalf("bad PATH dispatch: %s %v", b, err)
	}
	for _, args := range [][]string{{"update", "--check"}, {"upgrade"}, {"uninstall"}} {
		_, err, stderr := run(args)
		if err == nil || stderr == "" {
			t.Fatal("unsafe/unconfigured management command unexpectedly succeeded", args)
		}
	}
	// Keep an old engine and both wrappers alive while the next version is
	// installed. Windows holds their executable images open during this test.
	ready := filepath.Join(cwd, "ready")
	release := filepath.Join(cwd, "release")
	old := exec.Command(installed, "--test-hold", ready, release)
	old.Dir = cwd
	old.Env = cleanEngineEnv("PATH=" + filepath.Join(root, "bin"))
	var oldOut, oldErr bytes.Buffer
	old.Stdout = &oldOut
	old.Stderr = &oldErr
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if old.ProcessState == nil {
			_ = os.WriteFile(release, nil, 0600)
			_ = old.Wait()
		}
	}()
	waitFile(t, ready)
	p.Sequence = 2
	p.Version = "1.2.4"
	archive, _ = packageBytes(t, p, "normal", map[string][]byte{"launcher.exe": launcherBytes, "runtime/engine.exe": engineBytes, "defaults/release.txt": []byte("new")})
	server.set(t, p, archive, priv)
	if _, err := u.apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	out, err, stderr = run(args)
	if err != nil || out.Release != "new" {
		t.Fatalf("future launch did not use new version: %#v %v %s", out, err, stderr)
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := old.Wait(); err != nil {
		t.Fatalf("old engine failed: %v %s", err, oldErr.String())
	}
	var prior engineOutput
	if err := json.Unmarshal(oldOut.Bytes(), &prior); err != nil || prior.Release != "old" {
		t.Fatalf("running old engine changed: %s %v", oldOut.String(), err)
	}
	bootstrapAfter, err := os.ReadFile(installed)
	if err != nil || !bytes.Equal(bootstrapBefore, bootstrapAfter) {
		t.Fatal("ordinary update replaced bootstrap", err)
	}
}

func TestLockHolderProcess(t *testing.T) {
	if os.Getenv("CUDIA_TEST_LOCK_HELPER") != "1" {
		return
	}
	root := os.Getenv("CUDIA_TEST_ROOT")
	l, err := acquireLock(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer l.close()
	if err := os.WriteFile(filepath.Join(root, "ready"), nil, 0600); err != nil {
		os.Exit(3)
	}
	for {
		time.Sleep(time.Hour)
	}
}
func TestProcessDeathReleasesOSLock(t *testing.T) {
	root := t.TempDir()
	if err := ensureLayout(root); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestLockHolderProcess$")
	cmd.Env = append(os.Environ(), "CUDIA_TEST_LOCK_HELPER=1", "CUDIA_TEST_ROOT="+root)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	waitFile(t, filepath.Join(root, "ready"))
	if l, err := acquireLock(root); err == nil {
		l.close()
		t.Fatal("process lock not held")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	l, err := acquireLock(root)
	if err != nil {
		t.Fatal("dead process retained lock", err)
	}
	l.close()
}
