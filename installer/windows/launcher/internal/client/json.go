package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"unicode/utf8"
)

// Check tokens before typed decoding: encoding/json alone accepts duplicate keys,
// invalid UTF-8 and case-insensitive field aliases.
func strictJSON(data []byte, target any) error {
	if !utf8.Valid(data) {
		return errors.New("invalid JSON UTF-8")
	}
	// TextDecoder("utf-8") in the release service consumes an optional BOM.
	data = jsonSource(data)
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := jsonValue(d, 0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	d = json.NewDecoder(bytes.NewReader(integerNumberLexemes(data)))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errors.New("invalid JSON fields")
	}
	return nil
}
func jsonSource(data []byte) []byte { return bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}) }

// The release service uses JSON.parse and Number.isSafeInteger, so 1e0 and
// 1.0 mean the integer 1. Go's int decoder otherwise rejects those valid wire
// representations. Normalize only finite safe integer Number values, after
// the original JSON has passed token/depth/duplicate checks. Signed payload
// bytes are always verified before typed payload decoding calls this helper.
func integerNumberLexemes(data []byte) []byte {
	var out bytes.Buffer
	for i := 0; i < len(data); {
		if data[i] == '"' {
			start := i
			i++
			for i < len(data) {
				c := data[i]
				i++
				if c == '\\' {
					i++
					continue
				}
				if c == '"' {
					break
				}
			}
			out.Write(data[start:i])
			continue
		}
		if data[i] == '-' || data[i] >= '0' && data[i] <= '9' {
			start := i
			i++
			for i < len(data) && stringsNumberCharacter(data[i]) {
				i++
			}
			token := string(data[start:i])
			n, err := strconv.ParseFloat(token, 64)
			if err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && math.Abs(n) <= float64(maxSequence) {
				out.WriteString(strconv.FormatFloat(n, 'f', 0, 64))
			} else {
				out.Write(data[start:i])
			}
			continue
		}
		out.WriteByte(data[i])
		i++
	}
	return out.Bytes()
}
func stringsNumberCharacter(c byte) bool {
	return c >= '0' && c <= '9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-'
}

func jsonValue(d *json.Decoder, depth int) error {
	if depth > 64 {
		return errors.New("JSON too deep")
	}
	t, err := d.Token()
	if err != nil {
		return errors.New("invalid JSON")
	}
	switch t {
	case json.Delim('{'):
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			s, ok := key.(string)
			if !ok || seen[s] {
				return errors.New("duplicate JSON key")
			}
			seen[s] = true
			if err := jsonValue(d, depth+1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("invalid JSON")
		}
	case json.Delim('['):
		for d.More() {
			if err := jsonValue(d, depth+1); err != nil {
				return err
			}
		}
		end, err := d.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("invalid JSON")
		}
	case json.Delim('}'), json.Delim(']'):
		return errors.New("invalid JSON")
	}
	return nil
}

// Exact field spelling is deliberate; Go's typed decoder folds field case.
func exactObject(data []byte, fields ...string) error {
	var obj map[string]json.RawMessage
	if err := strictJSON(data, &obj); err != nil {
		return err
	}
	if obj == nil || len(obj) != len(fields) {
		return errors.New("invalid JSON object")
	}
	for _, f := range fields {
		if _, ok := obj[f]; !ok {
			return errors.New("invalid JSON object fields")
		}
	}
	return nil
}

func readCapped(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("response exceeds size limit")
	}
	return b, nil
}
