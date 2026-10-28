package yamljs

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Load is yaml.load(text) with js-yaml's DEFAULT_SCHEMA. yaml.v3 only does
// the parsing; tag resolution, key stringification, merge keys and duplicate
// detection follow js-yaml's loader. An empty or comment-only document is
// Undefined; more than one document is an error.
//
// Error messages are not js-yaml's; only the fact that an input fails is
// part of the contract.
func Load(text string) (any, error) {
	if noDocument(text) {
		return Undefined, nil
	}
	if strings.IndexByte(text, 0) >= 0 {
		return nil, errors.New("yamljs: null byte is not allowed in input")
	}
	if emptyDocument(text) {
		return nil, nil // yaml.v3 rejects some of these (a lone tab, a bare "...")
	}
	dec := yaml.NewDecoder(strings.NewReader(text))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil // comments / blank lines only: one empty document → null
		}
		return nil, fmt.Errorf("yamljs: %w", err)
	}
	var extra yaml.Node
	switch err := dec.Decode(&extra); {
	case err == nil:
		return nil, errors.New("yamljs: expected a single document in the stream, but found more")
	case !errors.Is(err, io.EOF):
		return nil, fmt.Errorf("yamljs: %w", err)
	}
	l := &loader{done: map[*yaml.Node]any{}, busy: map[*yaml.Node]bool{}}
	v, _, err := l.node(&doc)
	return v, err
}

// noDocument mirrors loadDocuments' stream check: after appending the final
// newline and stripping a BOM, js-yaml reads no document at all (load →
// undefined) when only leading spaces and that one line break remain. Any
// other blank or comment-only input is a single empty document (→ null).
func noDocument(text string) bool {
	s := text
	if s != "" {
		if !strings.HasSuffix(s, "\n") && !strings.HasSuffix(s, "\r") {
			s += "\n"
		}
		s = strings.TrimPrefix(s, "\ufeff")
	}
	return len(strings.TrimLeft(s, " ")) <= 1
}

// emptyDocument reports a stream of only blank lines, comments and "..."
// markers: js-yaml reads it as one empty document (null).
func emptyDocument(text string) bool {
	for _, line := range strings.Split(strings.TrimPrefix(text, "\ufeff"), "\n") {
		line = strings.Trim(line, " \t\r")
		if line != "" && line != "..." && !strings.HasPrefix(line, "#") {
			return false
		}
	}
	return true
}

// loader converts a yaml.v3 node tree into the value model. Anchored nodes
// are converted once so aliases share the same *Map / []any, like js-yaml.
type loader struct {
	done map[*yaml.Node]any
	busy map[*yaml.Node]bool
}

func nodeErr(n *yaml.Node, format string, args ...any) error {
	return fmt.Errorf("yamljs: line %d, column %d: %s", n.Line, n.Column, fmt.Sprintf(format, args...))
}

// node converts n and returns the resolved tag too (the merge-key check needs
// it for mapping keys).
func (l *loader) node(n *yaml.Node) (any, string, error) {
	if n.Kind == yaml.AliasNode {
		if n.Alias == nil {
			return nil, "", nodeErr(n, "unidentified alias %q", n.Value)
		}
		if l.busy[n.Alias] {
			return nil, "", nodeErr(n, "recursive alias %q is not supported", n.Value)
		}
		if v, ok := l.done[n.Alias]; ok {
			return v, "", nil
		}
		v, _, err := l.node(n.Alias)
		return v, "", err
	}
	if n.Anchor != "" {
		l.busy[n] = true
		defer delete(l.busy, n)
	}
	var (
		v   any
		tag string
		err error
	)
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, tagNull, nil
		}
		return l.node(n.Content[0])
	case yaml.ScalarNode:
		v, tag, err = l.scalar(n)
	case yaml.MappingNode:
		v, tag, err = l.mapping(n)
	case yaml.SequenceNode:
		v, tag, err = l.sequence(n)
	default:
		return nil, "", nodeErr(n, "unexpected node kind %v", n.Kind)
	}
	if err == nil && n.Anchor != "" {
		l.done[n] = v
	}
	return v, tag, err
}

func tagged(n *yaml.Node) bool { return n.Style&yaml.TaggedStyle != 0 }

// scalar resolves a scalar node. Quoted and block scalars are strings, plain
// ones go through the implicit resolvers, explicit tags through their type.
func (l *loader) scalar(n *yaml.Node) (any, string, error) {
	quoted := n.Style&(yaml.SingleQuotedStyle|yaml.DoubleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) != 0
	empty := !quoted && n.Value == "" // js-yaml: no content → state.result === null
	if tagged(n) {
		return explicitScalar(n, empty)
	}
	if quoted {
		return n.Value, tagStr, nil
	}
	if empty {
		return nil, tagNull, nil
	}
	v, tag, err := resolveImplicit(n.Value)
	if err != nil {
		return nil, "", nodeErr(n, "%v", err)
	}
	return v, tag, nil
}

