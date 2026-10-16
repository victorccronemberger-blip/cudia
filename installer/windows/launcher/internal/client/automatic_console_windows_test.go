//go:build windows

package client

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type automaticConsoleConfig struct{ Root, Ready, Stop string }

func TestAutomaticCompiledConsoleStartsBeforeTLSAndJoinsOnExit(t *testing.T) {
	request, cancelled := make(chan struct{}), make(chan struct{})
	abort := make(chan struct{})
	var once, cancellation sync.Once
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/manifest" {
			t.Errorf("automatic check requested non-manifest URL: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		once.Do(func() { close(request) })
		select {
		case <-r.Context().Done():
			cancellation.Do(func() { close(cancelled) })
		case <-abort:
		}
	}))
	defer server.Close()
	defer close(abort)
	keys, priv := testKeys(t)
	u := &updater{root: t.TempDir(), keys: keys, now: time.Now}
	config := connection{1, "cudia", "stable", server.URL + "/manifest", 24, true}
	b, _ := json.Marshal(config)
	if err := os.WriteFile(filepath.Join(u.root, "connection.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	private := t.TempDir()
	module := filepath.Join(private, "source")
	_, source, _, _ := runtime.Caller(0)
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	err := filepath.WalkDir(moduleRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		if filepath.Ext(path) != ".go" && entry.Name() != "go.mod" && entry.Name() != "trust.json" {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("private source copy rejects symbolic links")
		}
		rel, err := filepath.Rel(moduleRoot, path)
		if err != nil {
			return err
		}
		out := filepath.Join(module, rel)
		if err := os.MkdirAll(filepath.Dir(out), 0700); err != nil {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(out, b, 0600)
	})
	if err != nil {
		t.Fatal(err)
	}
	trust := map[string]string{}
	for id, key := range keys {
		der, err := x509.MarshalPKIXPublicKey(key)
		if err != nil {
			t.Fatal(err)
		}
		trust[id] = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	}
	b, _ = json.Marshal(trust)
	if err := os.WriteFile(filepath.Join(module, "internal", "client", "trust.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	// Only this private build trusts the fixture CA. Production certificate
	// handling is unchanged; the remainder is the real compiled launcher.
	updatePath := filepath.Join(module, "internal", "client", "update.go")
	b, err = os.ReadFile(updatePath)
	if err != nil {
		t.Fatal(err)
	}
	updateSource := strings.ReplaceAll(string(b), "\r\n", "\n")
	marker := "transport.DisableCompression = true"
	if strings.Count(updateSource, marker) != 1 || strings.Count(updateSource, `"context"`) != 1 {
		t.Fatal("private TLS constructor patch no longer matches audited boundary")
	}
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	privateSource := strings.Replace(updateSource, `"context"`, "\"context\"\n\"crypto/tls\"\n\"crypto/x509\"", 1)
	privateSource = strings.Replace(privateSource, marker, marker+"\nfixtureRoots := x509.NewCertPool()\nfixtureRoots.AppendCertsFromPEM([]byte("+strconv.Quote(string(certificate))+"))\ntransport.TLSClientConfig = &tls.Config{RootCAs: fixtureRoots, MinVersion: tls.VersionTLS12}", 1)
	if err := os.WriteFile(updatePath, []byte(privateSource), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("Private TLS profile: source=%s compiled-source=%s CA=%s", digest([]byte(updateSource)), digest([]byte(privateSource)), digest(certificate))
	outputs := map[string]string{"./cmd/bootstrap": "cudia.exe", "./cmd/launcher": "launcher.exe", "./internal/client/testdata/engine": "test-engine.exe"}
	for target, name := range outputs {
		cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go.exe"), "build", "-trimpath", "-o", filepath.Join(private, name), target)
		cmd.Dir = module
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOTOOLCHAIN=local")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("private native build: %v\n%s", err, out)
		}
	}
	launcher, _ := os.ReadFile(filepath.Join(private, "launcher.exe"))
	engine, _ := os.ReadFile(filepath.Join(private, "test-engine.exe"))
	p := testPayload()
	archive, _ := packageBytes(t, p, "normal", map[string][]byte{"launcher.exe": launcher, "runtime/engine.exe": engine, "defaults/release.txt": []byte("automatic console")})
	p.Artifacts[0].Size, p.Artifacts[0].SHA256 = int64(len(archive)), digest(archive)
	if err := u.initialize(context.Background(), "normal", signPayload(t, p, priv), writeArchive(t, archive)); err != nil {
		t.Fatal(err)
	}
	copyFile(t, filepath.Join(private, "cudia.exe"), filepath.Join(u.root, "bin", "cudia.exe"))
	activationPath := filepath.Join(u.root, "state", "activation.json")
	before, _ := os.ReadFile(activationPath)
	c := automaticConsoleConfig{u.root, filepath.Join(private, "engine-ready"), filepath.Join(private, "engine-stop")}
	b, _ = json.Marshal(c)
	configPath := filepath.Join(private, "driver.json")
	if err := os.WriteFile(configPath, b, 0600); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	driver := exec.CommandContext(ctx, self, "-test.run=^TestAutomaticConsoleDriver$", "-test.v")
	driver.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x10, HideWindow: true}
	driver.Env = append(cleanEngineEnv(), "CUDIA_TEST_AUTO_CONSOLE="+configPath)
	var output bytes.Buffer
	driver.Stdout, driver.Stderr = &output, &output
	if err := driver.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var driverErr error
	go func() { driverErr = driver.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = os.WriteFile(c.Stop, []byte("stop owned engine"), 0600)
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cancel()
			<-done
		}
	})
	waitFile(t, c.Ready)
	select {
	case <-request:
	case <-time.After(5 * time.Second):
		_ = os.WriteFile(c.Stop, []byte("stop"), 0600)
		<-done
		t.Fatalf("compiled launcher never checked after real console engine started: %s", output.String())
	}
	if err := os.WriteFile(c.Stop, []byte("stop"), 0600); err != nil {
		t.Fatal(err)
	}
	<-done
	if driverErr != nil {
		t.Fatalf("console driver: %v\n%s", driverErr, output.String())
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("network worker outlived completed wrapper chain")
	}
	if _, err := os.Stat(filepath.Join(u.root, "state", "update-check.json")); !os.IsNotExist(err) {
		t.Fatal("shutdown cancellation persisted a result/backoff", err)
	}
	after, _ := os.ReadFile(activationPath)
	if !bytes.Equal(before, after) {
		t.Fatal("automatic check changed activation")
	}
	lease, err := acquireLifetime(u.root, true)
	if err != nil {
		t.Fatal("joined worker left lifetime occupied", err)
	}
	lease.close()
}

func TestAutomaticConsoleDriver(t *testing.T) {
	path := os.Getenv("CUDIA_TEST_AUTO_CONSOLE")
	if path == "" {
		return
	}
	pids, err := consolePIDs()
	if err != nil || len(pids) != 1 || pids[0] != uint32(os.Getpid()) {
		t.Fatal("fresh isolated console not established", pids, err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var c automaticConsoleConfig
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	in, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile("CONOUT$", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	prompt, _ := json.Marshal(struct{ Ready, Stop string }{c.Ready, c.Stop})
	cmd := exec.Command(filepath.Join(c.Root, "bin", "cudia.exe"), "--prompt", "test-hold:"+string(prompt))
	cmd.Stdin, cmd.Stdout, cmd.Stderr = in, out, out
	cmd.Env = cleanEngineEnv()
	if err := cmd.Run(); err != nil {
		t.Fatal("installed wrapper chain failed", err)
	}
}
