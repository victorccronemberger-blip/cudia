//go:build windows

package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const maxAutomaticCache = 128 * 1024

type automaticCache struct {
	Schema    int    `json:"schema"`
	Root      string `json:"root"`
	Binding   string `json:"binding"`
	CheckedAt string `json:"checkedAt"`
	Result    string `json:"result"`
	Envelope  []byte `json:"envelope"`
}

type automaticSnapshot struct {
	file     *os.File
	bytes    []byte
	metadata cleanupFile
	cache    automaticCache
}

func (s *automaticSnapshot) close() error {
	if s == nil || s.file == nil {
		return nil
	}
	f := s.file
	s.file = nil
	return f.Close()
}

func automaticRoot(root string) (string, error) {
	if err := validateMaintenanceRoot(root); err != nil {
		return "", err
	}
	return strings.ToLower(filepath.Clean(root)), nil
}

// Binding includes trust bytes, rather than compiledTrust: tests and future
// explicitly constructed updaters must never reuse another trust policy's result.
func (u *updater) automaticBinding() (connection, activation, string, error) {
	root, err := automaticRoot(u.root)
	if err != nil {
		return connection{}, activation{}, "", err
	}
	c, err := readConnection(u.root)
	if err != nil {
		return c, activation{}, "", err
	}
	s, err := readState(u.root)
	if err != nil {
		return c, s, "", err
	}
	ids := make([]string, 0, len(u.keys))
	for id := range u.keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	type trustKey struct {
		ID  string
		Key []byte
	}
	keys := make([]trustKey, 0, len(ids))
	for _, id := range ids {
		keys = append(keys, trustKey{id, u.keys[id]})
	}
	b, err := json.Marshal(struct {
		Root     string
		Policy   connection
		Selected string
		Highest  int64
		Variant  string
		Keys     []trustKey
	}{root, c, s.SelectedReleaseID, s.HighestSequence, s.Variant, keys})
	return c, s, digest(b), err
}

func parseAutomaticCache(b []byte, root string) (automaticCache, error) {
	var c automaticCache
	if len(b) > maxAutomaticCache {
		return c, errors.New("automatic check cache exceeds limit")
	}
	if err := exactObject(b, "schema", "root", "binding", "checkedAt", "result", "envelope"); err != nil {
		return c, err
	}
	var fields map[string]json.RawMessage
	if err := strictJSON(b, &fields); err != nil {
		return c, err
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return c, errors.New("null automatic check cache field")
		}
	}
	var encodedEnvelope string
	if err := strictJSON(fields["envelope"], &encodedEnvelope); err != nil {
		return c, errors.New("automatic check envelope must be a base64 JSON string")
	}
	if err := strictJSON(b, &c); err != nil {
		return c, err
	}
	canonical, err := automaticRoot(root)
	if err != nil || c.Schema != 1 || c.Root != canonical || !hashPattern.MatchString(c.Binding) || len(c.Envelope) > maxEnvelope || c.Result != "success" && c.Result != "failed" || c.Result == "success" && len(c.Envelope) == 0 || c.Result == "failed" && len(c.Envelope) != 0 {
		return c, errors.New("automatic check cache ownership or schema invalid")
	}
	at, err := time.Parse(time.RFC3339Nano, c.CheckedAt)
	if err != nil || !utcPattern.MatchString(c.CheckedAt) || at.IsZero() || at.UTC().Format(time.RFC3339Nano) != c.CheckedAt {
		return c, errors.New("automatic check cache timestamp invalid")
	}
	return c, nil
}

// The read handle excludes writers and remains open through final replacement
// validation. Windows MoveFileEx requires closing the readers before replacement.
func readAutomaticCache(root string) (*automaticSnapshot, error) {
	path := filepath.Join(root, "state", "update-check.json")
	if err := guardMaintenancePath(path); err != nil {
		return nil, err
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(h), path)
	success := false
	defer func() {
		if !success {
			f.Close()
		}
	}()
	id, info, err := cleanupIdentity(h)
	if err != nil || info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 || uint64(info.FileSizeHigh)<<32|uint64(info.FileSizeLow) > maxAutomaticCache {
		return nil, errors.New("automatic check cache is not a bounded single regular file")
	}
	b, err := readCapped(f, maxAutomaticCache)
	if err != nil {
		return nil, err
	}
	c, err := parseAutomaticCache(b, root)
	if err != nil {
		return nil, err
	}
	after, afterInfo, err := cleanupIdentity(h)
	if err != nil || after != id || afterInfo.NumberOfLinks != 1 || int64(uint64(afterInfo.FileSizeHigh)<<32|uint64(afterInfo.FileSizeLow)) != int64(len(b)) {
		return nil, errors.New("automatic check cache changed during read")
	}
	success = true
	return &automaticSnapshot{f, b, cleanupFile{fileRecord{int64(len(b)), digest(b)}, id}, c}, nil
}