// explicitScalar applies an explicit !!tag to a scalar (resolve + construct).
// empty mirrors js-yaml's null data for a node with no content.
func explicitScalar(n *yaml.Node, empty bool) (any, string, error) {
	data := n.Value
	fail := func() (any, string, error) {
		return nil, "", nodeErr(n, "cannot resolve a node with !<%s> explicit tag", n.Tag)
	}
	switch n.Tag {
	case tagStr:
		return data, tagStr, nil // '' for an empty node too
	case tagNull:
		if empty || resolveNull(data) {
			return nil, tagNull, nil
		}
		return fail()
	case tagBool:
		if empty || !resolveBool(data) {
			return fail()
		}
		return constructBool(data), tagBool, nil
	case tagInt:
		if empty || !resolveInt(data) {
			return fail()
		}
		return parseInt(data), tagInt, nil
	case tagFloat:
		if empty || !resolveFloat(data) {
			return fail()
		}
		return constructFloat(data), tagFloat, nil
	case tagTimestamp:
		if empty || !resolveTimestamp(data) {
			return fail()
		}
		t, err := constructTimestamp(data)
		if err != nil {
			return fail()
		}
		return t, tagTimestamp, nil
	case tagMerge:
		if empty {
			return nil, tagMerge, nil
		}
		if data != "<<" {
			return fail()
		}
		return data, tagMerge, nil
	case tagMap, tagSeq:
		if !empty {
			return nil, "", nodeErr(n, "unacceptable node kind for !<%s> tag", n.Tag)
		}
		if n.Tag == tagMap {
			return NewMap(), tagMap, nil
		}
		return []any{}, tagSeq, nil
	}
	return nil, "", nodeErr(n, "unknown tag !<%s>", n.Tag)
}

// checkCollectionTag rejects explicit tags other than the collection's own.
func checkCollectionTag(n *yaml.Node, want string) error {
	if !tagged(n) || n.Tag == want {
		return nil
	}
	switch n.Tag {
	case tagStr, tagNull, tagBool, tagInt, tagFloat, tagTimestamp, tagMerge, tagMap, tagSeq:
		return nodeErr(n, "unacceptable node kind for !<%s> tag", n.Tag)
	}
	return nodeErr(n, "unknown tag !<%s>", n.Tag)
}

func (l *loader) sequence(n *yaml.Node) (any, string, error) {
	if err := checkCollectionTag(n, tagSeq); err != nil {
		return nil, "", err
	}
	out := make([]any, 0, len(n.Content))
	for _, c := range n.Content {
		v, _, err := l.node(c)
		if err != nil {
			return nil, "", err
		}
		out = append(out, v)
	}
	return out, tagSeq, nil
}

// mapping ports readBlockMapping/readFlowCollection + storeMappingPair:
// keys are String(key), duplicates are an error unless the earlier value came
// from a merge, and `<<` merges keys not already present.
func (l *loader) mapping(n *yaml.Node) (any, string, error) {
	if err := checkCollectionTag(n, tagMap); err != nil {
		return nil, "", err
	}
	m := NewMap()
	overridable := map[string]bool{}
	for i := 0; i+1 < len(n.Content); i += 2 {
		kn, vn := n.Content[i], n.Content[i+1]
		kv, ktag, err := l.node(kn)
		if err != nil {
			return nil, "", err
		}
		key, err := keyString(kv)
		if err != nil {
			return nil, "", nodeErr(kn, "%v", err)
		}
		val, _, err := l.node(vn)
		if err != nil {
			return nil, "", err
		}
		if ktag == tagMerge {
			if arr, ok := val.([]any); ok {
				for _, src := range arr {
					if err := mergeMappings(m, src, overridable); err != nil {
						return nil, "", nodeErr(vn, "%v", err)
					}
				}
			} else if err := mergeMappings(m, val, overridable); err != nil {
				return nil, "", nodeErr(vn, "%v", err)
			}
			continue
		}
		if !overridable[key] && m.Has(key) {
			return nil, "", nodeErr(kn, "duplicated mapping key %q", key)
		}
		m.Set(key, val)
		delete(overridable, key)
	}
	return m, tagMap, nil
}

// mergeMappings copies the own keys of source not already in dest.
func mergeMappings(dest *Map, source any, overridable map[string]bool) error {
	switch src := source.(type) {
	case *Map:
		for _, k := range src.Keys() {
			if !dest.Has(k) {
				dest.Set(k, src.vals[k])
				overridable[k] = true
			}
		}
	case []any: // an array is an object too: its index keys merge
		for i, v := range src {
			k := JSNumberString(float64(i))
			if !dest.Has(k) {
				dest.Set(k, v)
				overridable[k] = true
			}
		}
	case time.Time: // a Date has no own enumerable keys
	default:
		return errors.New("cannot merge mappings; the provided source object is unacceptable")
	}
	return nil
}

// keyString is storeMappingPair's String(keyNode): arrays join with ","
// (nested arrays rejected), objects become "[object Object]".
func keyString(v any) (string, error) {
	if arr, ok := v.([]any); ok {
		parts := make([]string, len(arr))
		for i, e := range arr {
			switch x := e.(type) {
			case []any:
				return "", errors.New("nested arrays are not supported inside keys")
			case nil, undefinedT:
				parts[i] = "" // Array#join renders null/undefined as ''
			default:
				parts[i] = jsString(x)
			}
		}
		return strings.Join(parts, ","), nil
	}
	return jsString(v), nil
}

// jsString is String(v) for the value model. Dates use Date#toString in UTC
// (Node's output depends on the process TZ; production runs in UTC).
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return JSNumberString(x)
	case string:
		return x
	case time.Time:
		return x.UTC().Format("Mon Jan 02 2006 15:04:05") + " GMT+0000 (Coordinated Universal Time)"
	case *Map:
		return "[object Object]"
	case []any:
		s, _ := keyString(x)
		return s
	}
	return fmt.Sprint(v)
}
