package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// caseFile is one test/parity/cases/<module>.json.
type caseFile struct {
	Module      string   `json:"module"`
	Description string   `json:"description,omitempty"`
	Defaults    defaults `json:"defaults"`
	// Env is extra server env for this file (over baseEnv and -env). Files
	// with a distinct env run against their own server pair, booted on a
	// fresh copy of the seeded fixture.
	Env   map[string]string `json:"env,omitempty"`
	Cases []*tcase          `json:"cases"`
	path  string
}

// envKey identifies a file's env group ("" = the default pair).
func (f *caseFile) envKey() string {
	if len(f.Env) == 0 {
		return ""
	}
	keys := make([]string, 0, len(f.Env))
	for k := range f.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k + "=" + f.Env[k] + "\n")
	}
	return b.String()
}

// defaults apply to every case of a file (case values are appended).
type defaults struct {
	Headers        map[string]string `json:"headers,omitempty"`
	CompareHeaders []string          `json:"compareHeaders,omitempty"`
	MaskHeaders    []string          `json:"maskHeaders,omitempty"` // compared headers whose VALUE is masked (presence still compared)
	Ignore         []string          `json:"ignore,omitempty"`
	Mask           []string          `json:"mask,omitempty"`
}

// tcase is one request run against both servers.
type tcase struct {
	Name    string            `json:"name"`
	Note    string            `json:"note,omitempty"`
	Skip    string            `json:"skip,omitempty"` // non-empty = skipped, value is the reason
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Auth    string            `json:"auth,omitempty"` // var name → "Authorization: Bearer {{var}}"
	Headers map[string]string `json:"headers,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`    // JSON body (placeholders resolved)
	RawBody *string           `json:"rawBody,omitempty"` // sent verbatim (after placeholders)
	// SleepMs waits before sending (each side): for state keyed by wall-clock
	// time, e.g. ms-stamped config backups two fast writes would collide on.
	SleepMs int `json:"sleepMs,omitempty"`

	// Compare: "json" (default; falls back to text for non-JSON bodies),
	// "text", or "status" (status + headers only).
	Compare        string            `json:"compare,omitempty"`
	ExpectStatus   int               `json:"expectStatus,omitempty"` // asserted on Node: guards the corpus itself
	CompareHeaders []string          `json:"compareHeaders,omitempty"`
	MaskHeaders    []string          `json:"maskHeaders,omitempty"` // compared headers whose VALUE is masked (presence still compared)
	Ignore         []string          `json:"ignore,omitempty"`      // paths dropped on both sides
	Mask           []string          `json:"mask,omitempty"`        // paths whose VALUE is masked (presence still compared)
	Unordered      []string          `json:"unordered,omitempty"`   // array paths compared as multisets
	Strict         bool              `json:"strict,omitempty"`      // disable generic normalizers
	Capture        map[string]string `json:"capture,omitempty"`     // var → path ("header:Name" for a header)
}

func loadCases(dir string) ([]*caseFile, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var out []*caseFile
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		cf := &caseFile{path: f}
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		if err := dec.Decode(cf); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if cf.Module == "" {
			cf.Module = strings.TrimSuffix(filepath.Base(f), ".json")
		}
		seen := map[string]bool{}
		for i, c := range cf.Cases {
			if c.Name == "" || c.Method == "" || c.Path == "" {
				return nil, fmt.Errorf("%s: case #%d needs name, method and path", f, i)
			}
			if seen[c.Name] {
				return nil, fmt.Errorf("%s: duplicate case name %q", f, c.Name)
			}
			seen[c.Name] = true
			switch c.Compare {
			case "", "json", "text", "status":
			default:
				return nil, fmt.Errorf("%s: case %q: unknown compare %q", f, c.Name, c.Compare)
			}
		}
		out = append(out, cf)
	}
	return out, nil
}

// response is what one server answered, plus the request error if any.
type response struct {
	Status  int
	Headers http.Header
	Raw     []byte
	JSON    any  // decoded body (UseNumber) when IsJSON
	IsJSON  bool // body parsed as JSON
	Err     error
	Elapsed time.Duration
}

var placeholderRe = regexp.MustCompile(`\{\{([A-Za-z0-9_.]+)\}\}`)

