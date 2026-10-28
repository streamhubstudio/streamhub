package jsx

import (
	"testing"
	"time"
)

func TestHelpers(t *testing.T) {
	if got := ISO(time.Date(2026, 1, 2, 3, 4, 5, 6e6, time.FixedZone("x", 3600))); got != "2026-01-02T02:04:05.006Z" {
		t.Fatal(got)
	}
	if s, _ := Stringify([]any{"a<b>&", nil, " "}); s != "[\"a<b>&\",null,\" \"]" {
		t.Fatalf("%q", s)
	}
	if EncodeURIComponent("a b@é/'()*!~") != "a%20b%40%C3%A9%2F'()*!~" {
		t.Fatal(EncodeURIComponent("a b@é/'()*!~"))
	}
	if UTF16Len("a😀") != 3 || UTF16Slice("ab😀c", 3) != "ab" {
		t.Fatal("utf16")
	}
	for _, s := range []string{"2026-10-27T12:00:00.000Z", "2026-10-27 12:00:00", "2026-10-27"} {
		if _, ok := ParseDate(s); !ok {
			t.Errorf("%s not parsed", s)
		}
	}
	if _, ok := ParseDate("nope"); ok {
		t.Fatal("garbage parsed")
	}
}
