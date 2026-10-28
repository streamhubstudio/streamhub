package yamljs

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"
)

func TestMapJSOrder(t *testing.T) {
	m := NewMap()
	for _, k := range []string{"b", "10", "a", "2", "01", "0", "-1", "4294967294", "4294967295", "1.5", ""} {
		m.Set(k, k)
	}
	want := []string{"0", "2", "10", "4294967294", "b", "a", "01", "-1", "4294967295", "1.5", ""}
	if got := m.Keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Keys() = %q, want %q", got, want)
	}
	if m.Len() != len(want) {
		t.Errorf("Len = %d", m.Len())
	}
}

func TestMapSetKeepsPositionDeleteRemoves(t *testing.T) {
	m := NewMap()
	m.Set("x", 1.0)
	m.Set("y", 2.0)
	m.Set("x", 3.0)
	if got := m.Keys(); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Fatalf("Keys = %q", got)
	}
	if m.Get("x") != 3.0 {
		t.Errorf("x = %v", m.Get("x"))
	}
	m.Delete("x")
	m.Delete("nope")
	m.Set("x", 4.0) // re-added → goes to the end
	if got := m.Keys(); !reflect.DeepEqual(got, []string{"y", "x"}) {
		t.Fatalf("Keys after delete/re-add = %q", got)
	}
}

func TestUndefinedSemantics(t *testing.T) {
	m := NewMap()
	if !IsUndefined(m.Get("missing")) || m.Has("missing") {
		t.Fatal("missing key must read as Undefined and not be present")
	}
	if _, ok := m.Lookup("missing"); ok {
		t.Fatal("Lookup of missing key")
	}
	m.Set("u", Undefined) // { u: undefined } has the key
	if !m.Has("u") || m.Len() != 1 {
		t.Fatal("explicit undefined value keeps its key")
	}
	if IsUndefined(nil) {
		t.Fatal("null is not undefined")
	}
}

func TestCloneAndDeepClone(t *testing.T) {
	inner := NewMap()
	inner.Set("k", 1.0)
	m := NewMap()
	m.Set("in", inner)
	m.Set("arr", []any{inner, "s"})

	shallow := m.Clone()
	shallow.Set("new", true)
	if m.Has("new") || shallow.Get("in").(*Map) != inner {
		t.Fatal("Clone must copy the key set only")
	}

	deep := DeepClone(m).(*Map)
	deep.Get("in").(*Map).Set("k", 2.0)
	deep.Get("arr").([]any)[1] = "changed"
	if inner.Get("k") != 1.0 || m.Get("arr").([]any)[1] != "s" {
		t.Fatal("DeepClone must not share nested containers")
	}
	if !reflect.DeepEqual(deep.Keys(), m.Keys()) {
		t.Fatal("DeepClone keeps key order")
	}
}

func TestMapJSON(t *testing.T) {
	m := NewMap()
	m.Set("z", "a<b>& \"\n\x01")
	m.Set("1", math.NaN())
	m.Set("u", Undefined)
	m.Set("neg", math.Copysign(0, -1))
	m.Set("big", 1e21)
	m.Set("d", time.Date(2020, 1, 2, 3, 4, 5, 6e6, time.UTC))
	m.Set("arr", []any{Undefined, math.Inf(1), nil, true})
	m.Set("o", NewMap())
	got, err := Stringify(m)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"1":null,"z":"a<b>&` + " " + `\"\n\u0001","neg":0,"big":1e+21,"d":"2020-01-02T03:04:05.006Z","arr":[null,null,null,true],"o":{}}`
	if got != want {
		t.Fatalf("Stringify\n got %s\nwant %s", got, want)
	}

	// Round trip through encoding/json keeps the JS order.
	var back Map
	if err := json.Unmarshal([]byte(`{"b":1,"2":[1,{"x":null}],"a":"s"}`), &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back.Keys(), []string{"2", "b", "a"}) {
		t.Fatalf("Unmarshal keys = %q", back.Keys())
	}
	out, err := json.Marshal(&back)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"2":[1,{"x":null}],"b":1,"a":"s"}` {
		t.Fatalf("Marshal = %s", out)
	}
}
