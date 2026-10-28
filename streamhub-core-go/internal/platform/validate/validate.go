// Package validate reproduces Nest's global ValidationPipe
// ({transform, whitelist}) over class-validator DTOs, so request-body 400s
// carry the exact same message list as the Node core.
//
// class-validator runs a property's decorators bottom-up, so a DTO declared
//
//	@IsString() @MinLength(1) @MaxLength(200) user!: string;
//
// is ported as Field("user").MaxLength(200).MinLength(1).IsString() — rules
// are written in the order Node reports them. Unknown properties are ignored
// (whitelist) and nothing is coerced (no implicit conversion).
package validate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Body is a decoded JSON request body plus the accumulated messages.
type Body struct {
	fields map[string]any
	errs   *[]string
	// prefix is the parent path of a nested DTO ("features."), prepended to
	// every message as Nest's flattenValidationErrors does.
	prefix string
}

// Parse decodes a JSON body. An empty body (or a non-object JSON value, which
// class-transformer does not map onto the DTO) validates as {}.
func Parse(raw []byte) (*Body, error) {
	b := &Body{fields: map[string]any{}, errs: new([]string)}
	if len(bytes.TrimSpace(raw)) == 0 {
		return b, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		// body-parser's message is V8's JSON.parse text, not reproducible.
		return nil, httpx.BadRequest("Unexpected token in JSON body")
	}
	if m, ok := v.(map[string]any); ok {
		b.fields = m
	}
	return b, nil
}

// MustParse is Parse for bodies built in tests.
func MustParse(raw string) *Body {
	b, err := Parse([]byte(raw))
	if err != nil {
		panic(err)
	}
	return b
}

// Err returns the ValidationPipe 400 when any rule failed, else nil.
func (b *Body) Err() error {
	if len(*b.errs) == 0 {
		return nil
	}
	return httpx.NestValidation(*b.errs)
}

// Messages are the failures so far (tests).
func (b *Body) Messages() []string { return *b.errs }

// Field starts the rules of a required property (null/absent still validated).
func (b *Body) Field(name string) *Rule {
	v, ok := b.fields[name]
	return &Rule{b: b, name: b.prefix + name, v: v, present: ok}
}

// Optional starts the rules of an @IsOptional() property: null or absent
// skips every rule.
func (b *Body) Optional(name string) *Rule {
	r := b.Field(name)
	r.skip = r.v == nil
	return r
}

// Has reports whether the property is present and not null.
func (b *Body) Has(name string) bool { return b.fields[name] != nil }

// String returns a string property ("" when absent or not a string).
func (b *Body) String(name string) string { s, _ := b.fields[name].(string); return s }

// StringPtr returns a string property or nil when absent/null.
func (b *Body) StringPtr(name string) *string {
	s, ok := b.fields[name].(string)
	if !ok {
		return nil
	}
	return &s
}

// Int returns an integer property or nil when absent/null.
func (b *Body) Int(name string) *int64 {
	f, ok := b.fields[name].(float64)
	if !ok {
		return nil
	}
	n := int64(f)
	return &n
}

// Bool returns a boolean property or nil when absent/null.
func (b *Body) Bool(name string) *bool {
	v, ok := b.fields[name].(bool)
	if !ok {
		return nil
	}
	return &v
}

// Strings returns a string-array property (nil when absent/null).
func (b *Body) Strings(name string) []string {
	arr, ok := b.fields[name].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		s, _ := e.(string)
		out = append(out, s)
	}
	return out
}

// Rule is the chain of checks for one property.
type Rule struct {
	b       *Body
	name    string
	v       any
	present bool
	skip    bool
}

func (r *Rule) check(ok bool, format string, args ...any) *Rule {
	if !r.skip && !ok {
		r.b.add(r.name + " " + fmt.Sprintf(format, args...))
	}
	return r
}

func (r *Rule) str() (string, bool) { s, ok := r.v.(string); return s, ok }

// length is validator.js isLength: code points minus variation selectors.
func length(s string) int {
	return utf8.RuneCountInString(s) - strings.Count(s, "️") - strings.Count(s, "︎")
}

// IsString — "must be a string".
func (r *Rule) IsString() *Rule {
	_, ok := r.str()
	return r.check(ok, "must be a string")
}

