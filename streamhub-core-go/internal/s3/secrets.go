package s3

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Port of secrets.store.ts — credentials persisted in
// ${DATA_DIR}/data/secrets.json (chmod 600), never in config.yaml. Refs
// resolve against the file first, then the environment. Values are never
// logged.

// SecretsStore is the cached secrets.json store.
type SecretsStore struct {
	dataDir string
	env     func(string) string

	mu    sync.Mutex
	cache *secretsMap // nil = re-read on next access
}

// NewSecretsStore builds a store over dataDir; env nil = os.Getenv.
func NewSecretsStore(dataDir string, env func(string) string) *SecretsStore {
	if env == nil {
		env = os.Getenv
	}
	return &SecretsStore{dataDir: dataDir, env: env}
}

// Path is the absolute secrets.json path.
func (s *SecretsStore) Path() string {
	return filepath.Join(s.dataDir, "data", "secrets.json")
}

// load returns the cached map (reading it once). Caller holds mu.
func (s *SecretsStore) load() *secretsMap {
	if s.cache == nil {
		s.cache = readSecretsFile(s.Path())
	}
	return s.cache
}

// Invalidate forces a re-read on next access.
func (s *SecretsStore) Invalidate() {
	s.mu.Lock()
	s.cache = nil
	s.mu.Unlock()
}

// Get resolves a ref: store first, then env; ok=false when neither has a
// non-empty value. A JSON null in the store is returned as missing without
// the env fallback (Node returns that null as-is).
func (s *SecretsStore) Get(ref string) (string, bool) {
	if ref == "" {
		return "", false
	}
	s.mu.Lock()
	m := s.load()
	v, present := m.get(ref)
	s.mu.Unlock()
	if present {
		if v.null {
			return "", false
		}
		if v.text() != "" || !v.isStr {
			return v.text(), true
		}
	}
	if e := s.env(ref); e != "" {
		return e, true
	}
	return "", false
}

// Set persists one secret.
func (s *SecretsStore) Set(ref, value string) error {
	return s.SetMany([][2]string{{ref, value}})
}

// SetMany persists several secrets atomically (tmp + rename, file 0600, dir
// 0700). Pairs are applied in order; empty keys are skipped.
func (s *SecretsStore) SetMany(values [][2]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.load().clone()
	for _, kv := range values {
		if kv[0] != "" {
			m.set(kv[0], kv[1])
		}
	}
	file := s.Path()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	tmp := file + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, []byte(m.stringify()), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	s.cache = m
	return nil
}

