// This executable is a test helper, never a distributed Cudia engine.
package main

import (
	"encoding/json"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	if len(os.Args) > 2 && os.Args[1] == "--prompt" && strings.HasPrefix(os.Args[2], "test-hold:") {
		var paths struct{ Ready, Stop string }
		if json.Unmarshal([]byte(strings.TrimPrefix(os.Args[2], "test-hold:")), &paths) != nil {
			os.Exit(26)
		}
		if os.WriteFile(paths.Ready, []byte("ready"), 0600) != nil {
			os.Exit(27)
		}
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(paths.Stop); err == nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(28)
	}
	if len(os.Args) > 2 && os.Args[1] == "--test-interrupt" {
		interrupt := make(chan os.Signal, 1)
		signal.Notify(interrupt, os.Interrupt)
		defer signal.Stop(interrupt)
		if err := os.WriteFile(os.Args[2], []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			os.Exit(25)
		}
		select {
		case <-interrupt:
			_ = json.NewEncoder(os.Stdout).Encode(struct {
				Interrupt bool `json:"interrupt"`
				Exit      int  `json:"exit"`
			}{true, 23})
			os.Exit(23)
		case <-time.After(12 * time.Second):
			os.Exit(24)
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "--test-hold" {
		_ = os.WriteFile(os.Args[2], []byte("ready"), 0600)
		for {
			if _, err := os.Stat(os.Args[3]); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	cwd, _ := os.Getwd()
	defaults := os.Getenv("CUDIA_DISTRIBUTION_DIR")
	marker, _ := os.ReadFile(filepath.Join(defaults, "release.txt"))
	env := map[string]string{}
	for _, k := range []string{"OPENCODE_DISABLE_CHANNEL_DB", "OPENCODE_EXPERIMENTAL_CODE_MODE", "CUDIA_CONTEXT_MODE", "OPENCODE_ENABLE_EXA", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_CONFIG_DIR"} {
		env[k] = os.Getenv(k)
	}
	_ = json.NewEncoder(os.Stdout).Encode(struct {
		Args     []string          `json:"args"`
		Cwd      string            `json:"cwd"`
		Defaults string            `json:"defaults"`
		Release  string            `json:"release"`
		Env      map[string]string `json:"env"`
	}{os.Args[1:], cwd, defaults, string(marker), env})
	if len(os.Args) > 2 && os.Args[1] == "--test-exit" {
		code, _ := strconv.Atoi(os.Args[2])
		os.Exit(code)
	}
}
