package httpx

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// ParseURLEncoded is body-parser 2.x's extended urlencoded parser: qs 6.x
// parse with allowPrototypes, depth 32 + strictDepth (deeper → errDepth),
// arrayLimit max(100, paramCount), parameterLimit 1000 (more → errTooMany).
// Objects come back as *y.Map (JS key order), arrays as []any, leaves as
// strings — the shape JSON.stringify(req.body) would have.
func ParseURLEncoded(body string) (*y.Map, error) {
	out := y.NewMap()
	if body == "" {
		return out, nil
	}
	count := strings.Count(body, "&") + 1
	if count > urlencodedParamLimit {
		return nil, errTooMany
	}
	arrayLimit := max(100, count)

	// parseValues: flat key → value (duplicates combine into an array).
	type kv struct {
		key string
		val any
	}
	var flat []kv
	index := map[string]int{}
	for _, part := range strings.Split(body, "&") {
		if part == "" {
			continue
		}
		var key, val string
		pos := strings.Index(part, "]=")
		if pos == -1 {
			pos = strings.Index(part, "=")
		} else {
			pos++
		}
		if pos == -1 {
			key = qsDecode(part)
		} else {
			key, val = qsDecode(part[:pos]), qsDecode(part[pos+1:])
		}
		if i, ok := index[key]; ok {
			flat[i].val = combine(flat[i].val, val)
			continue
		}
		index[key] = len(flat)
		flat = append(flat, kv{key, val})
	}

	var obj any = out
	for _, e := range flat {
		if e.key == "" {
			continue
		}
		chain, err := splitKey(e.key)
		if err != nil {
			return nil, err
		}
		obj = qsMerge(obj, parseObject(chain, e.val, arrayLimit))
	}
	m, ok := compact(obj).(*y.Map)
	if !ok {
		return y.NewMap(), nil
	}
	return m, nil
}

const (
	urlencodedParamLimit = 1000
	urlencodedDepth      = 32
)

var (
	errTooMany = Nest(413, "too many parameters")
	errDepth   = BadRequest("The input exceeded the depth")
)

// jsArr is a mutable JS array (holes = qsHole until compacted).
type jsArr struct{ v []any }

type holeT struct{}

var qsHole = holeT{}

func qsDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	if d, err := url.PathUnescape(s); err == nil && utf8.ValidString(d) {
		return d
	}
	return s
}

func combine(a, b any) any {
	var out []any
	for _, v := range []any{a, b} {
		if arr, ok := v.(*jsArr); ok {
			out = append(out, arr.v...)
		} else {
			out = append(out, v)
		}
	}
	return &jsArr{out}
}

// splitKey is qs 6.15 splitKeyIntoSegments (allowDots off, strictDepth
// on): the parent before the first '[', then up to `depth` balanced bracket
// groups (text between groups is dropped); an unterminated group becomes one
// literal segment; groups left beyond the depth are an error.
func splitKey(key string) ([]string, error) {
	var segs []string
	open := strings.IndexByte(key, '[')
	parent := key
	if open >= 0 {
		parent = key[:open]
	}
	if parent != "" {
		segs = append(segs, parent)
	}
	for collected := 0; open >= 0 && collected < urlencodedDepth; collected++ {
		level, close := 1, -1
		for i := open + 1; i < len(key) && close < 0; i++ {
			switch key[i] {
			case '[':
				level++
			case ']':
				if level--; level == 0 {
					close = i
				}
			}
		}
		if close < 0 {
			return append(segs, "["+key[open:]+"]"), nil
		}
		segs = append(segs, key[open:close+1])
		if next := strings.IndexByte(key[close+1:], '['); next >= 0 {
			open = close + 1 + next
		} else {
			open = -1
		}
	}
	if open >= 0 {
		return nil, errDepth
	}
	return segs, nil
}

