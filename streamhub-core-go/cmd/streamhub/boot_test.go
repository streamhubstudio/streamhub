package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// TestBootWiresEveryPlane builds the complete handler exactly as main does:
// every registered plane, every module's routes. It catches provide/need
// mismatches and huma registration panics (duplicate schema names,
// conflicting routes) before they reach a real boot.
func TestBootWiresEveryPlane(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("NODE_ENV", "test")
	t.Setenv("STREAMHUB_SHADOW", "1") // no background work in a unit test
	t.Setenv("STREAMHUB_JWT_SECRET", "boot-test-secret")
	t.Setenv("LIVEKIT_URL", "")
	cfg := config.Load()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()

	store := db.New(cfg.DataDir, log)
	if err := store.Open(ctx); err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var h http.Handler
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("wiring panicked: %v", r)
			}
		}()
		var err error
		if h, err = buildHandler(ctx, cfg, log, store); err != nil {
			t.Fatal(err)
		}
	}()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("openapi.json: %d", rec.Code)
	}
	var spec struct {
		Paths map[string]map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	ops := 0
	for _, p := range spec.Paths {
		ops += len(p)
	}
	t.Logf("%d paths, %d operations registered", len(spec.Paths), ops)
	if ops < 100 {
		t.Fatalf("only %d operations registered — a plane failed to register?", ops)
	}
}
