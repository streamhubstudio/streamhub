package quotas

import (
	"context"
	"encoding/json"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// Security 3.3.4 (M5): an app can hold at most N live (pending/offered/
// running) edge assignments; terminal rows and other apps don't count.
func TestEnforceAppEdgeAssignments(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	t.Setenv(authz.EnforceEnv, "on")
	t.Setenv(EdgeAssignmentsEnv, "2")
	for i, st := range []string{"pending", "running", "stopped", "revoked", "failed"} {
		testutil.Exec(t, s.db, `INSERT INTO edge_assignments (id, node_id, app, plugin_id, status) VALUES (?, 'n1', 'a1', 'yolo', ?)`, "x"+string(rune('a'+i)), st)
	}
	testutil.Exec(t, s.db, `INSERT INTO edge_assignments (id, node_id, app, plugin_id, status) VALUES ('o1', 'n1', 'a2', 'yolo', 'running')`)
	err := s.EnforceAppEdgeAssignments(ctx, "a1", owner)
	if status(err) != 429 {
		t.Fatalf("2 live assignments vs cap 2 must 429, got %v", err)
	}
	b, _ := json.Marshal(err.(*httpx.Error).Body)
	if string(b) != `{"error":"app_quota_exceeded","scope":"app","metric":"maxEdgeAssignments","limit":2,"used":2}` {
		t.Fatal(string(b))
	}
	if s.EnforceAppEdgeAssignments(ctx, "a2", owner) != nil {
		t.Fatal("another app's assignments counted")
	}
	if s.EnforceAppEdgeAssignments(ctx, "a1", &auth.Principal{IsSuperadmin: true, Scope: auth.ScopeGlobal, Via: auth.ViaAPIToken}) != nil {
		t.Fatal("a global credential is never capped")
	}
	t.Setenv(EdgeAssignmentsEnv, "0")
	if s.EnforceAppEdgeAssignments(ctx, "a1", owner) != nil {
		t.Fatal("0 = unlimited")
	}
	t.Setenv(EdgeAssignmentsEnv, "")
	if EdgeAssignmentsLimit() != DefaultEdgeAssignmentsPerApp {
		t.Fatal(EdgeAssignmentsLimit())
	}
}
