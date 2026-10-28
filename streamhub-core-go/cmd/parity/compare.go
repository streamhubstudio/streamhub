package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Generic normalizers, applied to every JSON string value (and to text
// bodies / compared headers) unless the case is strict. Each side is
// normalized independently, then the results are compared.
var (
	reISO   = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})`)
	reSQLTs = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b`)
	// No leading \b: ids are prefixed (usr_<uuid>, tnt_<uuid>) and '_' is a word char.
	reUUID = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	reJWT  = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
	reSK   = regexp.MustCompile(`\bsk_[A-Za-z0-9_-]{16,}`)
	// RateLimit draft-7 header: the window-reset countdown drifts by a second.
	reReset = regexp.MustCompile(`reset=\d+`)
	reEtag  = regexp.MustCompile(`W/"[0-9a-f]+-[A-Za-z0-9+/=]+"`)
)

const (
	maskValue    = "<masked>"
	ignoredValue = "<ignored>"
)

// normalizer holds one side's variables (for reverse substitution) and the
// per-response uuid ordinal table.
type normalizer struct {
	vars   []varPair // longest value first
	strict bool
	uuids  map[string]int
}

type varPair struct{ name, value string }

func newNormalizer(vars map[string]any, strict bool) *normalizer {
	n := &normalizer{strict: strict, uuids: map[string]int{}}
	for k, v := range vars {
		s, ok := v.(string)
		if !ok || len(s) < 6 {
			continue // short values ("1", "live") would rewrite unrelated text
		}
		n.vars = append(n.vars, varPair{k, s})
	}
	sort.Slice(n.vars, func(i, j int) bool {
		if len(n.vars[i].value) != len(n.vars[j].value) {
			return len(n.vars[i].value) > len(n.vars[j].value)
		}
		return n.vars[i].name < n.vars[j].name
	})
	return n
}

// str normalizes one string. Known vars are rewritten to {{name}} first so
// values both sides captured independently (ids, JWTs) compare equal, and
// fixture values (identical on both sides) are still checked exactly.
func (n *normalizer) str(s string) string {
	for _, v := range n.vars {
		if s == v.value {
			return "{{" + v.name + "}}"
		}
	}
	for _, v := range n.vars {
		if len(v.value) >= 12 && strings.Contains(s, v.value) {
			s = strings.ReplaceAll(s, v.value, "{{"+v.name+"}}")
		}
	}
	if n.strict {
		return s
	}
	s = reJWT.ReplaceAllString(s, "<jwt>")
	s = reSK.ReplaceAllString(s, "<sk_token>")
	s = reISO.ReplaceAllString(s, "<iso-ts>")
	s = reSQLTs.ReplaceAllString(s, "<sql-ts>")
	s = reUUID.ReplaceAllStringFunc(s, func(u string) string {
		u = strings.ToLower(u)
		i, ok := n.uuids[u]
		if !ok {
			i = len(n.uuids) + 1
			n.uuids[u] = i
		}
		return fmt.Sprintf("<uuid#%d>", i)
	})
	return s
}

// normalizeJSON returns a normalized deep copy. Map keys are visited in sorted
// order so uuid ordinals are deterministic.
func (n *normalizer) normalizeJSON(v any) any {
	switch t := v.(type) {
	case string:
		return n.str(t)
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(t))
		for _, k := range keys {
			out[k] = n.normalizeJSON(t[k])
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = n.normalizeJSON(e)
		}
		return out
	}
	return v
}

// prepareBody applies ignore/mask paths, then normalizers, then sorts
// unordered arrays.
func prepareBody(v any, c *tcase, d defaults, vars map[string]any) any {
	v = deepCopy(v)
	for _, p := range append(append([]string{}, d.Ignore...), c.Ignore...) {
		applyAt(v, splitPath(p), func(parent any, key string) {
			switch t := parent.(type) {
			case map[string]any:
				delete(t, key)
			case []any:
				i, _ := strconv.Atoi(key)
				t[i] = ignoredValue
			}
		})
	}
	for _, p := range append(append([]string{}, d.Mask...), c.Mask...) {
		applyAt(v, splitPath(p), func(parent any, key string) {
			switch t := parent.(type) {
			case map[string]any:
				t[key] = maskValue
			case []any:
				i, _ := strconv.Atoi(key)
				t[i] = maskValue
			}
		})
	}
	v = newNormalizer(vars, c.Strict).normalizeJSON(v)
	for _, p := range c.Unordered {
		sortArrayAt(&v, splitPath(p))
	}
	return v
}

