package quotas

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

func setup(t *testing.T) *Service {
	t.Helper()
	store, g, _ := testutil.Store(t)
	ctx := context.Background()
	ten := tenancy.New(g, "", testutil.Log())
	ten.Init(ctx)
	ten.EnsureTenant(ctx, "tnt_a", "A", "")
	testutil.Exec(t, g, `INSERT INTO apps (name, tenant_id) VALUES ('a1', 'tnt_a'), ('a2', 'tnt_a')`)
	return New(g, store.App, testutil.Log())
}

var owner = &auth.Principal{UserID: "u", TenantID: "tnt_a", Role: auth.RoleOwner, Scope: auth.ScopeUser, Via: auth.ViaUserJWT}

func status(err error) int {
	if e, ok := err.(*httpx.Error); ok {
		return e.Status
	}
	if err != nil {
		return 500
	}
	return 0
}

func addStreams(t *testing.T, s *Service, app string, active, ended int) {
	t.Helper()
	h, err := s.appDB(context.Background(), app)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < active+ended; i++ {
		st := "active"
		if i >= active {
			st = "ended"
		}
		testutil.Exec(t, h, `INSERT INTO streams (app_id, stream_id, type, status) VALUES (1, ?, 'webrtc', ?)`, app+string(rune('a'+i)), st)
	}
}

func TestEnforceCreateApp(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	t.Setenv(authz.EnforceEnv, "on")
	err := s.EnforceCreateApp(ctx, owner) // 2 apps vs free limit 2
	if status(err) != 429 {
		t.Fatalf("%v", err)
	}
	b, _ := json.Marshal(err.(*httpx.Error).Body)
	if string(b) != `{"error":"quota_exceeded","metric":"maxApps","limit":2,"used":2}` {
		t.Fatal(string(b))
	}
	t.Setenv(authz.EnforceEnv, "log")
	if s.EnforceCreateApp(ctx, owner) != nil {
		t.Fatal("log mode blocked")
	}
	t.Setenv(authz.EnforceEnv, "off")
	if s.EnforceCreateApp(ctx, owner) != nil {
		t.Fatal("off mode blocked")
	}
	t.Setenv(authz.EnforceEnv, "on")
	for _, p := range []*auth.Principal{
		nil,
		{IsSuperadmin: true, TenantID: "tnt_a"},
		{Via: auth.ViaAPIToken, Scope: auth.ScopeApp, TenantID: "tnt_a"},
		{Via: auth.ViaUserJWT, Role: auth.RoleOwner},
	} {
		if s.EnforceCreateApp(ctx, p) != nil {
			t.Errorf("bypass failed for %+v", p)
		}
	}
	m := int64(3)
	s.SetQuotas(ctx, "tnt_a", UpdateInput{MaxApps: &m})
	if s.EnforceCreateApp(ctx, owner) != nil {
		t.Fatal("under limit blocked")
	}
	unl := int64(-1)
	s.SetQuotas(ctx, "tnt_a", UpdateInput{MaxApps: &unl})
	if s.EnforceCreateApp(ctx, owner) != nil {
		t.Fatal("unlimited blocked")
	}
}