// Uninstall ownership is structural and root-bound. An expired signed source is
// still our cache; an unknown/malformed/aliased file is preserved instead.
func automaticCacheMetadata(root string) (cleanupFile, bool) {
	s, err := readAutomaticCache(root)
	if err != nil || s == nil {
		return cleanupFile{}, false
	}
	defer s.close()
	return s.metadata, true
}

func writeAutomaticCache(root string, previous *automaticSnapshot, c automaticCache) error {
	b, err := json.Marshal(c)
	if err != nil || len(b) > maxAutomaticCache {
		return errors.New("automatic check cache cannot be encoded")
	}
	path := filepath.Join(root, "state", "update-check.json")
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".update-check-*.tmp")
	if err != nil {
		return err
	}
	temp := f.Name()
	id, _, identityErr := cleanupIdentity(syscall.Handle(f.Fd()))
	defer func() {
		f.Close()
		// Only this invocation's exclusive nonce file may be cleaned up.
		if identityErr == nil && guardMaintenancePath(temp) == nil {
			if current, err := wizardFileIdentity(temp); err == nil && current == id {
				_ = os.Remove(temp)
			}
		}
	}()
	if identityErr != nil {
		return identityErr
	}
	if _, err := f.Write(b); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	if previous == nil {
		// MoveFileEx without REPLACE_EXISTING makes initial adoption exclusive.
		return promote(temp, path)
	}
	current, err := readAutomaticCache(root)
	if err != nil {
		return err
	}
	if current == nil {
		return errors.New("automatic check cache disappeared")
	}
	defer current.close()
	if current.metadata != previous.metadata || !bytes.Equal(current.bytes, previous.bytes) {
		return errors.New("automatic check cache was replaced")
	}
	if err := guardMaintenancePath(path); err != nil {
		return err
	}
	// The protected automatic-check mutex serializes cooperating launchers.
	// This auxiliary file is not a compare-and-swap boundary against manual,
	// concurrent same-user edits; revalidation precedes the atomic OS replace.
	if err := current.close(); err != nil {
		return err
	}
	if err := previous.close(); err != nil {
		return err
	}
	return atomicReplace(temp, path)
}

