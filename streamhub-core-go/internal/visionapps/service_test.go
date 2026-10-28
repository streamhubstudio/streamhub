package visionapps

import (
	"errors"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/edge"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// vendorFixtures are the vendored manifests of the 4 decoupled model-apps
// (the Node specs discover the same fixture stand-ins).
var vendorFixtures = filepath.Join("..", "plugins", "testdata", "vendor")

type svcStack struct {
	svc     *Service
	store   *Store
	repo    *plugins.Repo
	reg     *plugins.Registry
	assigns *fakeAssignments
	apps    *fakeApps
}

func newSvcStack(t *testing.T) *svcStack {
	t.Helper()
	dbs, global, dir := testutil.Store(t)
	st := &svcStack{store: NewStore(), repo: plugins.NewRepo(dbs), assigns: &fakeAssignments{}, apps: &fakeApps{dir: dir}}
	t.Cleanup(st.store.CloseAll)
	st.reg = plugins.NewRegistry(plugins.Paths{VendorRoot: vendorFixtures}, func(string) string { return "" }, testutil.Log())
	st.reg.Discover()
	st.svc = New(Deps{
		Store: st.store, Registry: st.reg, Installs: st.repo, DB: dbs, Global: global, Apps: st.apps,
		Assignments: func() Assignments { return st.assigns },
		Gateway:     func() Gateway { return fakeGateway{} },
	})
	return st
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func TestServiceUnknownModel404(t *testing.T) {
	st := newSvcStack(t)
	if _, err := st.svc.Overview(bg, app, "nope"); status(err) != http.StatusNotFound {
		t.Fatalf("got %v", err)
	}
	if _, err := st.svc.Overview(bg, "ghost", "occupancy"); status(err) != http.StatusNotFound {
		t.Fatalf("missing app: %v", err)
	}
}

func TestServiceSettingsResolve(t *testing.T) {
	st := newSvcStack(t)
	put, err := st.svc.PutSettings(bg, app, "occupancy", "gate", js(t, `{"zones":[{"id":"z1","tag":"","detect":"personas","points":[[0,0],[1,0],[1,1]]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if put.Model != "occupancy" || len(put.Resolved.Get("zones").([]any)) != 1 || put.UpdatedAt == nil {
		t.Fatalf("%+v", put)
	}
	got, err := st.svc.GetSettings(bg, app, "occupancy", "gate")
	if err != nil || len(got.Config.Get("zones").([]any)) != 1 {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := st.svc.PutSettings(bg, app, "occupancy", "gate", js(t, `{"zones":{}}`)); status(err) != http.StatusBadRequest {
		t.Fatalf("bad shape: %v", err)
	}
	empty, err := st.svc.GetSettings(bg, app, "counting", "gate")
	if err != nil || empty.UpdatedAt != nil || jstr(t, empty.Config) != "{}" {
		t.Fatalf("%+v %v", empty, err)
	}
	eqJSON(t, empty.Resolved, `{"lines":[],"fps":3.5}`)
}

func TestServiceOverview(t *testing.T) {
	st := newSvcStack(t)
	if err := st.repo.Install(bg, app, "occupancy", m(t, `{"device":"cpu"}`), true); err != nil {
		t.Fatal(err)
	}
	must[struct{}](t)(struct{}{}, st.store.RecordOccupancy(bg, app, st.apps.AppDir(app), "gate", "occupancy.session_started", m(t, `{"zone":"z1"}`)))
	st.assigns.list = []edge.Assignment{{PluginID: "occupancy", Status: "running"}, {PluginID: "counting", Status: "running"}, {PluginID: "occupancy", Status: "revoked"}}
	ov, err := st.svc.Overview(bg, app, "occupancy")
	if err != nil {
		t.Fatal(err)
	}
	if ov.Model != "occupancy" || !ov.Enabled || ov.Today != 1 || ov.Assignments != 1 || ov.ActiveStreams != 0 {
		t.Fatalf("%+v", ov)
	}
}

func TestServicePipelineVision(t *testing.T) {
	st := newSvcStack(t)
	_ = st.repo.Install(bg, app, "occupancy", m(t, `{}`), true)
	_ = st.repo.Install(bg, app, "counting", m(t, `{}`), false)
	st.assigns.list = []edge.Assignment{{PluginID: "occupancy", Status: "running"}, {PluginID: "occupancy", Status: "pending"}, {PluginID: "lpr", Status: "running"}}
	v, err := st.svc.PipelineVision(app)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.EnabledModels) != 1 || v.EnabledModels[0] != "occupancy" || v.Running != 1 || v.Pending != 1 {
		t.Fatalf("%+v", v)
	}
}