// resolveString substitutes {{var}} occurrences; unknown vars are an error.
func resolveString(s string, vars map[string]any) (string, error) {
	var missing []string
	out := placeholderRe.ReplaceAllStringFunc(s, func(m string) string {
		name := m[2 : len(m)-2]
		v, ok := vars[name]
		if !ok {
			missing = append(missing, name)
			return m
		}
		return scalarString(v)
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("unresolved placeholder(s): %s", strings.Join(missing, ", "))
	}
	return out, nil
}

// resolveJSON walks a decoded JSON value: a string that is exactly "{{var}}"
// becomes the var's JSON value (keeps numbers numbers); other strings get
// textual substitution.
func resolveJSON(v any, vars map[string]any) (any, error) {
	switch t := v.(type) {
	case string:
		if m := placeholderRe.FindStringSubmatch(t); m != nil && m[0] == t {
			val, ok := vars[m[1]]
			if !ok {
				return nil, fmt.Errorf("unresolved placeholder: %s", m[1])
			}
			return val, nil
		}
		return resolveString(t, vars)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			r, err := resolveJSON(e, vars)
			if err != nil {
				return nil, err
			}
			out[k] = r
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			r, err := resolveJSON(e, vars)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	}
	return v, nil
}

func scalarString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case nil:
		return ""
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func decodeJSON(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing data")
	}
	return v, nil
}

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	// Redirects are part of the contract: never follow them.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// execute runs one case against one server with that server's vars.
func execute(base string, c *tcase, fileHeaders map[string]string, vars map[string]any) *response {
	r := &response{}
	path, err := resolveString(c.Path, vars)
	if err != nil {
		r.Err = err
		return r
	}
	var body io.Reader
	contentType := ""
	switch {
	case c.RawBody != nil:
		s, err := resolveString(*c.RawBody, vars)
		if err != nil {
			r.Err = err
			return r
		}
		body = strings.NewReader(s)
	case len(c.Body) > 0:
		v, err := decodeJSON(c.Body)
		if err != nil {
			r.Err = fmt.Errorf("case body: %w", err)
			return r
		}
		if v, err = resolveJSON(v, vars); err != nil {
			r.Err = err
			return r
		}
		b, _ := json.Marshal(v)
		body = bytes.NewReader(b)
		contentType = "application/json"
	}
	req, err := http.NewRequest(c.Method, base+path, body)
	if err != nil {
		r.Err = err
		return r
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.Auth != "" {
		tok, ok := vars[c.Auth]
		if !ok {
			r.Err = fmt.Errorf("unresolved auth var: %s", c.Auth)
			return r
		}
		req.Header.Set("Authorization", "Bearer "+scalarString(tok))
	}
	for _, hs := range []map[string]string{fileHeaders, c.Headers} {
		for k, v := range hs {
			s, err := resolveString(v, vars)
			if err != nil {
				r.Err = err
				return r
			}
			req.Header.Set(k, s)
		}
	}
	start := time.Now()
	resp, err := httpClient.Do(req)
	r.Elapsed = time.Since(start)
	if err != nil {
		r.Err = err
		return r
	}
	defer resp.Body.Close()
	r.Status = resp.StatusCode
	r.Headers = resp.Header
	r.Raw, err = io.ReadAll(resp.Body)
	if err != nil {
		r.Err = err
		return r
	}
	if len(r.Raw) > 0 {
		if v, err := decodeJSON(r.Raw); err == nil {
			r.JSON, r.IsJSON = v, true
		}
	}
	return r
}

// capture extracts the case's captures from a response into vars.
func capture(c *tcase, r *response, vars map[string]any) []string {
	var errs []string
	names := make([]string, 0, len(c.Capture))
	for k := range c.Capture {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		p := c.Capture[name]
		if h, ok := strings.CutPrefix(p, "header:"); ok {
			if v := r.Headers.Get(h); v != "" {
				vars[name] = v
				continue
			}
			errs = append(errs, fmt.Sprintf("capture %s: header %s absent", name, h))
			continue
		}
		if !r.IsJSON {
			errs = append(errs, fmt.Sprintf("capture %s: body is not JSON", name))
			continue
		}
		v, ok := getPath(r.JSON, p)
		if !ok {
			errs = append(errs, fmt.Sprintf("capture %s: path %q not found", name, p))
			continue
		}
		vars[name] = v
	}
	return errs
}

// selector parses a "[key=value]" path segment (captures only): it picks the
// first array element whose field stringifies to value.
func selector(seg string) (key, value string, ok bool) {
	if !strings.HasPrefix(seg, "[") || !strings.HasSuffix(seg, "]") {
		return "", "", false
	}
	return strings.Cut(seg[1:len(seg)-1], "=")
}

// Paths are dotted: "data.entries.0.ts"; "*" matches every key/element;
// "" or "$" is the root. Captures also accept "[key=value]" on arrays
// ("data.[current=true].id").
func splitPath(p string) []string {
	p = strings.TrimPrefix(strings.TrimPrefix(p, "$"), ".")
	if p == "" {
		return nil
	}
	return strings.Split(p, ".")
}

func getPath(v any, p string) (any, bool) {
	cur := v
	for _, seg := range splitPath(p) {
		switch t := cur.(type) {
		case map[string]any:
			n, ok := t[seg]
			if !ok {
				return nil, false
			}
			cur = n
		case []any:
			if k, want, ok := selector(seg); ok {
				var found any
				for _, e := range t {
					if m, ok := e.(map[string]any); ok && m[k] != nil && scalarString(m[k]) == want {
						found = e
						break
					}
				}
				if found == nil {
					return nil, false
				}
				cur = found
				continue
			}
			i, err := strconv.Atoi(seg)
			if err != nil || i < 0 || i >= len(t) {
				return nil, false
			}
			cur = t[i]
		default:
			return nil, false
		}
	}
	return cur, true
}

// applyAt calls fn on every node matching the (possibly wildcarded) path;
// fn receives the parent container and key/index, and may mutate it.
func applyAt(v any, segs []string, fn func(parent any, key string)) {
	if len(segs) == 0 {
		return
	}
	seg, rest := segs[0], segs[1:]
	switch t := v.(type) {
	case map[string]any:
		keys := []string{seg}
		if seg == "*" {
			keys = keys[:0]
			for k := range t {
				keys = append(keys, k)
			}
		}
		for _, k := range keys {
			child, ok := t[k]
			if !ok {
				continue
			}
			if len(rest) == 0 {
				fn(t, k)
			} else {
				applyAt(child, rest, fn)
			}
		}
	case []any:
		var idx []int
		if seg == "*" {
			for i := range t {
				idx = append(idx, i)
			}
		} else if i, err := strconv.Atoi(seg); err == nil && i >= 0 && i < len(t) {
			idx = []int{i}
		}
		for _, i := range idx {
			if len(rest) == 0 {
				fn(t, strconv.Itoa(i))
			} else {
				applyAt(t[i], rest, fn)
			}
		}
	}
}
