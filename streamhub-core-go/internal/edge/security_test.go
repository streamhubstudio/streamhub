package edge

import (
	"context"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/cluster"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// Security 3.3.4: an edge's assignment_status frame may only move its own
// assignments — a node (with the shared cluster token) can't fail, stop or
// fake "running" on another node's workload.
func TestAssignmentStatusOnlyFromOwningNode(t *testing.T) {
	ctx := context.Background()
	_, g, _ := testutil.Store(t)
	repo := NewRepo(g)
	gw := NewGateway(g, cluster.NewNodeAuth(g, func() string { return "tok" }, true, testutil.Log()), nil, repo, &Framer{}, testutil.Log())
	a, err := repo.Create(ctx, CreateInput{NodeID: "n1", App: "live", PluginID: "yolo", Status: StatusOffered})
	if err != nil {
		t.Fatal(err)
	}
	frame := func(status string) *Frame {
		return ParseFrame([]byte(`{"type":"assignment_status","id":"` + a.ID + `","status":"` + status + `","detail":"x"}`))
	}

	gw.onFrame(&conn{nodeID: "n2"}, frame(StatusFailed))
	if got, _ := repo.Get(ctx, a.ID); got.Status != StatusOffered || got.Detail != nil {
		t.Fatalf("foreign node moved the assignment: %+v", got)
	}
	gw.onFrame(&conn{nodeID: "n1"}, frame(StatusRunning))
	if got, _ := repo.Get(ctx, a.ID); got.Status != StatusRunning || got.Detail == nil || *got.Detail != "x" {
		t.Fatalf("owning node's status ignored: %+v", got)
	}
	if err := repo.UpdateStatusForNode(ctx, "ghost", "n1", StatusRunning, nil); err != nil {
		t.Fatal(err)
	}
}