func automaticMutexKey(root string) (string, error) {
	canonical, err := automaticRoot(root)
	if err != nil {
		return "", err
	}
	return `Software\Cudia\AutomaticChecks\` + digest([]byte(canonical)), nil
}

// The caller already holds the launcher's shared lifetime lease. It must join
// this worker before closing that lease, including when the engine exits early.
func (u *updater) startAutomaticCheck() func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		key, err := automaticMutexKey(u.root)
		if err != nil {
			return
		}
		_ = withRegistrationLock(key, func() error { return u.automaticCheck(ctx) })
	}()
	return func() { cancel(); <-done }
}

func (u *updater) automaticCheck(ctx context.Context) error {
	if ctx.Err() != nil || len(u.keys) == 0 {
		return nil
	}
	c, s, binding, err := u.automaticBinding()
	if err != nil || !c.AutomaticCheck {
		return err
	}
	previous, err := readAutomaticCache(u.root)
	if err != nil {
		return err // Preserve and suspend on any uncertain existing local file.
	}
	if previous != nil {
		defer previous.close()
		at, _ := time.Parse(time.RFC3339Nano, previous.cache.CheckedAt)
		interval := time.Duration(c.CheckIntervalHours) * time.Hour
		if previous.cache.Result == "failed" {
			interval = 24 * time.Hour
		}
		// A clock rollback must not postpone checks forever. A future timestamp
		// is stale, regardless of how far in the future it is.
		if previous.cache.Binding == binding && !at.After(u.now()) && u.now().Sub(at) < interval {
			return nil
		}
	}
	p, source, fetchErr := u.fetchEnvelope(ctx, c)
	if ctx.Err() != nil {
		return nil // Engine exit is not a failed check or a backoff event.
	}
	if fetchErr == nil {
		var a artifact
		a, fetchErr = archiveFor(p, s.Variant)
		if fetchErr == nil {
			fetchErr = validateSequence(s, p, a)
		}
	}
	_, _, current, err := u.automaticBinding()
	if err != nil || current != binding {
		return err // Discard a result fetched for an obsolete activation/policy.
	}
	root, err := automaticRoot(u.root)
	if err != nil || ctx.Err() != nil {
		return err
	}
	cache := automaticCache{1, root, binding, u.now().UTC().Format(time.RFC3339Nano), "success", source}
	if fetchErr != nil {
		cache.Result, cache.Envelope = "failed", []byte{}
	}
	return writeAutomaticCache(u.root, previous, cache)
}

// Notices are entirely local and emitted before starting the engine. Every
// consumer rechecks policy, activation, trust, signature, expiry and sequence.
func (u *updater) automaticNotice() string {
	if len(u.keys) == 0 {
		return ""
	}
	c, s, binding, err := u.automaticBinding()
	if err != nil || !c.AutomaticCheck {
		return ""
	}
	cache, err := readAutomaticCache(u.root)
	if err != nil || cache == nil {
		return ""
	}
	defer cache.close()
	if cache.cache.Binding != binding || cache.cache.Result != "success" {
		return ""
	}
	at, _ := time.Parse(time.RFC3339Nano, cache.cache.CheckedAt)
	if at.After(u.now()) {
		return ""
	}
	p, err := verifyEnvelope(cache.cache.Envelope, u.keys, c.Channel, u.now())
	if err != nil {
		return ""
	}
	a, err := archiveFor(p, s.Variant)
	if err != nil || validateSequence(s, p, a) != nil || releaseID(p.Sequence, a.SHA256) == s.SelectedReleaseID {
		return ""
	}
	_, _, current, err := u.automaticBinding()
	if err != nil || current != binding {
		return ""
	}
	return "Cudia update available. Run cudia update to install."
}

func automaticConsoleInputOutput() bool {
	getMode := kernel32.NewProc("GetConsoleMode")
	for _, f := range []*os.File{os.Stdin, os.Stdout} {
		var mode uint32
		ok, _, _ := getMode.Call(f.Fd(), uintptr(unsafe.Pointer(&mode)))
		if ok == 0 {
			return false
		}
	}
	return true
}

// This conservative recognizer follows TuiThreadCommand and its global/network
// options. Unknown verbs/flags cannot trigger network traffic or notices.
func automaticInteractiveArgs(args []string) bool {
	boolean := map[string]bool{"continue": true, "c": true, "fork": true, "auto": true, "yolo": true, "dangerously-skip-permissions": true, "mini": true, "replay": true, "no-replay": true, "demo": true, "mdns": true, "print-logs": true, "pure": true}
	value := map[string]bool{"model": true, "m": true, "session": true, "s": true, "prompt": true, "agent": true, "replay-limit": true, "port": true, "hostname": true, "mdns-domain": true, "cors": true, "log-level": true}
	verbs := " acp mcp attach run generate debug auth providers agent upgrade uninstall serve web models stats export import github pr session plugin plug console db completion update rollback installation installer install-bundled trust-info "
	seen := map[string]bool{}
	present := map[string]bool{}
	project := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			if i != len(args)-1 {
				return false
			}
			break
		}
		if !strings.HasPrefix(arg, "-") {
			if project || strings.Contains(verbs, " "+arg+" ") {
				return false
			}
			info, err := os.Stat(arg)
			if err != nil || !info.IsDir() {
				return false
			}
			project = true
			continue
		}
		name, val, equals := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(arg, "-"), "-"), "=")
		if !strings.HasPrefix(arg, "--") && name != "m" && name != "c" && name != "s" {
			return false
		}
		present[name] = true
		if boolean[name] || strings.HasPrefix(name, "no-") && name != "no-no-replay" && boolean[strings.TrimPrefix(name, "no-")] {
			if equals && val != "true" && val != "false" {
				return false
			}
			enabled := !strings.HasPrefix(name, "no-")
			if equals && val == "false" {
				enabled = !enabled
			}
			canonical := strings.TrimPrefix(name, "no-")
			seen[canonical] = enabled
			if canonical == "replay" {
				seen["no-replay"] = !enabled
			}
			continue
		}
		if !value[name] {
			return false
		}
		if !equals {
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "-") {
				return false
			}
			val = args[i]
		}
		if val == "" {
			return false
		}
		if name == "port" || name == "replay-limit" {
			if _, err := strconv.ParseUint(val, 10, 32); err != nil {
				return false
			}
		}
		if name == "log-level" && val != "DEBUG" && val != "INFO" && val != "WARN" && val != "ERROR" {
			return false
		}
		seen[name] = true
	}
	if seen["replay"] || seen["fork"] && !seen["continue"] && !seen["c"] && !seen["session"] && !seen["s"] {
		return false
	}
	if seen["mini"] {
		return !present["port"] && !present["hostname"] && !present["mdns"] && !present["no-mdns"] && !present["mdns-domain"] && !present["cors"]
	}
	return !seen["no-replay"] && !seen["replay-limit"] && !seen["demo"]
}
