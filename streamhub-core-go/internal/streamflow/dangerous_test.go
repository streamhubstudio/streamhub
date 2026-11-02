package streamflow

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/audit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// C4 (3.3.3): execution boxes (code / shell / ssh / db) run ON THE HOST. A
// tenant must never be able to switch them on (the old per-app
// `dangerousNodes` plugin flag) nor save them: only the operator's
// STREAMHUB_STREAMFLOW_DANGEROUS allowlist + a superadmin caller.

const shellGraph = `{"boxes":[{"id":"m","type":"trigger.manual"},{"id":"s","type":"action.shell","config":{"command":"id"}}],"edges":[{"from":"m","to":"s"}]}`

var (
	superadmin = &auth.Principal{UserID: "admin", Role: auth.RoleSuperadmin, IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAdminJWT}
	tenantUser = &auth.Principal{UserID: "u1", TenantID: "t1", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT}
)

// routesAs serves the streamflow routes with p as the request principal.
func routesAs(w *world, p *auth.Principal) http.Handler {
	mux := http.NewServeMux()
	(&Routes{Svc: w.svc, Secrets: w.secrets}).Register(api.New(mux, "test"))
	h := httpx.WithRequest(mux)
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(rw, r.WithContext(auth.WithPrincipal(r.Context(), p)))
	})
}

func do(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(method, "/api/v1/apps/live/plugins/streamflow"+path, strings.NewReader(body))
	r.Header.Set("content-type", "application/json")
	h.ServeHTTP(rec, r)
	return rec
}