// Remove deletes a secret if present (in-place write, 0600).
func (s *SecretsStore) Remove(ref string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.load()
	if _, ok := m.get(ref); !ok {
		return nil
	}
	m = m.clone()
	m.del(ref)
	file := s.Path()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(file, []byte(m.stringify()), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	s.cache = m
	return nil
}

// ResolveS3Credentials resolves the access/secret refs of an app's
// config.yaml; unresolved refs yield "".
func (s *SecretsStore) ResolveS3Credentials(accessKeyRef, secretKeyRef string) (accessKey, secretKey string) {
	accessKey, _ = s.Get(accessKeyRef)
	secretKey, _ = s.Get(secretKeyRef)
	return accessKey, secretKey
}

// ReadFresh re-reads secrets.json bypassing the cache (AppsService
// readSecrets). Non-string values come back as their JSON text; nulls are
// omitted.
func (s *SecretsStore) ReadFresh() map[string]string {
	s.mu.Lock()
	m := readSecretsFile(s.Path())
	s.mu.Unlock()
	out := make(map[string]string, len(m.keys))
	for _, k := range m.keys {
		if v := m.vals[k]; !v.null {
			out[k] = v.text()
		}
	}
	return out
}

// WriteSecret is AppsService.writeSecret: fresh read, set one key, plain
// (non-atomic) write with mode 0600. It does not touch the cache — callers
// Invalidate() afterwards, as Node does.
func (s *SecretsStore) WriteSecret(ref, value string) error {
	if ref == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file := s.Path()
	if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
		return err
	}
	m := readSecretsFile(file)
	m.set(ref, value)
	if err := os.WriteFile(file, []byte(m.stringify()), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	return nil
}

// ---------------------------------------------------------------------------
// JS-object-ordered map + JSON.stringify(map, null, 2)
// ---------------------------------------------------------------------------

// secretValue is a string, or any other JSON value kept as its source text.
type secretValue struct {
	isStr bool
	null  bool
	str   string
	raw   json.RawMessage
}

func (v secretValue) text() string {
	if v.isStr {
		return v.str
	}
	return string(v.raw)
}

// secretsMap keeps keys in insertion order; stringify applies JS own-key
// order (array-index keys ascending first).
type secretsMap struct {
	keys []string
	vals map[string]secretValue
}

func newSecretsMap() *secretsMap { return &secretsMap{vals: map[string]secretValue{}} }

func (m *secretsMap) get(k string) (secretValue, bool) {
	v, ok := m.vals[k]
	return v, ok
}

func (m *secretsMap) put(k string, v secretValue) {
	if _, ok := m.vals[k]; !ok {
		m.keys = append(m.keys, k)
	}
	m.vals[k] = v
}

func (m *secretsMap) set(k, v string) { m.put(k, secretValue{isStr: true, str: v}) }

func (m *secretsMap) del(k string) {
	if _, ok := m.vals[k]; !ok {
		return
	}
	delete(m.vals, k)
	for i, x := range m.keys {
		if x == k {
			m.keys = append(m.keys[:i:i], m.keys[i+1:]...)
			break
		}
	}
}

func (m *secretsMap) clone() *secretsMap {
	c := &secretsMap{keys: append([]string(nil), m.keys...), vals: make(map[string]secretValue, len(m.vals))}
	for k, v := range m.vals {
		c.vals[k] = v
	}
	return c
}

// arrayIndex reports whether k is a canonical JS array index (< 2^32-1).
func arrayIndex(k string) (uint64, bool) {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= 1<<32-1 {
		return 0, false
	}
	return n, true
}

// orderedKeys is the JS own-property order.
func (m *secretsMap) orderedKeys() []string {
	var idx, rest []string
	for _, k := range m.keys {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(idx, func(i, j int) bool {
		a, _ := arrayIndex(idx[i])
		b, _ := arrayIndex(idx[j])
		return a < b
	})
	return append(idx, rest...)
}

// stringify is JSON.stringify(map, null, 2).
func (m *secretsMap) stringify() string {
	keys := m.orderedKeys()
	if len(keys) == 0 {
		return "{}"
	}
	var b strings.Builder
	b.WriteString("{\n")
	for i, k := range keys {
		if i > 0 {
			b.WriteString(",\n")
		}
		b.WriteString("  ")
		b.WriteString(jsQuote(k))
		b.WriteString(": ")
		v := m.vals[k]
		if v.isStr {
			b.WriteString(jsQuote(v.str))
		} else {
			var ind bytes.Buffer
			if json.Indent(&ind, v.raw, "  ", "  ") == nil {
				b.Write(ind.Bytes())
			} else {
				b.Write(v.raw)
			}
		}
	}
	b.WriteString("\n}")
	return b.String()
}

// jsQuote is JSON.stringify(string): no HTML escaping, lower-case \u00xx.
func jsQuote(s string) string {
	const hex = "0123456789abcdef"
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hex[r>>4])
				b.WriteByte(hex[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// readSecretsFile parses secrets.json; missing, corrupt or non-object → empty.
func readSecretsFile(file string) *secretsMap {
	data, err := os.ReadFile(file)
	if err != nil {
		return newSecretsMap()
	}
	m, err := parseSecrets(data)
	if err != nil {
		return newSecretsMap()
	}
	return m
}

// parseSecrets is JSON.parse of a top-level object, keeping key order
// (a duplicate key keeps its first position and its last value).
func parseSecrets(data []byte) (*secretsMap, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errNotObject
	}
	m := newSecretsMap()
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := kt.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		v := secretValue{raw: raw}
		switch {
		case len(raw) > 0 && raw[0] == '"':
			if err := json.Unmarshal(raw, &v.str); err != nil {
				return nil, err
			}
			v.isStr, v.raw = true, nil
		case string(raw) == "null":
			v.null = true
		}
		m.put(key, v)
	}
	if _, err := dec.Token(); err != nil { // closing '}'
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF { // trailing garbage
		return nil, errNotObject
	}
	return m, nil
}

type parseError string

func (e parseError) Error() string { return string(e) }

const errNotObject = parseError("secrets.json is not a JSON object")
