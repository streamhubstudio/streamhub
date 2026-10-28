package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// observed is one response reduced to exactly what the comparison looks at:
// status, the case's compared headers (normalized; nil = absent) and the
// normalized body. The live diff builds one per side; -record stores Node's
// in golden/; -replay rebuilds Node's from golden/ and diffs Go against it.
type observed struct {
	Status  int
	Headers map[string]*string
	IsJSON  bool // body was JSON (and compared as JSON)
	Body    any  // normalized JSON value or normalized text; nil in "status" mode
}

// observe reduces a response with one side's variables.
func observe(r *response, c *tcase, d defaults, vars map[string]any) *observed {
	o := &observed{Status: r.Status, Headers: map[string]*string{}}
	n := newNormalizer(vars, c.Strict)
	masked := map[string]bool{}
	for _, h := range append(append([]string{}, d.MaskHeaders...), c.MaskHeaders...) {
		masked[strings.ToLower(h)] = true
	}
	for _, h := range compareHeaderList(c, d) {
		if v, ok := headerValue(r.Headers, h, n); ok {
			if masked[h] {
				v = maskValue
			}
			o.Headers[h] = &v
		} else {
			o.Headers[h] = nil
		}
	}
	if compareMode(c) != "status" {
		o.IsJSON = r.IsJSON && c.Compare != "text"
		o.Body = normalizedBody(r, c, d, vars)
	}
	return o
}

func compareMode(c *tcase) string {
	if c.Compare == "" {
		return "json"
	}
	return c.Compare
}

// diffObserved compares a reference (Node: live or recorded) with Go.
func diffObserved(c *tcase, d defaults, ref, got *observed) []string {
	var diffs []string
	if ref.Status != got.Status {
		diffs = append(diffs, fmt.Sprintf("status: node=%d go=%d", ref.Status, got.Status))
	}
	for _, h := range compareHeaderList(c, d) {
		rv, rok := ref.Headers[h]
		if !rok {
			diffs = append(diffs, fmt.Sprintf("header %s: not in the recording (case changed after recording?)", h))
			continue
		}
		gv := got.Headers[h]
		switch {
		case rv != nil && gv == nil:
			diffs = append(diffs, fmt.Sprintf("header %s: missing on go (node=%q)", h, *rv))
		case rv == nil && gv != nil:
			diffs = append(diffs, fmt.Sprintf("header %s: extra on go (go=%q)", h, *gv))
		case rv != nil && *rv != *gv:
			diffs = append(diffs, fmt.Sprintf("header %s: node=%q go=%q", h, *rv, *gv))
		}
	}
	mode := compareMode(c)
	if mode == "status" {
		return diffs
	}
	switch {
	case mode == "json" && ref.IsJSON && got.IsJSON:
		diffJSON("", ref.Body, got.Body, &diffs)
	case mode == "json" && ref.IsJSON != got.IsJSON:
		diffs = append(diffs, fmt.Sprintf("body: node json=%v go json=%v (go body: %s)", ref.IsJSON, got.IsJSON, truncate(fmt.Sprint(got.Body), 200)))
	default:
		if fmt.Sprint(ref.Body) != fmt.Sprint(got.Body) {
			diffs = append(diffs, fmt.Sprintf("body text differs:\n      node: %s\n      go:   %s", truncate(fmt.Sprint(ref.Body), 300), truncate(fmt.Sprint(got.Body), 300)))
		}
	}
	return diffs
}

// ---- golden files ------------------------------------------------------------

// goldenFile is test/parity/golden/<module>.json: the case file's recorded
// Node responses, in case order. Key order inside objects is sorted by
// encoding/json, so a re-record of an unchanged contract is a no-op diff.
type goldenFile struct {
	Module string         `json:"module"`
	Cases  []*goldenEntry `json:"cases"`
}

type goldenEntry struct {
	Name string `json:"name"`
	// Fingerprint hashes everything about the case that shapes the request or
	// the comparison (not name/note/skip/expectStatus). Replay refuses an
	// entry whose case changed since it was recorded.
	Fingerprint string             `json:"fingerprint"`
	Request     goldenRequest      `json:"request"`
	Skip        string             `json:"skip,omitempty"`
	Source      string             `json:"source,omitempty"` // "" = the Node oracle; "go" = accepted from Go (-accept)
	Status      int                `json:"status,omitempty"`
	Headers     map[string]*string `json:"headers,omitempty"`
	BodyKind    string             `json:"bodyKind,omitempty"` // json | text | "" (status-only)
	Body        json.RawMessage    `json:"body,omitempty"`
}

// goldenRequest documents the request template (placeholders unresolved).
type goldenRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Auth    string            `json:"auth,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`
	RawBody *string           `json:"rawBody,omitempty"`
}

// goldenMeta is golden/_meta.json: what the recording was made against.
type goldenMeta struct {
	Oracle       string   `json:"oracle"`
	AppVersion   string   `json:"appVersion"`
	VendorDigest string   `json:"vendorDigest"`
	VendorApps   []string `json:"vendorApps"`
	Note         string   `json:"note"`
}

const metaFile = "_meta.json"