// The tenant-editable plugin flag no longer enables anything: a stored
// `dangerousNodes: true` (pre-3.3.3 install) neither unlocks the palette nor
// lets a run execute a shell box.
func TestDangerousPluginFlagIsInert(t *testing.T) {
	t.Setenv(DangerousEnv, "")
	w := newWorld(t)
	shell := 0
	w.runner.d.RunShell = func(context.Context, ShellInput) *y.Map { shell++; return obj("ok", true) }
	w.plugin.config = obj("dangerousNodes", true)
	if len(w.svc.Boxes(auth.WithPrincipal(bg, superadmin), "live")) != len(boxSpecs) {
		t.Fatal("tenant flag unlocked the execution palette")
	}
	wf := w.wf(t, shellGraph)
	run, err := w.svc.ManualRun(bg, "live", wf.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	w.runNow()
	if shell != 0 {
		t.Fatal("action.shell executed on the host with only the tenant flag set")
	}
	steps, _ := w.store.ListSteps(bg, "live", w.apps.AppDir("live"), run.ID)
	if len(steps) != 2 || steps[1].Status != "failed" || !strings.Contains(*steps[1].Error, DangerousEnv) {
		t.Fatalf("steps %+v", steps)
	}
}

func TestDangerousSaveNeedsOperatorFlag(t *testing.T) {
	t.Setenv(DangerousEnv, "other")
	w := newWorld(t)
	h := routesAs(w, superadmin)
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/workflows", `{"name":"x","graph":` + shellGraph + `}`},
		{"POST", "/workflows/import", `{"workflow":{"graph":` + shellGraph + `}}`},
	} {
		rec := do(h, c.method, c.path, c.body)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), DangerousEnv) {
			t.Errorf("%s %s without the operator flag: %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	// updating a harmless workflow to carry a shell box is refused too
	wf := w.wf(t, `{"boxes":[{"id":"m","type":"trigger.manual"}]}`)
	if rec := do(h, "PUT", "/workflows/"+wf.ID, `{"graph":`+shellGraph+`}`); rec.Code != 400 {
		t.Errorf("PUT graph: %d %s", rec.Code, rec.Body.String())
	}
	if got, _ := w.svc.GetWorkflow(bg, "live", wf.ID); strings.Contains(str(got.Graph), "action.shell") {
		t.Fatal("shell box persisted")
	}
}

func TestDangerousSaveNeedsSuperadmin(t *testing.T) {
	t.Setenv(DangerousEnv, "live")
	w := newWorld(t)
	tenant, admin := routesAs(w, tenantUser), routesAs(w, superadmin)
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/workflows", `{"name":"x","graph":` + shellGraph + `}`},
		{"POST", "/workflows/import", `{"workflow":{"graph":` + shellGraph + `}}`},
	} {
		if rec := do(tenant, c.method, c.path, c.body); rec.Code != 403 {
			t.Errorf("tenant %s %s: %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
		if rec := do(admin, c.method, c.path, c.body); rec.Code != 201 {
			t.Errorf("superadmin %s %s: %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	if len(w.svc.Boxes(auth.WithPrincipal(bg, superadmin), "live")) != len(boxSpecs)+len(dangerousSpecs) {
		t.Fatal("operator-enabled app hides the execution palette from a superadmin")
	}
	if len(w.svc.Boxes(auth.WithPrincipal(bg, tenantUser), "live")) != len(boxSpecs) {
		t.Fatal("execution palette shown to a non-superadmin")
	}
}

// Boot quarantine: workflows already holding execution boxes in an app the
// operator did not allow are disabled (idempotently, with a reason + audit).
func TestDangerousBootQuarantine(t *testing.T) {
	t.Setenv(DangerousEnv, "other")
	w := newWorld(t)
	aud := &recAudit{}
	w.svc.Audit = aud
	bad := w.wf(t, shellGraph)
	ok := w.wf(t, `{"boxes":[{"id":"m","type":"trigger.manual"}]}`)
	// an allowed app keeps its execution workflows
	otherWf, _ := w.store.CreateWorkflow(bg, "other", w.apps.AppDir("other"), "O", nil, js(t, shellGraph))
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	w.svc.Start(ctx, nil)
	got, _ := w.svc.GetWorkflow(bg, "live", bad.ID)
	if got.Enabled {
		t.Fatal("workflow with a shell box left enabled in a non-allowed app")
	}
	if got.DisabledReason == nil || !strings.Contains(*got.DisabledReason, "action.shell") || !strings.Contains(*got.DisabledReason, DangerousEnv) {
		t.Fatalf("reason %v", got.DisabledReason)
	}
	if got, _ := w.svc.GetWorkflow(bg, "live", ok.ID); !got.Enabled || got.DisabledReason != nil {
		t.Fatal("harmless workflow disabled")
	}
	if got, _ := w.svc.GetWorkflow(bg, "other", otherWf.ID); !got.Enabled {
		t.Fatal("allowed app's workflow quarantined")
	}
	if len(aud.events) != 1 || aud.events[0].Action != "streamflow.workflow_quarantined" || *aud.events[0].TargetID != "live/"+bad.ID {
		t.Fatalf("audit %+v", aud.events)
	}
	// idempotent: a second boot changes nothing and audits nothing
	if n := w.svc.QuarantineDangerous(bg); n != 0 || len(aud.events) != 1 {
		t.Fatalf("second pass n=%d events=%d", n, len(aud.events))
	}
	// the quarantined workflow cannot be switched back on (not allowed → 400)
	if rec := do(routesAs(w, superadmin), "POST", "/workflows/"+bad.ID+"/enable", `{"enabled":true}`); rec.Code != 400 {
		t.Fatalf("re-enable: %d %s", rec.Code, rec.Body.String())
	}
	// once the operator allows the app, a superadmin re-enables it and the reason clears
	t.Setenv(DangerousEnv, "*")
	if rec := do(routesAs(w, tenantUser), "POST", "/workflows/"+bad.ID+"/enable", `{"enabled":true}`); rec.Code != 403 {
		t.Fatalf("tenant re-enable: %d", rec.Code)
	}
	rec := do(routesAs(w, superadmin), "POST", "/workflows/"+bad.ID+"/enable", `{"enabled":true}`)
	if rec.Code != 201 || strings.Contains(rec.Body.String(), "disabledReason") {
		t.Fatalf("superadmin re-enable: %d %s", rec.Code, rec.Body.String())
	}
}

// Harmless edits stay open to tenants: only graphs with execution boxes are gated.
func TestDangerousGateLeavesPlainWorkflowsAlone(t *testing.T) {
	t.Setenv(DangerousEnv, "")
	w := newWorld(t)
	h := routesAs(w, tenantUser)
	if rec := do(h, "POST", "/workflows", `{"name":"x","graph":{"boxes":[{"id":"m","type":"trigger.manual"},{"id":"h","type":"action.http"}]}}`); rec.Code != 201 {
		t.Fatalf("plain create: %d %s", rec.Code, rec.Body.String())
	}
	if got := dangerousBoxTypes(js(t, `{"boxes":[{"type":"action.db"},{"type":"action.code"},{"type":"action.db"},{"type":5}]}`)); strings.Join(got, ",") != "action.code,action.db" {
		t.Fatalf("types %v", got)
	}
	// an app without a streamflow.db is skipped by the quarantine, not created
	if w.svc.QuarantineDangerous(bg); fileExists(w.store.FileFor(w.apps.AppDir("other"))) {
		t.Fatal("quarantine created a streamflow.db")
	}
	allowed := DangerousAllowed(" a , b ")
	if !allowed("a") || !allowed("b") || allowed("c") || allowed("") || DangerousAllowed("")("a") || !DangerousAllowed("*")("z") {
		t.Fatal("allowlist parse")
	}
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

type recAudit struct{ events []audit.Event }

func (r *recAudit) Record(_ context.Context, e audit.Event) { r.events = append(r.events, e) }