func sortArrayAt(root *any, segs []string) {
	sortOne := func(a []any) {
		sort.SliceStable(a, func(i, j int) bool { return canon(a[i]) < canon(a[j]) })
	}
	if len(segs) == 0 {
		if a, ok := (*root).([]any); ok {
			sortOne(a)
		}
		return
	}
	applyAt(*root, segs, func(parent any, key string) {
		var child any
		switch t := parent.(type) {
		case map[string]any:
			child = t[key]
		case []any:
			i, _ := strconv.Atoi(key)
			child = t[i]
		}
		if a, ok := child.([]any); ok {
			sortOne(a)
		}
	})
}

func canon(v any) string {
	b, _ := json.Marshal(v) // map keys are sorted by encoding/json
	return string(b)
}

func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = deepCopy(e)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = deepCopy(e)
		}
		return out
	}
	return v
}

// diffJSON reports differences between two normalized JSON values. Key order
// is irrelevant (maps); null vs missing IS a difference.
func diffJSON(path string, a, b any, out *[]string) {
	if path == "" {
		path = "$"
	}
	switch at := a.(type) {
	case map[string]any:
		bt, ok := b.(map[string]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: type node=object go=%s", path, typeName(b)))
			return
		}
		keys := map[string]bool{}
		for k := range at {
			keys[k] = true
		}
		for k := range bt {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			av, aok := at[k]
			bv, bok := bt[k]
			p := path + "." + k
			switch {
			case !bok:
				*out = append(*out, fmt.Sprintf("%s: missing on go (node=%s)", p, short(av)))
			case !aok:
				*out = append(*out, fmt.Sprintf("%s: extra on go (go=%s)", p, short(bv)))
			default:
				diffJSON(p, av, bv, out)
			}
		}
	case []any:
		bt, ok := b.([]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: type node=array go=%s", path, typeName(b)))
			return
		}
		if len(at) != len(bt) {
			*out = append(*out, fmt.Sprintf("%s: length node=%d go=%d", path, len(at), len(bt)))
		}
		for i := 0; i < len(at) && i < len(bt); i++ {
			diffJSON(fmt.Sprintf("%s.%d", path, i), at[i], bt[i], out)
		}
	case json.Number:
		bt, ok := b.(json.Number)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: type node=number(%s) go=%s(%s)", path, at, typeName(b), short(b)))
			return
		}
		if !numEqual(at, bt) {
			*out = append(*out, fmt.Sprintf("%s: node=%s go=%s", path, at, bt))
		}
	default:
		if typeName(a) != typeName(b) {
			*out = append(*out, fmt.Sprintf("%s: type node=%s(%s) go=%s(%s)", path, typeName(a), short(a), typeName(b), short(b)))
			return
		}
		if a != b {
			*out = append(*out, fmt.Sprintf("%s: node=%s go=%s", path, short(a), short(b)))
		}
	}
}

func numEqual(a, b json.Number) bool {
	if a == b {
		return true
	}
	fa, _, errA := big.ParseFloat(string(a), 10, 128, big.ToNearestEven)
	fb, _, errB := big.ParseFloat(string(b), 10, 128, big.ToNearestEven)
	return errA == nil && errB == nil && fa.Cmp(fb) == 0
}

func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "bool"
	case json.Number:
		return "number"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	}
	return fmt.Sprintf("%T", v)
}

func short(v any) string {
	s := canon(v)
	if len(s) > 160 {
		s = s[:157] + "..."
	}
	return s
}

// headerValue returns the normalized value of a compared header ("" = absent).
func headerValue(h http.Header, name string, n *normalizer) (string, bool) {
	vals := h.Values(name)
	if len(vals) == 0 {
		return "", false
	}
	v := strings.Join(vals, ", ")
	if strings.EqualFold(name, "content-type") {
		v = strings.ToLower(strings.ReplaceAll(v, " ", ""))
	}
	v = reReset.ReplaceAllString(v, "reset=<n>")
	v = reEtag.ReplaceAllString(v, "<etag>")
	return n.str(v), true
}
