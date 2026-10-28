package db

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"testing"
)

func TestOpenFreshAndReopen(t *testing.T) {
	dir := t.TempDir()
	if out := os.Getenv("STREAMHUB_SCHEMA_DUMP_DIR"); out != "" {
		dir = out
	}
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for i := 0; i < 2; i++ { // second pass = idempotent reopen
		s := New(dir, log)
		g, err := s.Global(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var v int
		if err := g.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil || v != len(globalMigrations) {
			t.Fatalf("global user_version = %d, %v", v, err)
		}
		a, err := s.App(ctx, "live")
		if err != nil {
			t.Fatal(err)
		}
		if err := a.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil || v != len(appMigrations) {
			t.Fatalf("app user_version = %d, %v", v, err)
		}
		if ok, _ := HasColumn(ctx, g, "nodes", "weight"); !ok {
			t.Fatal("column add nodes.weight missing")
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAppNameTraversalRejected(t *testing.T) {
	s := New(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer s.Close()
	for _, n := range []string{"", "..", "a/b", `a\b`} {
		if _, err := s.App(context.Background(), n); err == nil {
			t.Fatalf("app name %q accepted", n)
		}
	}
}

// INVARIANT: conns released after a burst stay pooled (no reopen churn — the
// default of 2 idle conns collapsed the API under load, see db.go).
func TestIdleConnsStayPooled(t *testing.T) {
	ctx := context.Background()
	s := New(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer s.Close()
	g, err := s.Global(ctx)
	if err != nil {
		t.Fatal(err)
	}
	const n = 8
	conns := make([]*sql.Conn, n)
	for i := range conns {
		if conns[i], err = g.Conn(ctx); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range conns {
		c.Close()
	}
	if idle := g.Stats().Idle; idle != n {
		t.Fatalf("idle conns after burst = %d, want %d", idle, n)
	}
}
