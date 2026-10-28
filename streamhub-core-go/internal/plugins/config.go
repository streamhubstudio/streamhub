package plugins

import (
	"fmt"
	"math"
	"regexp"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of plugin-config.util.ts: validate + normalize a config object
// against a configSchema (unknown keys rejected, defaults filled, values
// coerced; `required` enforced only when enabling).

// ConfigError is PluginConfigError.
type ConfigError struct{ Msg, Field string }

func (e *ConfigError) Error() string { return e.Msg }

func cfgErr(field, format string, args ...any) *ConfigError {
	return &ConfigError{Msg: fmt.Sprintf(format, args...), Field: field}
}

func coerceField(f Field, raw any) (any, error) {
	switch f.Type {
	case "string", "secret":
		if _, ok := raw.(string); !ok {
			return nil, cfgErr(f.Key, "field '%s' must be a string", f.Key)
		}
		return raw, nil
	case "number":
		n := raw
		if s, ok := raw.(string); ok {
			n = y.StringToNumber(s)
		}
		v, ok := n.(float64)
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, cfgErr(f.Key, "field '%s' must be a number", f.Key)
		}
		if f.Min != nil && v < *f.Min {
			return nil, cfgErr(f.Key, "field '%s' must be >= %s", f.Key, y.JSNumberString(*f.Min))
		}
		if f.Max != nil && v > *f.Max {
			return nil, cfgErr(f.Key, "field '%s' must be <= %s", f.Key, y.JSNumberString(*f.Max))
		}
		return v, nil
	case "boolean":
		switch raw {
		case true, "true":
			return true, nil
		case false, "false":
			return false, nil
		}
		return nil, cfgErr(f.Key, "field '%s' must be a boolean", f.Key)
	case "select":
		if _, ok := raw.(string); !ok {
			return nil, cfgErr(f.Key, "field '%s' must be a string", f.Key)
		}
		for _, o := range f.Options {
			if o == raw {
				return raw, nil
			}
		}
		parts := make([]string, len(f.Options))
		for i, o := range f.Options {
			if !y.IsNullish(o) {
				parts[i] = y.ToString(o)
			}
		}
		return nil, cfgErr(f.Key, "field '%s' must be one of: %s", f.Key, strings.Join(parts, ", "))
	}
	return nil, &ConfigError{Msg: fmt.Sprintf("unknown field type '%s'", f.Type)}
}

func isEmptyValue(v any) bool { return v == nil || y.IsUndefined(v) || v == "" }

// ValidateConfig returns a NEW object holding exactly the schema keys
// (defaults filled, values coerced). input may be nil.
func ValidateConfig(meta *Meta, input *y.Map, requireRequired bool) (*y.Map, error) {
	if input == nil {
		input = y.NewMap()
	}
	keys := map[string]bool{}
	for _, f := range meta.Fields {
		keys[f.Key] = true
	}
	for _, k := range input.Keys() {
		if !keys[k] {
			return nil, cfgErr(k, "unknown config key '%s'", k)
		}
	}
	out := y.NewMap()
	for _, f := range meta.Fields {
		value, provided := input.Lookup(f.Key)
		if !provided || value == nil {
			value = f.Default
		}
		if value != nil && !y.IsUndefined(value) {
			v, err := coerceField(f, value)
			if err != nil {
				return nil, err
			}
			value = v
		}
		if requireRequired && f.Required && isEmptyValue(value) {
			return nil, cfgErr(f.Key, "field '%s' is required", f.Key)
		}
		out.Set(f.Key, value)
	}
	return out, nil
}

// DefaultConfig is the defaults-only config.
func DefaultConfig(meta *Meta) *y.Map {
	c, err := ValidateConfig(meta, nil, false)
	if err != nil {
		// A default that fails its own field type (only possible in a
		// malformed manifest) still yields the raw defaults.
		c = y.NewMap()
		for _, f := range meta.Fields {
			c.Set(f.Key, f.Default)
		}
	}
	return c
}

// RedactSecrets masks non-empty `secret` values.
func RedactSecrets(meta *Meta, config *y.Map) *y.Map {
	out := config.Clone()
	for _, f := range meta.Fields {
		if f.Type == "secret" && !isEmptyValue(out.Get(f.Key)) {
			out.Set(f.Key, "********")
		}
	}
	return out
}

var sensitiveKey = regexp.MustCompile(`(?i)secret|token|password|passwd|credential|api[_-]?key|apikey|access[_-]?key|private|callback|webhook`)

// SanitizePublicConfig keeps only schema fields safe to serve anonymously.
func SanitizePublicConfig(meta *Meta, config *y.Map) *y.Map {
	out := y.NewMap()
	for _, f := range meta.Fields {
		if f.Type == "secret" || sensitiveKey.MatchString(f.Key) {
			continue
		}
		if v, ok := config.Lookup(f.Key); ok {
			out.Set(f.Key, v)
		}
	}
	return out
}
