package transcription

import (
	"context"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// Port of transcripts.repository.spec.ts.

func newRepo(t *testing.T) *Repo {
	t.Helper()
	store, _, _ := testutil.Store(t)
	return NewRepo(store)
}

func is(p *string, want string) bool { return p != nil && *p == want }

func TestRepoBeginQueued(t *testing.T) {
	r, ctx := newRepo(t), context.Background()
	if err := r.Begin(ctx, "live", 7, "local", "small"); err != nil {
		t.Fatal(err)
	}
	row, err := r.GetByVod(ctx, "live", 7)
	if err != nil || row == nil {
		t.Fatal(row, err)
	}
	if row.VodID != 7 || row.Status != "queued" || !is(row.Provider, "local") || !is(row.Model, "small") ||
		row.Text != nil || row.SrtKey != nil || row.Error != nil || row.CreatedAt == "" {
		t.Fatalf("%+v", row)
	}
	if row, _ := r.GetByVod(ctx, "live", 999); row != nil {
		t.Fatal("never transcribed → nil")
	}
}

func TestRepoPatch(t *testing.T) {
	r, ctx := newRepo(t), context.Background()
	_ = r.Begin(ctx, "live", 7, "local", "small")
	if err := r.Apply(ctx, "live", 7, (&Patch{}).Set("status", "ready").Set("language", "es").Set("text", "[alice] hola").
		Set("segments_json", `[{"start":0,"end":1,"text":"hola","speaker":"alice"}]`).Set("speakers_json", `["alice"]`).Set("srt_key", "rec.srt")); err != nil {
		t.Fatal(err)
	}
	row, _ := r.GetByVod(ctx, "live", 7)
	if row.Status != "ready" || !is(row.Language, "es") || !is(row.Text, "[alice] hola") || !is(row.SrtKey, "rec.srt") ||
		!is(row.Provider, "local") || row.Error != nil {
		t.Fatalf("%+v", row)
	}
}

func TestRepoBeginResets(t *testing.T) {
	r, ctx := newRepo(t), context.Background()
	_ = r.Begin(ctx, "live", 7, "local", "small")
	_ = r.Apply(ctx, "live", 7, (&Patch{}).Set("status", "failed").Set("error", "boom").Set("text", "partial").Set("srt_key", "old.srt"))
	_ = r.Begin(ctx, "live", 7, "openai", "whisper-1")
	row, _ := r.GetByVod(ctx, "live", 7)
	if row.Status != "queued" || !is(row.Provider, "openai") || !is(row.Model, "whisper-1") || row.Text != nil || row.SrtKey != nil || row.Error != nil {
		t.Fatalf("%+v", row)
	}
	_ = r.Begin(ctx, "live", 7, "local", "tiny")
	if row, _ := r.GetByVod(ctx, "live", 7); !is(row.Provider, "local") {
		t.Fatalf("%+v", row)
	}
}

func TestRepoIsolationAndDelete(t *testing.T) {
	r, ctx := newRepo(t), context.Background()
	_ = r.Begin(ctx, "live", 7, "local", "small")
	if row, _ := r.GetByVod(ctx, "other-app", 7); row != nil {
		t.Fatal("rows are per app db")
	}
	_ = r.DeleteByVod(ctx, "live", 7)
	if row, _ := r.GetByVod(ctx, "live", 7); row != nil {
		t.Fatal("deleted")
	}
}
