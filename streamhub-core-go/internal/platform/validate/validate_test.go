package validate

import (
	"encoding/json"
	"os"
	"testing"
)

// Message parity with class-validator is locked by authn/dto_test.go
// against Node-generated vectors (testdata/class_validator.json).
func TestParse(t *testing.T) {
	for _, raw := range []string{"", "  ", "[1,2]", `"x"`, "{}"} {
		b, err := Parse([]byte(raw))
		if err != nil || len(b.fields) != 0 {
			t.Errorf("%q: %v %v", raw, b, err)
		}
	}
	if _, err := Parse([]byte("{nope")); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	b := MustParse(`{"a":null,"n":3,"s":"x","l":["a","b"],"t":true}`)
	b.Optional("a").IsString()
	b.Field("a").IsString()
	if len(b.Messages()) != 1 || b.Messages()[0] != "a must be a string" {
		t.Fatalf("optional null skipped, required null validated: %q", b.Messages())
	}
	if *b.Int("n") != 3 || b.String("s") != "x" || len(b.Strings("l")) != 2 || !*b.Bool("t") || b.StringPtr("a") != nil || !b.Has("s") || b.Has("a") {
		t.Fatal("getters")
	}
}

// @Length against Node vectors (testdata/gen_length.js → length_vectors.json).
func TestLengthVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/length_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vecs []struct {
		Min, Max int
		Optional bool
		Body     string
		Messages []string
	}
	if err := json.Unmarshal(raw, &vecs); err != nil {
		t.Fatal(err)
	}
	for _, v := range vecs {
		b := MustParse(v.Body)
		if v.Optional {
			b.Optional("v").Length(v.Min, v.Max)
		} else {
			b.Field("v").Length(v.Min, v.Max)
		}
		got := b.Messages()
		if len(got) != len(v.Messages) || (len(got) > 0 && got[0] != v.Messages[0]) {
			t.Errorf("Length(%d,%d) optional=%v %s: got %q want %q", v.Min, v.Max, v.Optional, v.Body, got, v.Messages)
		}
	}
}
