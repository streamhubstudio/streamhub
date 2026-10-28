// Package testutil holds helpers shared by package tests: a migrated
// DATA_DIR in a temp dir and a discard logger. Never imported by production code.
package testutil

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// Log discards everything.
func Log() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Store opens a fresh migrated DATA_DIR and returns the store, its global
// handle and the data dir; everything is closed at test cleanup.
func Store(t testing.TB) (*db.Service, *sql.DB, string) {
	t.Helper()
	dir := t.TempDir()
	s := db.New(dir, Log())
	g, err := s.Global(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, g, dir
}

// Exec runs statements or fails the test.
func Exec(t testing.TB, h *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := h.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}
