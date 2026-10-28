package streamflow

import (
	"math"
	"strings"
	"time"

	"github.com/dlclark/regexp2"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of boxes/expr.ts: SAFE typed condition / switch evaluation (no eval).
// A rule is {field, op, value}; rules combine with AND ('all') or OR ('any').

// evalRule evaluates one rule against the bag. Never panics.
func evalRule(rule *y.Map, bag any) bool {
	actual := getPath(bag, y.ToString(rule.Get("field")))
	expected := resolveValue(rule.Get("value"), bag)
	switch op, _ := rule.Get("op").(string); op {
	case "exists":
		return !y.IsNullish(actual)
	case "not_exists":
		return y.IsNullish(actual)
	case "truthy":
		return y.Truthy(actual)
	case "falsy":
		return !y.Truthy(actual)
	case "eq":
		return looseEq(actual, expected)
	case "ne":
		return !looseEq(actual, expected)
	case "gt", "gte", "lt", "lte":
		return numCompare(op, actual, expected)
	case "contains":
		return containsOp(actual, expected)
	case "not_contains":
		return !containsOp(actual, expected)
	case "matches":
		return matchesOp(actual, expected)
	}
	return false
}

// evalCondition: empty rules → true; match 'any' = OR, else AND.
func evalCondition(config any, bag any) bool {
	cfg := asObject(config)
	rules, _ := cfg.Get("rules").([]any)
	if len(rules) == 0 {
		return true
	}
	results := make([]bool, len(rules))
	for i, r := range rules {
		results[i] = evalRule(asObject(r), bag)
	}
	if cfg.Get("match") == "any" {
		for _, r := range results {
			if r {
				return true
			}
		}
		return false
	}
	for _, r := range results {
		if !r {
			return false
		}
	}
	return true
}

// evalSwitch picks the outgoing port of a switch box.
func evalSwitch(config *y.Map, bag any) string {
	actual := getPath(bag, y.ToString(config.Get("field")))
	cases, _ := config.Get("cases").([]any)
	for _, raw := range cases {
		c := asObject(raw)
		if looseEq(actual, resolveValue(c.Get("value"), bag)) {
			var port string
			if p := c.Get("port"); !y.IsNullish(p) {
				port = y.ToString(p)
			} else {
				port = y.ToString(y.Coalesce(c.Get("value"), ""))
			}
			if port = strings.TrimSpace(port); port != "" {
				return port
			}
			return "default"
		}
	}
	def := "default"
	if d := config.Get("default"); !y.IsNullish(d) {
		def = y.ToString(d)
	}
	if def = strings.TrimSpace(def); def != "" {
		return def
	}
	return "default"
}

// looseEq: strict equal, numeric equal, boolean by string, else String(a) ===
// String(b) (null/undefined never equal a non-null value).
func looseEq(a, b any) bool {
	if strictEq(a, b) {
		return true
	}
	an, aok := toNum(a)
	bn, bok := toNum(b)
	if aok && bok {
		return an == bn
	}
	_, ab := a.(bool)
	_, bb := b.(bool)
	if ab || bb {
		return y.ToString(a) == y.ToString(b)
	}
	if y.IsNullish(a) || y.IsNullish(b) {
		return false
	}
	return y.ToString(a) == y.ToString(b)
}

// strictEq is ===: primitives by value, objects by identity.
func strictEq(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case string, bool:
		return a == b
	case float64:
		f, ok := b.(float64)
		return ok && x == f
	case *y.Map:
		m, ok := b.(*y.Map)
		return ok && m == x
	case []any:
		s, ok := b.([]any)
		return ok && len(x) > 0 && len(s) == len(x) && &s[0] == &x[0]
	}
	return y.IsUndefined(a) && y.IsUndefined(b)
}

func toNum(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case string:
		if strings.TrimSpace(x) == "" {
			return 0, false
		}
		n := y.StringToNumber(x)
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	}
	return 0, false
}

func numCompare(op string, a, b any) bool {
	an, aok := toNum(a)
	bn, bok := toNum(b)
	if !aok || !bok {
		return false
	}
	switch op {
	case "gt":
		return an > bn
	case "gte":
		return an >= bn
	case "lt":
		return an < bn
	}
	return an <= bn
}

func containsOp(actual, expected any) bool {
	switch a := actual.(type) {
	case []any:
		for _, x := range a {
			if looseEq(x, expected) {
				return true
			}
		}
		return false
	case string:
		e := ""
		if !y.IsNullish(expected) {
			e = y.ToString(expected)
		}
		return strings.Contains(a, e)
	case *y.Map:
		return a != nil && a.Has(y.ToString(expected))
	}
	return false
}

// matchesOp is `new RegExp(p).test(String(actual ?? ”))` with ECMAScript
// semantics (regexp2), patterns bounded to 512 chars; a bad pattern is false.
func matchesOp(actual, pattern any) bool {
	p := ""
	if !y.IsNullish(pattern) {
		p = y.ToString(pattern)
	}
	if p == "" || len([]rune(p)) > 512 {
		return false
	}
	re, err := regexp2.Compile(p, regexp2.ECMAScript)
	if err != nil {
		return false
	}
	re.MatchTimeout = time.Second
	s := ""
	if !y.IsNullish(actual) {
		s = y.ToString(actual)
	}
	ok, err := re.MatchString(s)
	return err == nil && ok
}
