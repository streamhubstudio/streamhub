package db_test

import (
	"context"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

func TestSizes(t *testing.T) {
	ctx := context.Background()
	store, global, _ := testutil.Store(t)
	testutil.Exec(t, global, `INSERT INTO apps (name) VALUES ('a1'), ('a2')`)
	h, err := store.App(ctx, "a1")
	if err != nil {
		t.Fatal(err)
	}
	testutil.Exec(t, h, `INSERT INTO vods (app_id, name, status, size_bytes) VALUES (1, 'v1', 'ready', 100), (1, 'v2', 'ready', NULL), (1, 'v3', 'ready', 50)`)

	a := store.AppSizes(ctx, "a1")
	if a.App != "a1" || a.VodTotalBytes != 150 || a.VodCount != 3 || a.DBSizeBytes <= 0 {
		t.Errorf("app sizes = %+v", a)
	}
	s := store.ServerSizes(ctx)
	if len(s.Apps) != 2 || s.VodCount != 3 || s.VodTotalBytes != 150 || s.TotalDBSizeBytes != s.DBSizeBytes+s.AppsDBSizeBytes || s.DBSizeBytes <= 0 {
		t.Errorf("server sizes = %+v", s)
	}
	if empty := store.AppSizes(ctx, "a2"); empty.VodCount != 0 || empty.VodTotalBytes != 0 {
		t.Errorf("empty app = %+v", empty)
	}
}
