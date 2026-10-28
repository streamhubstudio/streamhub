package plugins

import (
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// builtin/builtins.json is hand-edited source (no generator since the Node
// core was retired): an invalid entry would only log and vanish at boot, so
// the catalog is checked here instead.
func TestBuiltinsCatalogIsValid(t *testing.T) {
	parsed, err := y.ParseJSON(builtinsJSON)
	if err != nil {
		t.Fatalf("builtins.json: %v", err)
	}
	list, ok := parsed.([]any)
	if !ok || len(list) == 0 {
		t.Fatal("builtins.json must be a non-empty array of metas")
	}
	reg := NewRegistry(Paths{}, func(string) string { return "" }, testutil.Log())
	prev := ""
	for i, raw := range list {
		m, _ := raw.(*y.Map)
		id, _ := prop(m, "id").(string)
		if msg := validateBuiltin(m, id); msg != "" {
			t.Errorf("entry %d (%q): %s", i, id, msg)
			continue
		}
		if id <= prev {
			t.Errorf("entry %d: %q not after %q — keep ids unique and sorted", i, id, prev)
		}
		prev = id
		w := m.Get("worker")
		if prop(m, "needsWorker") == true && !y.Truthy(w) {
			t.Errorf("%s: needsWorker without a worker block", id)
		}
		if y.Truthy(w) {
			key, isStr := prop(w, "spawn").(string)
			switch {
			case prop(m, "needsWorker") == true && !isStr:
				t.Errorf("%s: needsWorker but worker.spawn names no Go spawn func", id)
			case isStr && reg.builtinSpawn(key) == nil:
				t.Errorf("%s: worker.spawn %q has no Go func in builtinSpawn", id, key)
			}
		}
	}
}
