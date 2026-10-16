package client

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxEnvelope = 64 * 1024
const maxSequence = int64(9007199254740991)
const bootstrapABI = 1

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var semverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)
var utcPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$`)

//go:embed trust.json
var compiledTrust []byte

type envelope struct {
	Schema    int    `json:"schema"`
	KeyID     string `json:"keyId"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type payload struct {
	Schema    int        `json:"schema"`
	Product   string     `json:"product"`
	Channel   string     `json:"channel"`
	Sequence  int64      `json:"sequence"`
	Version   string     `json:"version"`
	IssuedAt  string     `json:"issuedAt"`
	ExpiresAt string     `json:"expiresAt"`
	Artifacts []artifact `json:"artifacts"`
}
type artifact struct {
	Kind     string `json:"kind"`
	Platform string `json:"platform"`
	Arch     string `json:"arch"`
	Variant  string `json:"variant"`
	URL      string `json:"url"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

func loadTrust(data []byte) (map[string]ed25519.PublicKey, error) {
	if len(data) > 16*1024 {
		return nil, errors.New("compiled trust invalid")
	}
	var raw map[string]string
	if err := strictJSON(data, &raw); err != nil || raw == nil || len(raw) > 8 {
		return nil, errors.New("compiled trust invalid")
	}
	keys := map[string]ed25519.PublicKey{}
	for id, value := range raw {
		if !validKeyID(id) {
			return nil, errors.New("compiled trust invalid")
		}
		block, rest := pem.Decode([]byte(value))
		if block == nil || block.Type != "PUBLIC KEY" || len(strings.TrimSpace(string(rest))) != 0 {
			return nil, errors.New("compiled trust invalid")
		}
		key, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, errors.New("compiled trust invalid")
		}
		pub, ok := key.(ed25519.PublicKey)
		if !ok {
			return nil, errors.New("compiled trust invalid")
		}
		keys[id] = pub
	}
	return keys, nil
}
func validKeyID(id string) bool {
	return keyPattern.MatchString(id) && id != "constructor" && id != "prototype" && id != "__proto__"
}
func safeURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && strings.EqualFold(u.Scheme, "https") && u.Hostname() != "" && u.User == nil && u.Fragment == "" && !strings.Contains(s, "#") && u.Opaque == ""
}
func canonical64(s string) ([]byte, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || len(b) == 0 || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errors.New("invalid base64")
	}
	return b, nil
}
func verifyEnvelope(data []byte, keys map[string]ed25519.PublicKey, channel string, now time.Time) (payload, error) {
	var p payload
	if len(data) == 0 || len(data) > maxEnvelope {
		return p, errors.New("invalid release envelope")
	}
	if err := exactObject(data, "schema", "keyId", "payload", "signature"); err != nil {
		return p, err
	}
	var e envelope
	if err := strictJSON(data, &e); err != nil {
		return p, err
	}
	if e.Schema != 1 || !validKeyID(e.KeyID) {
		return p, errors.New("invalid release envelope")
	}
	b, err := canonical64(e.Payload)
	if err != nil || len(b) > maxEnvelope {
		return p, errors.New("invalid release payload")
	}
	sig, err := canonical64(e.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return p, errors.New("invalid release signature")
	}
	key, ok := keys[e.KeyID]
	if !ok {
		return p, errors.New("release key is not trusted")
	}
	if !ed25519.Verify(key, b, sig) {
		return p, errors.New("release signature invalid")
	}
	if err := exactObject(b, "schema", "product", "channel", "sequence", "version", "issuedAt", "expiresAt", "artifacts"); err != nil {
		return p, err
	}
	if err := strictJSON(b, &p); err != nil {
		return p, err
	}
	if p.Schema != 1 || p.Product != "cudia" || !validChannel(p.Channel) || p.Channel != channel || p.Sequence < 1 || p.Sequence > maxSequence || len(p.Version) > 128 || !semverPattern.MatchString(p.Version) {
		return p, errors.New("release identity invalid")
	}
	issued, err := utc(p.IssuedAt)
	if err != nil {
		return p, err
	}
	expires, err := utc(p.ExpiresAt)
	if err != nil {
		return p, err
	}
	now = now.Truncate(time.Millisecond)
	if !expires.After(issued) || now.Before(issued) || !now.Before(expires) {
		return p, errors.New("release is expired or not yet valid")
	}
	if len(p.Artifacts) < 1 || len(p.Artifacts) > 8 {
		return p, errors.New("invalid release artifacts")
	}
	var raw struct {
		Artifacts []json.RawMessage `json:"artifacts"`
	}
	_ = json.Unmarshal(jsonSource(b), &raw)
	seen := map[string]bool{}
	for i, a := range p.Artifacts {
		if err := exactObject(raw.Artifacts[i], "kind", "platform", "arch", "variant", "url", "size", "sha256"); err != nil {
			return p, err
		}
		id := a.Kind + "/" + a.Platform + "/" + a.Arch + "/" + a.Variant
		if (a.Kind != "archive" && a.Kind != "installer") || a.Platform != "windows" || a.Arch != "x64" || !validVariant(a.Variant) || !safeURL(a.URL) || a.Size < 1 || a.Size > 2*1024*1024*1024 || !hashPattern.MatchString(a.SHA256) || seen[id] {
			return p, errors.New("invalid release artifact")
		}
		seen[id] = true
	}
	return p, nil
}
func utc(s string) (time.Time, error) {
	if !utcPattern.MatchString(s) || strings.HasPrefix(s, "0000-") {
		return time.Time{}, errors.New("invalid release timestamp")
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, errors.New("invalid release timestamp")
	}
	return t.Truncate(time.Millisecond), nil
}
func validChannel(s string) bool { return s == "stable" || s == "preview" }
func validVariant(s string) bool { return s == "normal" || s == "baseline" }
func archiveFor(p payload, variant string) (artifact, error) {
	for _, a := range p.Artifacts {
		if a.Kind == "archive" && a.Variant == variant {
			return a, nil
		}
	}
	return artifact{}, errors.New("release has no archive for this installation")
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
