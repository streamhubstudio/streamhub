package validate

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// TestNestedVectors locks @ValidateNested message parity against Nest's
// ValidationPipe output (testdata/gen_nested.js).
func TestNestedVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/nested_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Body     json.RawMessage `json:"body"`
		Messages []string        `json:"messages"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	child := func(c *Body) {
		c.Field("name").MaxLength(3).IsString()
		c.Field("n").Min(1).IsInt()
	}
	for _, tc := range cases {
		b, err := Parse(tc.Body)
		if err != nil {
			t.Fatal(err)
		}
		b.NestedWith("items", true, func(r *Rule) {
			arr, ok := r.v.([]any)
			r.Check(ok && len(arr) <= 2, "items must contain no more than 2 elements").IsArray()
		}, child)
		b.Nested("obj", child)
		b.Nested("plain", child)
		b.Optional("flag").IsBoolean()
		got := b.Messages()
		if got == nil {
			got = []string{}
		}
		if !reflect.DeepEqual(got, tc.Messages) {
			t.Errorf("%s:\n go   %q\n node %q", tc.Body, got, tc.Messages)
		}
	}
}
