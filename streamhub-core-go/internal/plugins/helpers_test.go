package plugins

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// fakeApps is a minimal contracts.AppsService over a fixed app set.
type fakeApps struct {
	dir  string
	apps map[string]int64
	tz   string
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	var out []contracts.AppRecord
	for n, id := range f.apps {
		out = append(out, contracts.AppRecord{ID: id, Name: n})
	}
	return out, nil
}

func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	id, ok := f.apps[name]
	if !ok {
		return nil, nil
	}
	return &contracts.AppRecord{ID: id, Name: name}, nil
}

func (f *fakeApps) Create(context.Context, contracts.CreateAppInput) (*contracts.AppRecord, error) {
	return nil, nil
}
func (f *fakeApps) Delete(context.Context, string, contracts.DeleteAppOptions) error { return nil }
func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return &contracts.AppConfig{Timezone: f.tz}, nil
}
func (f *fakeApps) UpdateConfig(context.Context, string, contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	return nil, nil
}
func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.dir, "apps", name) }

// recLogs records writes and answers queries from them.
type recLogs struct {
	mu   sync.Mutex
	rows []logs.Entry
}

func (r *recLogs) Write(level, source, message string, meta any, appID *int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, _ := stringifyJS(meta)
	r.rows = append([]logs.Entry{{ID: int64(len(r.rows) + 1), Level: level, Source: source, Message: message, AppID: appID, MetaJSON: &m}}, r.rows...)
}

func (r *recLogs) Query(_ context.Context, f logs.Filters) []logs.Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]logs.Entry(nil), r.rows...)
}

func (r *recLogs) messages() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for i := len(r.rows) - 1; i >= 0; i-- {
		out = append(out, r.rows[i].Message)
	}
	return out
}

// recDispatch records callback dispatches.
type recDispatch struct {
	mu     sync.Mutex
	events []string
	bodies []any
}

func (r *recDispatch) Dispatch(_ context.Context, app, event string, payload any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, app+":"+event)
	r.bodies = append(r.bodies, payload)
	return nil
}

func (r *recDispatch) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

// workerMeta builds a needsWorker plugin running `sh -c script`.
func shellMeta(id, script string, fields string) *Meta {
	schema := []any{}
	if fields != "" {
		v, err := y.ParseJSON([]byte(fields))
		if err != nil {
			panic(err)
		}
		schema = v.([]any)
	}
	v := "1.0.0"
	return &Meta{
		ID: id, Name: id, Description: "", Category: "processor", UI: "app-tab",
		ConfigSchema: schema, Fields: parseFields(schema), NeedsWorker: true, Version: &v,
		Events: []string{id + ".hit"},
		Worker: &WorkerDescriptor{Spawn: func(ctx WorkerContext) WorkerSpec {
			return WorkerSpec{Command: "/bin/sh", Args: []string{"-c", script}, Env: []EnvVar{{"PLUGIN_APP", ctx.App}, {"PLUGIN_TZ", ctx.AppTimezone}}}
		}},
	}
}

type stack struct {
	svc      *Service
	reg      *Registry
	repo     *Repo
	workers  *Manager
	logs     *recLogs
	dispatch *recDispatch
	apps     *fakeApps
	store    *db.Service
	dir      string
}

func newStack(t *testing.T, metas ...*Meta) *stack {
	t.Helper()
	store, _, dir := testutil.Store(t)
	st := &stack{store: store, dir: dir, logs: &recLogs{}, dispatch: &recDispatch{},
		apps: &fakeApps{dir: dir, apps: map[string]int64{"live": 1, "other": 2}, tz: "Europe/Madrid"}}
	st.reg = NewRegistry(Paths{VendorRoot: filepath.Join(dir, "no-vendor")}, func(string) string { return "" }, testutil.Log())
	for _, m := range metas {
		st.reg.Register(m)
	}
	st.repo = NewRepo(store)
	st.workers = NewManager(ManagerConfig{DataDir: dir, Port: 3020, Env: func(string) string { return "" }}, st.logs)
	st.workers.SetCallbacks(st.dispatch)
	st.svc = NewService(ServiceDeps{Registry: st.reg, Repo: st.repo, Workers: st.workers, Apps: st.apps,
		Logs: st.logs, LiveData: NewLiveData(), Callbacks: st.dispatch, Log: testutil.Log()})
	t.Cleanup(st.workers.Shutdown)
	return st
}

// eventually polls cond for up to 3s.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func bp(b bool) *bool { return &b }

// newTestServer starts an httptest server and returns its URL.
func newTestServer(t *testing.T, h http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}