func parseObject(chain []string, val any, arrayLimit int) any {
	leaf := val
	for i := len(chain) - 1; i >= 0; i-- {
		root := chain[i]
		if root == "[]" {
			leaf = combine(&jsArr{}, leaf)
			continue
		}
		clean := root
		if strings.HasPrefix(root, "[") && strings.HasSuffix(root, "]") {
			clean = root[1 : len(root)-1]
		}
		idx, isIdx := jsParseInt(clean)
		if isIdx && root != clean && strconv.Itoa(idx) == clean && idx >= 0 && idx < arrayLimit {
			arr := &jsArr{make([]any, idx+1)}
			for j := range arr.v {
				arr.v[j] = qsHole
			}
			arr.v[idx] = leaf
			leaf = arr
			continue
		}
		m := y.NewMap()
		if clean != "__proto__" {
			m.Set(clean, leaf)
		}
		leaf = m
	}
	return leaf
}

var leadingInt = regexp.MustCompile(`^\s*[+-]?\d+`)

// jsParseInt is parseInt(s, 10) (ok=false for NaN).
func jsParseInt(s string) (int, bool) {
	m := leadingInt.FindString(s)
	if m == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(m), 64)
	if err != nil || n > math.MaxInt32 || n < math.MinInt32 {
		return 0, false
	}
	return int(n), true
}

func isObj(v any) bool {
	switch v.(type) {
	case *y.Map, *jsArr:
		return true
	}
	return false
}

// arrayToObject turns an array into an index-keyed object (holes skipped).
func arrayToObject(a *jsArr) *y.Map {
	m := y.NewMap()
	for i, v := range a.v {
		if v != qsHole {
			m.Set(strconv.Itoa(i), v)
		}
	}
	return m
}

// qsMerge is qs utils.merge (allowPrototypes on).
func qsMerge(target, source any) any {
	if source == nil {
		return target
	}
	if !isObj(source) {
		switch t := target.(type) {
		case *jsArr:
			t.v = append(t.v, source)
			return t
		case *y.Map:
			return &jsArr{[]any{t, source}} // strictMerge (qs 6.15 default)
		}
		return &jsArr{[]any{target, source}}
	}
	if target == nil || !isObj(target) {
		out := []any{target}
		if sa, ok := source.(*jsArr); ok {
			out = append(out, sa.v...)
		} else {
			out = append(out, source)
		}
		return &jsArr{out}
	}
	ta, tIsArr := target.(*jsArr)
	sa, sIsArr := source.(*jsArr)
	if tIsArr && !sIsArr {
		target = arrayToObject(ta)
		tIsArr = false
	}
	if tIsArr && sIsArr {
		for i, item := range sa.v {
			if item == qsHole {
				continue
			}
			if i < len(ta.v) && ta.v[i] != qsHole {
				if isObj(ta.v[i]) && isObj(item) {
					ta.v[i] = qsMerge(ta.v[i], item)
				} else {
					ta.v = append(ta.v, item)
				}
				continue
			}
			for len(ta.v) <= i {
				ta.v = append(ta.v, qsHole)
			}
			ta.v[i] = item
		}
		return ta
	}
	tm := target.(*y.Map)
	var srcKeys []string
	var get func(string) any
	if sIsArr {
		sm := arrayToObject(sa)
		srcKeys, get = sm.Keys(), sm.Get
	} else {
		sm := source.(*y.Map)
		srcKeys, get = sm.Keys(), sm.Get
	}
	for _, k := range srcKeys {
		v := get(k)
		if cur, ok := tm.Lookup(k); ok {
			tm.Set(k, qsMerge(cur, v))
		} else {
			tm.Set(k, v)
		}
	}
	return tm
}

// compact drops array holes recursively and unwraps jsArr into []any.
func compact(v any) any {
	switch t := v.(type) {
	case *jsArr:
		out := make([]any, 0, len(t.v))
		for _, e := range t.v {
			if e != qsHole {
				out = append(out, compact(e))
			}
		}
		return out
	case *y.Map:
		for _, k := range t.Keys() {
			t.Set(k, compact(t.Get(k)))
		}
		return t
	}
	return v
}
