package httpx

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// TestParseURLEncodedVectors replays qs.parse outputs recorded from the Node
// core (testdata/gen_urlencoded.js).
func TestParseURLEncodedVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/urlencoded_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vecs []struct{ Input, JSON, Error string }
	if err := json.Unmarshal(raw, &vecs); err != nil {
		t.Fatal(err)
	}
	for _, v := range vecs {
		got, err := ParseURLEncoded(v.Input)
		if v.Error != "" {
			if err == nil {
				t.Errorf("%q: want error %s, got none", v.Input, v.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", v.Input, err)
			continue
		}
		s, _ := y.Stringify(got)
		if s != v.JSON {
			t.Errorf("%q:\n got %s\nwant %s", v.Input, s, v.JSON)
		}
	}
}

func TestParseURLEncodedTooMany(t *testing.T) {
	if _, err := ParseURLEncoded(strings.Repeat("a=1&", 1000) + "b=2"); err != errTooMany {
		t.Fatalf("want too many, got %v", err)
	}
}
