package validate

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

func (b *Body) add(msg string) { *b.errs = append(*b.errs, msg) }

// Raw returns a property's decoded JSON value (nil when absent/null).
func (b *Body) Raw(name string) any { return b.fields[name] }

// Float returns a numeric property or nil when absent/null/not a number.
func (b *Body) Float(name string) *float64 {
	f, ok := b.fields[name].(float64)
	if !ok {
		return nil
	}
	return &f
}

// Nested is @ValidateNested() on an @IsOptional() property: null/absent
// skips; an object is validated by fn with every message prefixed by
// "<name>."; array elements are validated as "<name>.<i>." (arrays nest
// recursively); a primitive element fails with "<container path>.nested
// property <name> must be either object or array" and a primitive value
// itself with "nested property <name> must be either object or array".
func (b *Body) Nested(name string, fn func(*Body)) { b.NestedWith(name, false, nil, fn) }

// NestedEach is @ValidateNested({ each: true }): the same walk, with
// class-validator's "each value in " message prefix.
func (b *Body) NestedEach(name string, fn func(*Body)) { b.NestedWith(name, true, nil, fn) }

// NestedWith is @ValidateNested({each}) plus the property's other decorators
// (own, written bottom-up like any Rule chain). As Nest's
// flattenValidationErrors does for an error with children, own's messages
// are dropped whenever an element / nested object failed; otherwise they
// come first and the primitive-value nested message last (class-validator
// runs nested validation after the property's constraints).
func (b *Body) NestedWith(name string, each bool, own func(*Rule), fn func(*Body)) {
	v := b.fields[name]
	if v == nil {
		return
	}
	msg := "nested property " + name + " must be either object or array"
	if each {
		msg = "each value in " + msg
	}
	var children []string
	var walk func(path string, v any)
	walk = func(path string, v any) {
		switch x := v.(type) {
		case map[string]any:
			fn(&Body{fields: x, errs: &children, prefix: path + "."})
		case []any:
			for i, e := range x {
				switch e.(type) {
				case map[string]any, []any:
					walk(path+"."+strconv.Itoa(i), e)
				default:
					children = append(children, path+"."+msg)
				}
			}
		}
	}
	walk(b.prefix+name, v)
	if len(children) > 0 {
		*b.errs = append(*b.errs, children...)
		return
	}
	if own != nil {
		own(b.Field(name))
	}
	switch v.(type) {
	case map[string]any, []any:
	default:
		b.add(b.prefix + msg)
	}
}

// Check adds message (prefixed by the nested path) when ok is false: a
// custom @Validate constraint whose defaultMessage is fixed text.
func (r *Rule) Check(ok bool, message string) *Rule {
	if !r.skip && !ok {
		r.b.add(r.b.prefix + message)
	}
	return r
}

// IsNumber — "must be a number conforming to the specified constraints".
func (r *Rule) IsNumber() *Rule {
	f, ok := r.num()
	return r.check(ok && !math.IsNaN(f) && !math.IsInf(f, 0), "must be a number conforming to the specified constraints")
}

// IsObject — "must be an object" (not null, not an array).
func (r *Rule) IsObject() *Rule {
	_, ok := r.v.(map[string]any)
	return r.check(ok, "must be an object")
}

// IsInNumbers is @IsIn([...numbers], { message? }): strict equality against
// numbers; message "" uses the default text.
func (r *Rule) IsInNumbers(values []float64, message string) *Rule {
	f, ok := r.num()
	in := false
	for _, v := range values {
		in = in || ok && f == v
	}
	if message != "" {
		return r.Check(in, message)
	}
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = jsNum(v)
	}
	return r.check(in, "must be one of the following values: %s", strings.Join(parts, ", "))
}

// EachMaxLength is @MaxLength(n, { each: true }); a non-array value is
// checked itself.
func (r *Rule) EachMaxLength(n int) *Rule {
	ok := true
	check := func(v any) bool { s, isStr := v.(string); return isStr && length(s) <= n }
	if arr, isArr := r.v.([]any); isArr {
		for _, e := range arr {
			ok = ok && check(e)
		}
	} else {
		ok = check(r.v)
	}
	if !r.skip && !ok {
		r.b.add(fmt.Sprintf("%seach value in %s must be shorter than or equal to %d characters", r.b.prefix, r.name[len(r.b.prefix):], n))
	}
	return r
}

// NotEmpty is @IsNotEmpty() — "should not be empty" (” / null / absent).
func (r *Rule) NotEmpty() *Rule {
	return r.check(r.v != nil && r.v != "", "should not be empty")
}

// ArrayMaxSize is @ArrayMaxSize(n) — "must contain no more than N elements".
func (r *Rule) ArrayMaxSize(n int) *Rule {
	arr, ok := r.v.([]any)
	return r.check(ok && len(arr) <= n, "must contain no more than %d elements", n)
}

// FromStrings builds a Body from text fields (a multipart form).
func FromStrings(fields map[string]string) *Body {
	b := &Body{fields: map[string]any{}, errs: new([]string)}
	for k, v := range fields {
		b.fields[k] = v
	}
	return b
}