func TestConcurrentStreamsAndPresets(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	t.Setenv(authz.EnforceEnv, "on")
	addStreams(t, s, "a1", 1, 3)
	if s.EnforceConcurrentStreams(ctx, owner) != nil {
		t.Fatal("ended streams counted")
	}
	addStreams(t, s, "a2", 1, 0)
	if status(s.EnforceConcurrentStreams(ctx, owner)) != 429 {
		t.Fatal("2 active vs limit 2 must 429")
	}
	plan := "broadcaster"
	sum, _ := s.SetQuotas(ctx, "tnt_a", UpdateInput{Plan: &plan})
	if sum.Plan != "broadcaster" || sum.Quotas.MaxConcurrentStreams != -1 || sum.Quotas.MaxApps != 50 {
		t.Fatalf("%+v", sum)
	}
	if s.EnforceConcurrentStreams(ctx, owner) != nil {
		t.Fatal("broadcaster blocked")
	}
	five := int64(5)
	linear := "linear"
	if sum, _ = s.SetQuotas(ctx, "tnt_a", UpdateInput{Plan: &linear, MaxConcurrentStreams: &five}); sum.Quotas.MaxConcurrentStreams != 5 {
		t.Fatal("explicit override must win over the preset")
	}
	custom := "pro"
	if sum, _ = s.SetQuotas(ctx, "tnt_a", UpdateInput{Plan: &custom}); sum.Plan != "pro" || sum.Quotas.MaxConcurrentStreams != 5 || sum.Quotas.MaxApps != 50 {
		t.Fatalf("unknown plan must keep limits: %+v", sum)
	}
	if _, err := s.SetQuotas(ctx, "ghost", UpdateInput{}); status(err) != 404 || !strings.Contains(err.Error(), "tenant 'ghost' not found") {
		t.Fatal(err)
	}
}

func TestScopedQuotas(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	t.Setenv(authz.EnforceEnv, "on")
	addStreams(t, s, "a1", 3, 0)
	if s.EnforceAppConcurrentStreams(ctx, "a1", 0, owner) != nil || s.EnforceAppConcurrentStreams(ctx, "a1", -1, owner) != nil {
		t.Fatal("limit <= 0 is unlimited")
	}
	err := s.EnforceAppConcurrentStreams(ctx, "a1", 3, owner)
	b, _ := json.Marshal(err.(*httpx.Error).Body)
	if string(b) != `{"error":"app_quota_exceeded","scope":"app","metric":"maxConcurrentStreams","limit":3,"used":3}` {
		t.Fatal(string(b))
	}
	if s.EnforceAppConcurrentStreams(ctx, "a1", 4, owner) != nil {
		t.Fatal("under limit")
	}
	if s.EnforceAppConcurrentStreams(ctx, "a1", 3, &auth.Principal{IsSuperadmin: true}) != nil ||
		s.EnforceAppConcurrentStreams(ctx, "a1", 3, &auth.Principal{Via: auth.ViaAPIToken}) != nil {
		t.Fatal("bypass")
	}
	t.Setenv(authz.EnforceEnv, "log")
	if s.EnforceAppConcurrentStreams(ctx, "a1", 3, owner) != nil {
		t.Fatal("log mode")
	}
	t.Setenv(authz.EnforceEnv, "on")
	if status(s.EnforceStreamViewers(10, 10, owner)) != 429 || s.EnforceStreamViewers(0, 99, owner) != nil {
		t.Fatal("viewers")
	}
}

func TestUsageAndTenants(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	addStreams(t, s, "a1", 1, 0)
	u := s.GetUsage(ctx, "tnt_a")
	if u.Plan != "free" || u.Usage.Apps != 2 || u.Usage.ConcurrentStreams != 1 || !u.Exceeded.Apps || u.Exceeded.ConcurrentStreams {
		t.Fatalf("%+v", u)
	}
	if g := s.GetUsage(ctx, "ghost"); g.Quotas != defaultQuotas || g.Plan != "free" {
		t.Fatalf("unknown tenant defaults %+v", g)
	}
	list := s.ListTenants(ctx)
	if len(list) != 2 || list[0].ID != "platform" || list[1].AppCount != 2 {
		t.Fatalf("%+v", list)
	}
}

func TestParseUpdate(t *testing.T) {
	in, err := ParseUpdate(validate.MustParse(`{"plan":"pro","maxApps":-1}`))
	if err != nil || *in.Plan != "pro" || *in.MaxApps != -1 || in.MaxStorageGB != nil {
		t.Fatalf("%+v %v", in, err)
	}
	for _, bad := range []string{`{"maxApps":-2}`, `{"maxApps":1.5}`, `{"plan":5}`} {
		if _, err := ParseUpdate(validate.MustParse(bad)); status(err) != 400 {
			t.Errorf("%s accepted", bad)
		}
	}
}
