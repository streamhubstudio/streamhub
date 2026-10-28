package visionapps

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/edge"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const app = "live"

var bg = context.Background()

// js parses a JSON literal into the JS value model.
func js(t *testing.T, s string) any {
	t.Helper()
	v, err := y.ParseJSON([]byte(s))
	if err != nil {
		t.Fatalf("bad json %s: %v", s, err)
	}
	return v
}

// str is JSON.stringify(v).
func jstr(t *testing.T, v any) string {
	t.Helper()
	s, err := y.Stringify(v)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// jstrNoT is JSON.stringify without a test handle ("" on error).
func jstrNoT(v any) string {
	s, _ := y.Stringify(v)
	return s
}

func eqJSON(t *testing.T, got any, want string) {
	t.Helper()
	if g, w := jstr(t, got), jstr(t, js(t, want)); g != w {
		t.Fatalf("got %s\nwant %s", g, w)
	}
}

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

// fakeApps is a contracts.AppsService over a fixed app set.
type fakeApps struct{ dir string }

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	return []contracts.AppRecord{{ID: 1, Name: app}}, nil
}
func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	if name != app {
		return nil, nil
	}
	return &contracts.AppRecord{ID: 1, Name: app}, nil
}
func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return &contracts.AppConfig{}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.dir, "apps", name) }

type fakeAssignments struct{ list []edge.Assignment }

func (f *fakeAssignments) List(context.Context, string) ([]edge.Assignment, error) {
	return f.list, nil
}

type fakeGateway struct{}

func (fakeGateway) IsConnected(string) bool { return false }

// recLogs records LogWriter writes.
type recLogs struct {
	mu   sync.Mutex
	msgs []string
}

func (r *recLogs) Write(_, _, message string, _ any, _ *int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, message)
}
