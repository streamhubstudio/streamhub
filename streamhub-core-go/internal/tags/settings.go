package tags

import y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"

// Port of settings-merge.ts: a stream's EFFECTIVE settings are a deep merge of
// model defaults → tag configs (in order) → per-stream overrides. Objects
// merge recursively, arrays and primitives replace, and the result is a deep
// clone (no input is shared into the output).

// cloneValue deep-clones a JSON-ish value (objects/arrays cloned).
func cloneValue(v any) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = cloneValue(e)
		}
		return out
	case *y.Map:
		if x == nil {
			return nil
		}
		out := y.NewMap()
		for _, k := range x.Keys() {
			out.Set(k, cloneValue(x.Get(k)))
		}
		return out
	}
	return v
}

// DeepMergeSettings merges over onto a clone of base without mutating either.
func DeepMergeSettings(base, over *y.Map) *y.Map {
	out := y.NewMap()
	if base != nil {
		for _, k := range base.Keys() {
			out.Set(k, cloneValue(base.Get(k)))
		}
	}
	if over == nil {
		return out
	}
	for _, k := range over.Keys() {
		v := over.Get(k)
		prev, _ := out.Get(k).(*y.Map)
		next, isMap := v.(*y.Map)
		if prev != nil && isMap && next != nil {
			out.Set(k, DeepMergeSettings(prev, next))
		} else {
			out.Set(k, cloneValue(v))
		}
	}
	return out
}

// ResolveStreamSettings merges defaults → tag configs → overrides. Non-object
// layers (nil) count as empty. Returns a fresh object every call.
func ResolveStreamSettings(modelDefaults *y.Map, tagConfigs []any, streamOverrides *y.Map) *y.Map {
	layers := []any{modelDefaults}
	layers = append(layers, tagConfigs...)
	layers = append(layers, streamOverrides)
	acc := y.NewMap()
	for _, l := range layers {
		m, _ := l.(*y.Map)
		acc = DeepMergeSettings(acc, m)
	}
	return acc
}
