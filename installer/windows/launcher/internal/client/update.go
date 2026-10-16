package client

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type connection struct {
	Schema             int    `json:"schema"`
	Product            string `json:"product"`
	Channel            string `json:"channel"`
	ManifestURL        string `json:"manifestUrl"`
	CheckIntervalHours int    `json:"checkIntervalHours"`
	AutomaticCheck     bool   `json:"automaticCheck"`
}

func readConnection(root string) (connection, error) {
	c := connection{1, "cudia", "stable", "https://cyara.com.br/updates/v1/stable.json", 24, false}
	path := filepath.Join(root, "connection.json")
	if err := guardPath(path); err != nil {
		return c, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, errors.New("connection configuration unavailable")
	}
	defer f.Close()
	b, err := readCapped(f, 16*1024)
	if err != nil {
		return c, err
	}
	if err := exactObject(b, "schema", "product", "channel", "manifestUrl", "checkIntervalHours", "automaticCheck"); err != nil {
		return c, err
	}
	if err := strictJSON(b, &c); err != nil {
		return c, err
	}
	var fields map[string]json.RawMessage
	_ = strictJSON(b, &fields)
	if string(fields["automaticCheck"]) != "true" && string(fields["automaticCheck"]) != "false" {
		return c, errors.New("automaticCheck must be a JSON boolean")
	}
	if c.Schema != 1 || c.Product != "cudia" || !validChannel(c.Channel) || !safeURL(c.ManifestURL) || c.CheckIntervalHours < 1 || c.CheckIntervalHours > 24*30 {
		return c, errors.New("connection configuration invalid")
	}
	return c, nil
}

type updater struct {
	root string
	keys map[string]ed25519.PublicKey
	http *http.Client
	now  func() time.Time
}

func newUpdater(root string) (*updater, error) {
	keys, err := loadTrust(compiledTrust)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	return &updater{root, keys, &http.Client{Transport: transport, Timeout: 5 * time.Minute, CheckRedirect: redirectPolicy}, time.Now}, nil
}
func redirectPolicy(req *http.Request, via []*http.Request) error {
	if len(via) > 3 || !safeURL(req.URL.String()) {
		return errors.New("update redirect rejected")
	}
	req.URL.Scheme = strings.ToLower(req.URL.Scheme)
	return nil
}
func (u *updater) get(ctx context.Context, url string) (*http.Response, error) {
	if !safeURL(url) {
		return nil, errors.New("update URL invalid")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, errors.New("update request failed")
	}
	req.Header.Set("Accept-Encoding", "identity")
	req.URL.Scheme = strings.ToLower(req.URL.Scheme)
	req.Header.Set("User-Agent", "Cudia-Windows-Launcher/1")
	res, err := u.http.Do(req)
	if err != nil {
		return nil, errors.New("update connection failed or cancelled")
	}
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Encoding") != "" && res.Header.Get("Content-Encoding") != "identity" {
		res.Body.Close()
		return nil, errors.New("update server response rejected")
	}
	return res, nil
}
func (u *updater) fetch(ctx context.Context, c connection) (payload, error) {
	p, _, err := u.fetchEnvelope(ctx, c)
	return p, err
}

