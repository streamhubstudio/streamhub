package transcription

import (
	"context"
	"database/sql"
	"strings"
	"sync"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
)

// Port of transcripts.repository.ts: per-app app.db `vod_transcripts`
// (created lazily, DDL verbatim).

const tableSQL = `
  CREATE TABLE IF NOT EXISTS vod_transcripts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    vod_id        INTEGER NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'queued',
    provider      TEXT,
    model         TEXT,
    language      TEXT,
    text          TEXT,
    segments_json TEXT,
    speakers_json TEXT,
    srt_key       TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`

// Record is a decoded vod_transcripts row.
type Record struct {
	ID           int64
	VodID        int64
	Status       string
	Provider     *string
	Model        *string
	Language     *string
	Text         *string
	SegmentsJSON *string
	SpeakersJSON *string
	SrtKey       *string
	Error        *string
	CreatedAt    string
	UpdatedAt    string
}

// Repo is TranscriptsRepository.
type Repo struct {
	store   *db.Service
	mu      sync.Mutex
	ensured map[string]bool
}

// NewRepo builds the repository.
func NewRepo(store *db.Service) *Repo { return &Repo{store: store, ensured: map[string]bool{}} }

func (r *Repo) handle(ctx context.Context, app string) (*sql.DB, error) {
	h, err := r.store.App(ctx, app)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.ensured[app] {
		if _, err := h.ExecContext(ctx, tableSQL); err != nil {
			return nil, err
		}
		r.ensured[app] = true
	}
	return h, nil
}

// Begin upserts the row back to `queued` with a clean slate.
func (r *Repo) Begin(ctx context.Context, app string, vodID int64, provider, model string) error {
	h, err := r.handle(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT INTO vod_transcripts (vod_id, status, provider, model)
           VALUES (?, 'queued', ?, ?)
         ON CONFLICT(vod_id) DO UPDATE SET
           status = 'queued',
           provider = excluded.provider,
           model = excluded.model,
           language = NULL,
           text = NULL,
           segments_json = NULL,
           speakers_json = NULL,
           srt_key = NULL,
           error = NULL,
           updated_at = datetime('now')`, vodID, provider, model)
	return err
}

// Patch writes the given columns (nil value = NULL) and bumps updated_at.
type Patch struct {
	cols []string
	vals []any
}

// Set adds column = value.
func (p *Patch) Set(col string, v any) *Patch {
	p.cols, p.vals = append(p.cols, col), append(p.vals, v)
	return p
}

// Apply runs a patch.
func (r *Repo) Apply(ctx context.Context, app string, vodID int64, p *Patch) error {
	if len(p.cols) == 0 {
		return nil
	}
	h, err := r.handle(ctx, app)
	if err != nil {
		return err
	}
	sets := make([]string, 0, len(p.cols)+1)
	for _, c := range p.cols {
		sets = append(sets, c+" = ?")
	}
	sets = append(sets, "updated_at = datetime('now')")
	_, err = h.ExecContext(ctx, `UPDATE vod_transcripts SET `+strings.Join(sets, ", ")+` WHERE vod_id = ?`, append(p.vals, vodID)...)
	return err
}

func ns(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

// GetByVod returns a VOD's row (nil when none).
func (r *Repo) GetByVod(ctx context.Context, app string, vodID int64) (*Record, error) {
	h, err := r.handle(ctx, app)
	if err != nil {
		return nil, err
	}
	var rec Record
	var provider, model, lang, text, segs, speakers, srt, errStr sql.NullString
	err = h.QueryRowContext(ctx, `SELECT id, vod_id, status, provider, model, language, text, segments_json, speakers_json, srt_key, error, created_at, updated_at
           FROM vod_transcripts WHERE vod_id = ?`, vodID).
		Scan(&rec.ID, &rec.VodID, &rec.Status, &provider, &model, &lang, &text, &segs, &speakers, &srt, &errStr, &rec.CreatedAt, &rec.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec.Provider, rec.Model, rec.Language, rec.Text = ns(provider), ns(model), ns(lang), ns(text)
	rec.SegmentsJSON, rec.SpeakersJSON, rec.SrtKey, rec.Error = ns(segs), ns(speakers), ns(srt), ns(errStr)
	return &rec, nil
}

// DeleteByVod removes a VOD's row.
func (r *Repo) DeleteByVod(ctx context.Context, app string, vodID int64) error {
	h, err := r.handle(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM vod_transcripts WHERE vod_id = ?`, vodID)
	return err
}