// fingerprint covers the file-level knobs (defaults, env) and the case's
// request + comparison fields.
func fingerprint(f *caseFile, c *tcase) string {
	type fp struct {
		Env            map[string]string `json:"env,omitempty"`
		Defaults       defaults          `json:"defaults"`
		Method, Path   string
		Auth           string            `json:"auth,omitempty"`
		Headers        map[string]string `json:"headers,omitempty"`
		Body           any               `json:"body,omitempty"`
		RawBody        *string           `json:"rawBody,omitempty"`
		Compare        string            `json:"compare,omitempty"`
		CompareHeaders []string          `json:"compareHeaders,omitempty"`
		MaskHeaders    []string          `json:"maskHeaders,omitempty"`
		Ignore         []string          `json:"ignore,omitempty"`
		Mask           []string          `json:"mask,omitempty"`
		Unordered      []string          `json:"unordered,omitempty"`
		Strict         bool              `json:"strict,omitempty"`
		Capture        map[string]string `json:"capture,omitempty"`
	}
	var body any
	if len(c.Body) > 0 {
		body, _ = decodeJSON(c.Body) // re-encoded canonically: formatting changes don't matter
	}
	b, _ := json.Marshal(fp{f.Env, f.Defaults, c.Method, c.Path, c.Auth, c.Headers, body, c.RawBody,
		c.Compare, c.CompareHeaders, c.MaskHeaders, c.Ignore, c.Mask, c.Unordered, c.Strict, c.Capture})
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:8])
}

func newGoldenEntry(f *caseFile, c *tcase) *goldenEntry {
	e := &goldenEntry{
		Name:        c.Name,
		Fingerprint: fingerprint(f, c),
		Request:     goldenRequest{Method: c.Method, Path: c.Path, Auth: c.Auth, Headers: c.Headers, RawBody: c.RawBody},
		Skip:        c.Skip,
	}
	if len(c.Body) > 0 {
		var buf bytes.Buffer
		if json.Compact(&buf, c.Body) == nil {
			e.Request.Body = buf.Bytes()
		}
	}
	return e
}

// setObserved stores an observation in the entry.
func (e *goldenEntry) setObserved(o *observed, c *tcase) error {
	e.Status, e.Headers, e.BodyKind, e.Body = o.Status, o.Headers, "", nil
	if len(e.Headers) == 0 {
		e.Headers = nil
	}
	if compareMode(c) == "status" {
		return nil
	}
	e.BodyKind = "text"
	if o.IsJSON {
		e.BodyKind = "json"
	}
	b, err := marshalNoEscape(o.Body)
	if err != nil {
		return err
	}
	e.Body = b
	return nil
}

// observed rebuilds the recorded observation.
func (e *goldenEntry) observed() (*observed, error) {
	o := &observed{Status: e.Status, Headers: e.Headers}
	if o.Headers == nil {
		o.Headers = map[string]*string{}
	}
	switch e.BodyKind {
	case "":
		return o, nil
	case "json", "text":
		v, err := decodeJSON(e.Body)
		if err != nil {
			return nil, fmt.Errorf("golden body: %w", err)
		}
		o.IsJSON, o.Body = e.BodyKind == "json", v
		return o, nil
	}
	return nil, fmt.Errorf("golden: unknown bodyKind %q", e.BodyKind)
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func goldenPath(dir, module string) string { return filepath.Join(dir, module+".json") }

func loadGolden(dir, module string) (*goldenFile, error) {
	b, err := os.ReadFile(goldenPath(dir, module))
	if err != nil {
		return nil, err
	}
	g := &goldenFile{}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(g); err != nil {
		return nil, fmt.Errorf("%s: %w", goldenPath(dir, module), err)
	}
	return g, nil
}

func (g *goldenFile) index() map[string]*goldenEntry {
	m := make(map[string]*goldenEntry, len(g.Cases))
	for _, e := range g.Cases {
		m[e.Name] = e
	}
	return m
}

// mergeGolden writes the module's golden file: entries in case-file order,
// fresh entries replacing old ones, untouched cases keeping their old entry
// (a -module/-case run updates only what it ran). Entries for cases no longer
// in the file are dropped.
func mergeGolden(dir string, f *caseFile, fresh map[string]*goldenEntry) error {
	old := map[string]*goldenEntry{}
	if g, err := loadGolden(dir, f.Module); err == nil {
		old = g.index()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	out := &goldenFile{Module: f.Module}
	for _, c := range f.Cases {
		if e, ok := fresh[c.Name]; ok {
			out.Cases = append(out.Cases, e)
		} else if e, ok := old[c.Name]; ok {
			out.Cases = append(out.Cases, e)
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(goldenPath(dir, f.Module), buf.Bytes(), 0o644)
}

func writeMeta(dir string, m *goldenMeta) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, metaFile), append(b, '\n'), 0o644)
}

func readMeta(dir string) (*goldenMeta, error) {
	b, err := os.ReadFile(filepath.Join(dir, metaFile))
	if err != nil {
		return nil, err
	}
	m := &goldenMeta{}
	return m, json.Unmarshal(b, m)
}

// vendorDigest hashes the composed vendor dir (relative path + bytes of every
// regular file inside the app dirs, sorted; __pycache__ and top-level files
// such as the repo's README.md ignored): the recorded responses depend on
// which decoupled apps were composed, at which versions.
func vendorDigest(dir string) (digest string, apps []string, err error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return "", nil, err
	}
	for _, e := range ents {
		if e.IsDir() {
			apps = append(apps, e.Name())
		}
	}
	var files []string
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == "__pycache__" {
			return filepath.SkipDir
		}
		if d.Type().IsRegular() && filepath.Dir(p) != dir {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	sort.Strings(files)
	h := sha256.New()
	for _, p := range files {
		rel, _ := filepath.Rel(dir, p)
		fmt.Fprintf(h, "%s\x00", filepath.ToSlash(rel))
		fh, err := os.Open(p)
		if err != nil {
			return "", nil, err
		}
		_, err = io.Copy(h, fh)
		fh.Close()
		if err != nil {
			return "", nil, err
		}
		h.Write([]byte{0})
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), apps, nil
}

func shortList(s []string) string { return strings.Join(s, ",") }
