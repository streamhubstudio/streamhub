package yamljs

import (
	"math"
	"testing"
)

func TestToNumber(t *testing.T) {
	cases := map[any]float64{
		nil: 0, true: 1, false: 0, 5.0: 5, "": 0, "  42 ": 42, "0x1A": 26, "0b101": 5, "0o17": 15,
		"1e3": 1000, ".5": 0.5, "5.": 5, "-Infinity": math.Inf(-1), "+7": 7,
	}
	for in, want := range cases {
		if got := ToNumber(in); got != want {
			t.Errorf("Number(%#v) = %v, want %v", in, got, want)
		}
	}
	for _, in := range []any{Undefined, "abc", "1_000", "-0x1", NewMap(), "0x"} {
		if got := ToNumber(in); !math.IsNaN(got) {
			t.Errorf("Number(%#v) = %v, want NaN", in, got)
		}
	}
	if ToNumber([]any{}) != 0 || ToNumber([]any{"7"}) != 7 || !math.IsNaN(ToNumber([]any{1.0, 2.0})) {
		t.Error("array coercion")
	}
}

func TestTruthyAndSpread(t *testing.T) {
	for _, v := range []any{nil, Undefined, false, 0.0, math.NaN(), ""} {
		if Truthy(v) {
			t.Errorf("%#v truthy", v)
		}
	}
	for _, v := range []any{true, 1.0, "0", []any{}, NewMap()} {
		if !Truthy(v) {
			t.Errorf("%#v falsy", v)
		}
	}
	if m := Spread("ab"); m.Get("0") != "a" || m.Get("1") != "b" {
		t.Error("string spread")
	}
	if m := Spread([]any{"x"}); m.Get("0") != "x" {
		t.Error("array spread")
	}
	if Spread(5.0).Len() != 0 || Spread(nil).Len() != 0 {
		t.Error("scalar spread")
	}
	src := NewMap()
	src.Set("a", 1.0)
	if c := Spread(src); c == src || c.Get("a") != 1.0 {
		t.Error("object spread is a copy")
	}
	if Coalesce(nil, 2.0) != 2.0 || Coalesce(Undefined, 2.0) != 2.0 || Coalesce(false, 2.0) != false {
		t.Error("??")
	}
	if ToString([]any{1.0, nil, "x"}) != "1,,x" || ToString(1e21) != "1e+21" {
		t.Error("String()")
	}
}