// Keep the signed source for automatic notices; cached display metadata is
// never trusted as a substitute for a fresh signature and policy check.
func (u *updater) fetchEnvelope(ctx context.Context, c connection) (payload, []byte, error) {
	if len(u.keys) == 0 {
		return payload{}, nil, errors.New("updates disabled: this build has no compiled release trust keys")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := u.get(ctx, c.ManifestURL)
	if err != nil {
		return payload{}, nil, err
	}
	defer res.Body.Close()
	b, err := readCapped(res.Body, maxEnvelope)
	if err != nil {
		return payload{}, nil, errors.New("release manifest read failed or exceeded limit")
	}
	p, err := verifyEnvelope(b, u.keys, c.Channel, u.now())
	return p, b, err
}
func (u *updater) download(ctx context.Context, a artifact, path string) error {
	res, err := u.get(ctx, a.URL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, a.Size+1))
	syncErr := f.Sync()
	closeErr := f.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || n != a.Size || hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		return errors.New("archive download cancelled, truncated, oversized or hash mismatch")
	}
	return nil
}
func (u *updater) check(ctx context.Context) (payload, artifact, bool, error) {
	s, err := readState(u.root)
	if err != nil {
		return payload{}, artifact{}, false, err
	}
	c, err := readConnection(u.root)
	if err != nil {
		return payload{}, artifact{}, false, err
	}
	p, err := u.fetch(ctx, c)
	if err != nil {
		return p, artifact{}, false, err
	}
	a, err := archiveFor(p, s.Variant)
	if err != nil {
		return p, a, false, err
	}
	if err := validateSequence(s, p, a); err != nil {
		return p, a, false, err
	}
	return p, a, releaseID(p.Sequence, a.SHA256) != s.SelectedReleaseID, nil
}
func (u *updater) apply(ctx context.Context) (string, error) {
	if err := ensureLayout(u.root); err != nil {
		return "", err
	}
	lifetime, err := acquireLifetime(u.root, false)
	if err != nil {
		return "", err
	}
	defer lifetime.close()
	l, err := acquireLock(u.root)
	if err != nil {
		return "", err
	}
	defer l.close()
	if err := checkPendingMaintenance(u.root, false); err != nil {
		return "", err
	}
	p, a, available, err := u.check(ctx)
	if err != nil {
		return "", err
	}
	if !available {
		return "already current", nil
	}
	s, err := readState(u.root)
	if err != nil {
		return "", err
	}
	work, err := os.MkdirTemp(filepath.Join(u.root, "state", "staging"), "update-")
	if err != nil {
		return "", err
	}
	defer safeRemove(filepath.Join(u.root, "state", "staging"), work)
	archive := filepath.Join(work, "archive.zip")
	if err := u.download(ctx, a, archive); err != nil {
		return "", err
	}
	files := filepath.Join(work, "files")
	if err := os.Mkdir(files, 0700); err != nil {
		return "", err
	}
	d, err := extractPackage(archive, files, p, a)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", errors.New("update cancelled")
	}
	id := releaseID(p.Sequence, a.SHA256)
	dest := filepath.Join(u.root, "versions", id)
	if err := guardPath(dest); err != nil {
		return "", err
	}
	if _, err := os.Stat(dest); err == nil {
		if err := verifyTree(dest, d); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	} else if err := promote(files, dest); err != nil {
		return "", err
	}
	// Promotion precedes the single activation commit. A crash here leaves only
	// an unreferenced verified directory, which a retry validates and reuses.
	if err := ctx.Err(); err != nil {
		return "", errors.New("update cancelled")
	}
	s.Installed[id] = recordFor(p, a, d)
	s.SelectedReleaseID = id
	s.HighestSequence = p.Sequence
	if err := writeState(u.root, s); err != nil {
		return "", err
	}
	return p.Version, nil
}
func (u *updater) rollback(id string) error {
	lifetime, err := acquireLifetime(u.root, false)
	if err != nil {
		return err
	}
	defer lifetime.close()
	l, err := acquireLock(u.root)
	if err != nil {
		return err
	}
	defer l.close()
	if err := checkPendingMaintenance(u.root, false); err != nil {
		return err
	}
	s, err := readState(u.root)
	if err != nil {
		return err
	}
	r, ok := s.Installed[id]
	if !ok {
		return errors.New("rollback target has not been verified by this installation")
	}
	if err := verifyTree(filepath.Join(u.root, "versions", id), r.Descriptor); err != nil {
		return err
	}
	s.SelectedReleaseID = id // highestSequence deliberately never decreases.
	return writeState(u.root, s)
}

// initialize is the shared implementation for install-bundled and tests.
// No CLI accepts unsigned archives or replacement trust configuration.
func (u *updater) initialize(ctx context.Context, variant string, envelopeBytes []byte, archive string) error {
	if !validVariant(variant) {
		return errors.New("invalid installation variant")
	}
	c, err := readConnection(u.root)
	if err != nil {
		return err
	}
	p, err := verifyEnvelope(envelopeBytes, u.keys, c.Channel, u.now())
	if err != nil {
		return err
	}
	a, err := archiveFor(p, variant)
	if err != nil {
		return err
	}
	if err := ensureLayout(u.root); err != nil {
		return err
	}
	lifetime, err := acquireLifetime(u.root, false)
	if err != nil {
		return err
	}
	defer lifetime.close()
	l, err := acquireLock(u.root)
	if err != nil {
		return err
	}
	defer l.close()
	var existing *activation
	if err := checkPendingMaintenance(u.root, false); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(u.root, "state", "activation.json")); err == nil {
		s, err := readState(u.root)
		if err != nil {
			return err
		}
		if s.Variant != variant {
			return errors.New("bundled package variant differs from installation")
		}
		if err := validateSequence(s, p, a); err != nil {
			return err
		}
		existing = &s
	} else if !os.IsNotExist(err) {
		return err
	}
	// Copy the installer-supplied archive into exclusive staging while checking
	// its signed size/hash. Extraction reads this private copy, not a reopened
	// caller-controlled path that could have changed after verification.
	work, err := os.MkdirTemp(filepath.Join(u.root, "state", "staging"), "initialize-")
	if err != nil {
		return err
	}
	defer safeRemove(filepath.Join(u.root, "state", "staging"), work)
	stagedArchive := filepath.Join(work, "archive.zip")
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	out, err := os.OpenFile(stagedArchive, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		f.Close()
		return err
	}
	h := sha256.New()
	n, readErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(f, a.Size+1))
	f.Close()
	syncErr := out.Sync()
	closeErr := out.Close()
	if readErr != nil || syncErr != nil || closeErr != nil || n != a.Size || hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		return errors.New("initial archive verification failed")
	}
	files := filepath.Join(work, "files")
	if err := os.Mkdir(files, 0700); err != nil {
		return err
	}
	d, err := extractPackage(stagedArchive, files, p, a)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	dest := filepath.Join(u.root, "versions", releaseID(p.Sequence, a.SHA256))
	if err := guardPath(dest); err != nil {
		return err
	}
	if _, err := os.Stat(dest); err == nil {
		if err := verifyTree(dest, d); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	} else if err := promote(files, dest); err != nil {
		return err
	}
	if existing != nil {
		id := releaseID(p.Sequence, a.SHA256)
		existing.Installed[id] = recordFor(p, a, d)
		existing.SelectedReleaseID = id
		if p.Sequence > existing.HighestSequence {
			existing.HighestSequence = p.Sequence
		}
		return writeState(u.root, *existing)
	}
	return writeState(u.root, initialState(variant, p, a, d))
}