// MaxLength — "must be shorter than or equal to N characters".
func (r *Rule) MaxLength(n int) *Rule {
	s, ok := r.str()
	return r.check(ok && length(s) <= n, "must be shorter than or equal to %d characters", n)
}

// MinLength — "must be longer than or equal to N characters".
func (r *Rule) MinLength(n int) *Rule {
	s, ok := r.str()
	return r.check(ok && length(s) >= n, "must be longer than or equal to %d characters", n)
}

// Length(min, max) is class-validator @Length: valid only for a string of
// min..max code points (validator.js isLength); the message follows Length's
// defaultMessage, which reads the raw value's JS .length: a falsy value or a
// .length below min → "longer than or equal to min", a .length above max →
// "shorter than or equal to max", anything else (numbers, true, objects
// without a numeric length) → the combined form.
func (r *Rule) Length(min, max int) *Rule {
	if s, ok := r.str(); ok && length(s) >= min && length(s) <= max {
		return r
	}
	n, hasLen := jsLength(r.v)
	switch {
	case jsFalsy(r.v) || (hasLen && n < float64(min)):
		return r.check(false, "must be longer than or equal to %d characters", min)
	case hasLen && n > float64(max):
		return r.check(false, "must be shorter than or equal to %d characters", max)
	}
	return r.check(false, "must be longer than or equal to %d and shorter than or equal to %d characters", min, max)
}

// jsLength is value.length for a decoded JSON value (UTF-16 units for a
// string, elements for an array, a numeric "length" property of an object).
func jsLength(v any) (float64, bool) {
	switch t := v.(type) {
	case string:
		return float64(utf16Len(t)), true
	case []any:
		return float64(len(t)), true
	case map[string]any:
		f, ok := t["length"].(float64)
		return f, ok
	}
	return 0, false
}

// jsFalsy is !value for a decoded JSON value (absent = undefined).
func jsFalsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case string:
		return t == ""
	case float64:
		return t == 0 || math.IsNaN(t)
	}
	return false
}

// IsEmail — "must be an email" (validator.js isEmail, default options).
func (r *Rule) IsEmail() *Rule {
	s, ok := r.str()
	return r.check(ok && IsEmail(s), "must be an email")
}

// IsIn — "must be one of the following values: a, b".
func (r *Rule) IsIn(values ...string) *Rule {
	s, ok := r.str()
	in := false
	for _, v := range values {
		if ok && s == v {
			in = true
		}
	}
	return r.check(in, "must be one of the following values: %s", strings.Join(values, ", "))
}

func (r *Rule) num() (float64, bool) { f, ok := r.v.(float64); return f, ok }

// IsInt — "must be an integer number".
func (r *Rule) IsInt() *Rule {
	f, ok := r.num()
	return r.check(ok && f == math.Trunc(f) && !math.IsInf(f, 0), "must be an integer number")
}

// Min — "must not be less than N".
func (r *Rule) Min(n float64) *Rule {
	f, ok := r.num()
	return r.check(ok && f >= n, "must not be less than %s", jsNum(n))
}

// Max — "must not be greater than N".
func (r *Rule) Max(n float64) *Rule {
	f, ok := r.num()
	return r.check(ok && f <= n, "must not be greater than %s", jsNum(n))
}

// IsBoolean — "must be a boolean value".
func (r *Rule) IsBoolean() *Rule {
	_, ok := r.v.(bool)
	return r.check(ok, "must be a boolean value")
}

// IsArray — "must be an array".
func (r *Rule) IsArray() *Rule {
	_, ok := r.v.([]any)
	return r.check(ok, "must be an array")
}

// EachIsString is @IsString({ each: true }); a non-array value is checked
// itself, as class-validator does.
func (r *Rule) EachIsString() *Rule {
	ok := true
	if arr, isArr := r.v.([]any); isArr {
		for _, e := range arr {
			if _, s := e.(string); !s {
				ok = false
			}
		}
	} else {
		_, ok = r.str()
	}
	if !r.skip && !ok {
		r.b.add(r.b.prefix + "each value in " + r.name[len(r.b.prefix):] + " must be a string")
	}
	return r
}

// Matches is @Matches(re, { message }).
func (r *Rule) Matches(re *regexp.Regexp, message string) *Rule {
	s, ok := r.str()
	if !r.skip && !(ok && re.MatchString(s)) {
		r.b.add(r.b.prefix + message)
	}
	return r
}

func jsNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
