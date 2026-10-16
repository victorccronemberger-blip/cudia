package client

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

func testKeys(t *testing.T) (map[string]ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]ed25519.PublicKey{"test-key": pub}, priv
}
func signBytes(t *testing.T, b []byte, priv ed25519.PrivateKey) []byte {
	t.Helper()
	e := envelope{1, "test-key", base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(ed25519.Sign(priv, b))}
	out, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func signPayload(t *testing.T, p payload, priv ed25519.PrivateKey) []byte {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return signBytes(t, b, priv)
}
func testPayload() payload {
	return payload{1, "cudia", "stable", 1, "1.2.3", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), []artifact{{"archive", "windows", "x64", "normal", "https://example.invalid/archive.zip", 1, strings.Repeat("a", 64)}}}
}

func TestManifestContract(t *testing.T) {
	keys, priv := testKeys(t)
	p := testPayload()
	if _, err := verifyEnvelope(signPayload(t, p, priv), keys, "stable", time.Now()); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		change func(*payload)
	}{
		{"negative sequence", func(p *payload) { p.Sequence = -1 }},
		{"zero sequence", func(p *payload) { p.Sequence = 0 }},
		{"unsafe sequence", func(p *payload) { p.Sequence = maxSequence + 1 }},
		{"version leading zero", func(p *payload) { p.Version = "01.2.3" }},
		{"numeric prerelease leading zero", func(p *payload) { p.Version = "1.2.3-01" }},
		{"channel", func(p *payload) { p.Channel = "preview" }},
		{"expired", func(p *payload) { p.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339) }},
		{"future", func(p *payload) { p.IssuedAt = time.Now().Add(time.Minute).UTC().Format(time.RFC3339) }},
		{"invalid calendar", func(p *payload) { p.IssuedAt = "2026-02-30T00:00:00Z" }},
		{"non UTC", func(p *payload) { p.IssuedAt = "2026-01-01T00:00:00+00:00" }},
		{"year zero", func(p *payload) { p.IssuedAt = "0000-01-01T00:00:00Z" }},
		{"http", func(p *payload) { p.Artifacts[0].URL = "http://example.com/a" }},
		{"URL credentials", func(p *payload) { p.Artifacts[0].URL = "https://user:pass@example.com/a" }},
		{"URL fragment", func(p *payload) { p.Artifacts[0].URL += "#" }},
		{"wrong platform", func(p *payload) { p.Artifacts[0].Platform = "linux" }},
		{"wrong arch", func(p *payload) { p.Artifacts[0].Arch = "arm64" }},
		{"wrong variant", func(p *payload) { p.Artifacts[0].Variant = "other" }},
		{"uppercase digest", func(p *payload) { p.Artifacts[0].SHA256 = strings.Repeat("A", 64) }},
		{"oversized asset", func(p *payload) { p.Artifacts[0].Size = 2*1024*1024*1024 + 1 }},
		{"duplicate artifact", func(p *payload) { p.Artifacts = append(p.Artifacts, p.Artifacts[0]) }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			p := testPayload()
			tt.change(&p)
			if _, err := verifyEnvelope(signPayload(t, p, priv), keys, "stable", time.Now()); err == nil {
				t.Fatal("accepted invalid manifest")
			}
		})
	}
	p = testPayload()
	p.Sequence = maxSequence
	if _, err := verifyEnvelope(signPayload(t, p, priv), keys, "stable", time.Now()); err != nil {
		t.Fatal("max safe integer rejected:", err)
	}
	p = testPayload()
	p.Version = "1.0.0-alpha.0+build.12"
	if _, err := verifyEnvelope(signPayload(t, p, priv), keys, "stable", time.Now()); err != nil {
		t.Fatal(err)
	}
}
func TestEnvelopeStrictParsing(t *testing.T) {
	keys, priv := testKeys(t)
	good := signPayload(t, testPayload(), priv)
	var e envelope
	_ = json.Unmarshal(good, &e)
	bad := []byte(strings.Replace(string(good), `"schema":1`, `"schema":1,"\u0073chema":1`, 1))
	for name, b := range map[string][]byte{
		"duplicate escaped alias": bad,
		"unknown":                 []byte(strings.Replace(string(good), `"schema":1`, `"schema":1,"extra":0`, 1)),
		"case alias":              []byte(strings.Replace(string(good), `"schema":1`, `"Schema":1`, 1)),
		"invalid UTF8":            append(append([]byte{}, good...), 255),
		"oversized":               []byte(strings.Repeat(" ", maxEnvelope+1)),
		"trailing":                append(append([]byte{}, good...), []byte("{}")...),
		"noncanonical base64":     []byte(strings.Replace(string(good), e.Payload, e.Payload+"\n", 1)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := verifyEnvelope(b, keys, "stable", time.Now()); err == nil {
				t.Fatal("accepted invalid envelope")
			}
		})
	}
	e.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64))
	b, _ := json.Marshal(e)
	if _, err := verifyEnvelope(b, keys, "stable", time.Now()); err == nil {
		t.Fatal("accepted invalid signature")
	}
	if _, err := verifyEnvelope(good, map[string]ed25519.PublicKey{}, "stable", time.Now()); err == nil {
		t.Fatal("accepted untrusted signature")
	}
	pb, _ := json.Marshal(testPayload())
	pb = []byte(strings.Replace(string(pb), `"sequence":1`, `"sequence":1,"\u0073equence":2`, 1))
	if _, err := verifyEnvelope(signBytes(t, pb, priv), keys, "stable", time.Now()); err == nil {
		t.Fatal("accepted duplicated payload field")
	}
	var v any
	if err := strictJSON([]byte(strings.Repeat("[", 66)+"0"+strings.Repeat("]", 66)), &v); err == nil {
		t.Fatal("accepted excessive depth")
	}
}
func TestJavaScriptIntegerNumberSemantics(t *testing.T) {
	keys, priv := testKeys(t)
	p := testPayload()
	p.Sequence = maxSequence
	b, _ := json.Marshal(p)
	if _, err := verifyEnvelope(signBytes(t, append([]byte{0xef, 0xbb, 0xbf}, b...), priv), keys, "stable", time.Now()); err != nil {
		t.Fatal("signed UTF-8 BOM payload rejected", err)
	}
	for _, lexeme := range []string{"9007199254740991", "9007199254740991.0", "9.007199254740991e15", "9007199254740991.1"} {
		data := []byte(strings.Replace(string(b), `"sequence":9007199254740991`, `"sequence":`+lexeme, 1))
		got, err := verifyEnvelope(signBytes(t, data, priv), keys, "stable", time.Now())
		if err != nil || got.Sequence != maxSequence {
			t.Fatalf("JS safe integer %s rejected: %v", lexeme, err)
		}
	}
	b, _ = json.Marshal(testPayload())
	for _, lexeme := range []string{"1.0", "1e0", "0.1e1", "1.00000000000000001"} {
		data := []byte(strings.ReplaceAll(string(b), `":1,`, `":`+lexeme+`,`))
		if _, err := verifyEnvelope(signBytes(t, data, priv), keys, "stable", time.Now()); err != nil {
			t.Fatalf("JS integer %s rejected: %v", lexeme, err)
		}
	}
	for _, lexeme := range []string{"1.5", "1e99", "9007199254740992.0"} {
		data := []byte(strings.Replace(string(b), `"sequence":1`, `"sequence":`+lexeme, 1))
		if _, err := verifyEnvelope(signBytes(t, data, priv), keys, "stable", time.Now()); err == nil {
			t.Fatal("unsafe/fractional integer accepted", lexeme)
		}
	}
	_, d := smallPackage(t, testPayload())
	db, _ := json.Marshal(d)
	db = []byte(strings.ReplaceAll(string(db), `":1,`, `":1e0,`))
	if _, err := parseDescriptor(db); err != nil {
		t.Fatal("descriptor exponent integer rejected", err)
	}
}
func TestCompiledTrust(t *testing.T) {
	keys, priv := testKeys(t)
	der, err := x509.MarshalPKIXPublicKey(priv.Public())
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"test-key": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))})
	loaded, err := loadTrust(data)
	if err != nil || !loaded["test-key"].Equal(keys["test-key"]) {
		t.Fatal("trust parse failed", err)
	}
	for _, raw := range []string{`null`, `{"constructor":"bad"}`, `{"a":"bad"}`, `{"a":"x","\u0061":"y"}`} {
		if _, err := loadTrust([]byte(raw)); err == nil {
			t.Fatal("invalid trust accepted", raw)
		}
	}
	if keys, err := loadTrust(compiledTrust); err != nil || len(keys) != 0 {
		t.Fatal("development build must ship empty trust")
	}
}
