package client

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
)

func fail(err error) int { fmt.Fprintln(os.Stderr, "cudia:", err); return 1 }
func executablePath() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	p, err = filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if err := guardPath(p); err != nil {
		return "", err
	}
	return p, nil
}
func bootstrapRoot(exe string) (string, error) {
	if !strings.EqualFold(filepath.Base(exe), "cudia.exe") || !strings.EqualFold(filepath.Base(filepath.Dir(exe)), "bin") {
		return "", errors.New("bootstrap must be installed as bin/cudia.exe")
	}
	root := filepath.Dir(filepath.Dir(exe))
	return root, guardPath(root)
}
func launcherRoot(exe string) (string, string, error) {
	dir := filepath.Dir(exe)
	root := filepath.Dir(filepath.Dir(dir))
	if !strings.EqualFold(filepath.Base(exe), "launcher.exe") || !strings.EqualFold(filepath.Base(filepath.Dir(dir)), "versions") {
		return "", "", errors.New("launcher must be installed in a version directory")
	}
	return root, filepath.Base(dir), guardPath(root)
}
func Bootstrap(args []string) int {
	exe, err := executablePath()
	if err != nil {
		return fail(err)
	}
	root, err := bootstrapRoot(exe)
	if err != nil {
		return fail(err)
	}
	lifetime, err := acquireLifetime(root, false)
	if err != nil {
		return fail(err)
	}
	defer lifetime.close()
	if err := checkPendingMaintenance(root, true); err != nil {
		return fail(err)
	}
	s, err := readState(root)
	if err != nil {
		return fail(err)
	}
	release := filepath.Join(root, "versions", s.SelectedReleaseID)
	// Verify the selected launcher's bytes before dispatch. Engine and defaults
	// are checked by that versioned launcher, keeping this ABI small and stable.
	d := s.Installed[s.SelectedReleaseID].Descriptor
	if err := verifyOne(release, "launcher.exe", d.Files["launcher.exe"]); err != nil {
		return fail(err)
	}
	return forward(filepath.Join(release, "launcher.exe"), args, nil)
}
func Launcher(args []string) int {
	if len(args) > 0 && args[0] == "installer" {
		return installerCommand(args[1:])
	}
	if len(args) == 1 && args[0] == "trust-info" {
		keys, err := loadTrust(compiledTrust)
		if err != nil {
			return fail(err)
		}
		b, _ := json.Marshal(struct {
			Schema       int    `json:"schema"`
			BootstrapABI int    `json:"bootstrapABI"`
			TrustedKeys  int    `json:"trustedKeys"`
			TrustSHA256  string `json:"trustSha256"`
		}{1, bootstrapABI, len(keys), digest(compiledTrust)})
		fmt.Println(string(b))
		return 0
	}
	if len(args) > 0 && args[0] == "install-bundled" {
		return installBundled(args[1:])
	}
	exe, err := executablePath()
	if err != nil {
		return fail(err)
	}
	root, id, err := launcherRoot(exe)
	if err != nil {
		return fail(err)
	}
	lifetime, err := acquireLifetime(root, false)
	if err != nil {
		return fail(err)
	}
	defer lifetime.close()
	if err := checkPendingMaintenance(root, true); err != nil {
		return fail(err)
	}
	s, err := readState(root)
	if err != nil {
		return fail(err)
	}
	r, ok := s.Installed[id]
	if !ok {
		return fail(errors.New("this launcher is not in verified installation history"))
	}
	if err := verifyTree(filepath.Dir(exe), r.Descriptor); err != nil {
		return fail(err)
	}
	if len(args) > 0 && args[0] == "update" {
		if len(args) > 2 || len(args) == 2 && args[1] != "--check" {
			return fail(errors.New("usage: cudia update [--check]"))
		}
		u, err := newUpdater(root)
		if err != nil {
			return fail(err)
		}
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
		defer cancel()
		if len(args) == 2 {
			p, _, available, err := u.check(ctx)
			if err != nil {
				return fail(err)
			}
			if available {
				fmt.Printf("Update available: %s (sequence %d). Run cudia update to install.\n", p.Version, p.Sequence)
			} else {
				fmt.Println("Cudia is current.")
			}
			return 0
		}
		fmt.Println("Checking and verifying Cudia update...")
		version, err := u.apply(ctx)
		if err != nil {
			return fail(err)
		}
		fmt.Println("Cudia update:", version, "(effective on the next launch)")
		return 0
	}
	if len(args) > 0 && args[0] == "rollback" {
		if len(args) != 2 {
			return fail(errors.New("usage: cudia rollback <verified-release-id>"))
		}
		u, err := newUpdater(root)
		if err != nil {
			return fail(err)
		}
		if err := u.rollback(args[1]); err != nil {
			return fail(err)
		}
		fmt.Println("Selected verified release:", args[1])
		return 0
	}
	if len(args) > 0 && args[0] == "installation" {
		if len(args) != 2 || args[1] != "info" {
			return fail(errors.New("usage: cudia installation info"))
		}
		keys, err := loadTrust(compiledTrust)
		if err != nil {
			return fail(err)
		}
		info := struct {
			Root                       string     `json:"root"`
			State                      activation `json:"state"`
			TrustSHA256                string     `json:"trustSha256"`
			TrustedKeys                int        `json:"trustedKeys"`
			AutomaticChecksImplemented bool       `json:"automaticChecksImplemented"`
		}{root, s, digest(compiledTrust), len(keys), true}
		b, _ := json.MarshalIndent(info, "", "  ")
		fmt.Println(string(b))
		return 0
	}
	if len(args) > 0 && args[0] == "upgrade" {
		return fail(errors.New("use cudia update to update this Windows installation"))
	}
	if len(args) > 0 && args[0] == "uninstall" {
		return fail(errors.New("use Windows Installed apps or the Cudia installer to uninstall this installation"))
	}
	if automaticConsoleInputOutput() && automaticInteractiveArgs(args) {
		if u, err := newUpdater(root); err == nil {
			if notice := u.automaticNotice(); notice != "" {
				fmt.Println(notice)
			}
			// This defer runs before the shared lifetime lease closes. The worker
			// never writes to the console or changes activation while the TUI runs.
			defer u.startAutomaticCheck()()
		}
	}
	return forward(filepath.Join(filepath.Dir(exe), "runtime", "engine.exe"), args, []string{"CUDIA_DISTRIBUTION_DIR=" + filepath.Join(filepath.Dir(exe), "defaults")})
}
func forward(program string, args, extraEnv []string) (code int) {
	restore := captureChildTerminal(program)
	defer func() { restore(code) }()
	cmd := exec.Command(program, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if extraEnv != nil {
		for _, value := range os.Environ() {
			if !strings.HasPrefix(strings.ToUpper(value), "CUDIA_DISTRIBUTION_DIR=") && !strings.HasPrefix(strings.ToUpper(value), "OPENCODE_DISABLE_AUTOUPDATE=") {
				cmd.Env = append(cmd.Env, value)
			}
		}
		cmd.Env = append(cmd.Env, extraEnv...)
		cmd.Env = append(cmd.Env, "OPENCODE_DISABLE_AUTOUPDATE=1")
		for _, value := range []string{"OPENCODE_DISABLE_CHANNEL_DB=1", "OPENCODE_EXPERIMENTAL_CODE_MODE=1", "CUDIA_CONTEXT_MODE=lean", "OPENCODE_ENABLE_EXA=1"} {
			key := strings.SplitN(value, "=", 2)[0]
			found := false
			for _, existing := range cmd.Env {
				if strings.EqualFold(strings.SplitN(existing, "=", 2)[0], key) {
					found = true
					break
				}
			}
			if !found {
				cmd.Env = append(cmd.Env, value)
			}
		}
	}
	// Console children share their parent's console and receive its Ctrl+C.
	// Wrappers wait for the child's own exit status instead of exiting early.
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		return fail(errors.New("cannot start the installed Cudia executable"))
	}
	return 0
}
func installBundled(args []string) int {
	fs := flag.NewFlagSet("install-bundled", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	root := fs.String("root", "", "installation root")
	manifest := fs.String("manifest", "", "signed manifest file")
	archive := fs.String("archive", "", "archive file")
	variant := fs.String("variant", "normal", "archive variant")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || !filepath.IsAbs(*root) || !filepath.IsAbs(*manifest) || !filepath.IsAbs(*archive) {
		return fail(errors.New("usage: launcher.exe install-bundled --root ABS --manifest ABS --archive ABS [--variant normal|baseline]"))
	}
	if err := guardPath(*root); err != nil {
		return fail(err)
	}
	f, err := os.Open(*manifest)
	if err != nil {
		return fail(errors.New("bundled manifest unavailable"))
	}
	b, err := readCapped(f, maxEnvelope)
	f.Close()
	if err != nil {
		return fail(err)
	}
	u, err := newUpdater(filepath.Clean(*root))
	if err != nil {
		return fail(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := u.initialize(ctx, *variant, b, *archive); err != nil {
		return fail(err)
	}
	fmt.Println("Signed Cudia package installed.")
	return 0
}
