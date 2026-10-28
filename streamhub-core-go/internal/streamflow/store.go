package streamflow

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite" // the "sqlite" database/sql driver

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of streamflow.store.ts: the per-app apps/<app>/streamflow/streamflow.db
// (its own SQLite file, NOT app.db), opened lazily and cached per app.

const retentionDaysDefault = 30

// migration is the Node MIGRATION DDL, verbatim.
const migration = `
CREATE TABLE IF NOT EXISTS workflows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  graph_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  trigger_event TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued',
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_wf ON runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  box_id      TEXT NOT NULL,
  box_type    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',
  input_json  TEXT,
  output_json TEXT,
  ms          INTEGER,
  error       TEXT,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id, seq);
CREATE TABLE IF NOT EXISTS ai_usage (
  month    TEXT PRIMARY KEY,
  tokens   INTEGER NOT NULL DEFAULT 0,
  est_usd  REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets (
  name        TEXT PRIMARY KEY,
  value_enc   TEXT NOT NULL,
  last4       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`

// Workflow is a workflows row (graph decoded in JS key order).
type Workflow = StreamflowWorkflow

// StreamflowWorkflow is the wire type (module-prefixed schema name).
type StreamflowWorkflow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Enabled   bool   `json:"enabled"`
	Graph     any    `json:"graph"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// Run is a runs row.
type Run = StreamflowRun

// StreamflowRun is the wire type (module-prefixed schema name).
type StreamflowRun struct {
	ID           string  `json:"id"`
	WorkflowID   string  `json:"workflowId"`
	TriggerEvent string  `json:"triggerEvent"`
	Status       string  `json:"status"`
	StartedAt    string  `json:"startedAt"`
	EndedAt      *string `json:"endedAt"`
	Error        *string `json:"error"`
}

// Step is a run_steps row.
type Step = StreamflowStep

// StreamflowStep is the wire type (module-prefixed schema name).
type StreamflowStep struct {
	ID      string   `json:"id"`
	RunID   string   `json:"runId"`
	BoxID   string   `json:"boxId"`
	BoxType string   `json:"boxType"`
	Status  string   `json:"status"`
	Input   any      `json:"input"`
	Output  any      `json:"output"`
	Ms      *float64 `json:"ms"`
	Error   *string  `json:"error"`
}

// StepRecord is recordStep's input (Input/Output Undefined = NULL column).
type StepRecord struct {
	RunID, BoxID, BoxType, Status string
	Input, Output                 any
	Ms                            *float64
	Error                         *string
	Seq                           int
}

// SecretMeta is the masked metadata of a stored secret (never the value).
type SecretMeta = StreamflowSecretMeta

// StreamflowSecretMeta is the wire type (module-prefixed schema name).
type StreamflowSecretMeta struct {
	Name      string `json:"name"`
	Last4     string `json:"last4"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// Store is StreamflowStore.
type Store struct {
	mu  sync.Mutex
	dbs map[string]*sql.DB
	// FileFor resolves the db path (test seam).
	FileFor func(appDir string) string
}

// NewStore builds the store.
func NewStore() *Store {
	return &Store{dbs: map[string]*sql.DB{}, FileFor: func(appDir string) string {
		return filepath.Join(appDir, "streamflow", "streamflow.db")
	}}
}

// DB opens (create + migrate) and caches the per-app streamflow.db.
func (s *Store) DB(ctx context.Context, app, appDir string) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h, ok := s.dbs[app]; ok {
		return h, nil
	}
	file := s.FileFor(appDir)
	if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	h, err := sql.Open("sqlite", "file:"+file+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	if _, err := h.ExecContext(ctx, migration); err != nil {
		h.Close()
		return nil, err
	}
	s.dbs[app] = h
	return h, nil
}

// Close drops a cached handle (app deleted / plugin disabled).
func (s *Store) Close(app string) {
	s.mu.Lock()
	h := s.dbs[app]
	delete(s.dbs, app)
	s.mu.Unlock()
	if h != nil {
		_ = h.Close()
	}
}

// CloseAll closes every handle (onModuleDestroy).
func (s *Store) CloseAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for app, h := range s.dbs {
		_ = h.Close()
		delete(s.dbs, app)
	}
}

func emptyGraph() *y.Map { return obj("boxes", []any{}, "edges", []any{}) }

// parseJSON is the store's parseJson (null on NULL / invalid).
func parseJSON(s sql.NullString) any {
	if !s.Valid {
		return nil
	}
	v, err := y.ParseJSON([]byte(s.String))
	if err != nil {
		return nil
	}
	return v
}

// safeJSON is JSON.stringify that never fails (→ 'null').
func safeJSON(v any) string {
	if y.IsUndefined(v) {
		return "null"
	}
	return jsonString(v)
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

const workflowCols = `id, name, enabled, graph_json, created_at, updated_at`

func scanWorkflow(row interface{ Scan(...any) error }) (*Workflow, error) {
	var w Workflow
	var enabled int64
	var graph sql.NullString
	if err := row.Scan(&w.ID, &w.Name, &enabled, &graph, &w.CreatedAt, &w.UpdatedAt); err != nil {
		return nil, err
	}
	w.Enabled = enabled == 1
	w.Graph = parseJSON(graph)
	if y.IsNullish(w.Graph) {
		w.Graph = emptyGraph()
	}
	return &w, nil
}

// CreateWorkflow inserts a workflow (graph nil = empty graph).
func (s *Store) CreateWorkflow(ctx context.Context, app, appDir, name string, enabled *bool, graph any) (*Workflow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	id := uuid.NewString()
	en := 1
	if enabled != nil && !*enabled {
		en = 0
	}
	if y.IsNullish(graph) {
		graph = emptyGraph()
	}
	if _, err := h.ExecContext(ctx, `INSERT INTO workflows (id, name, enabled, graph_json)
           VALUES (?, ?, ?, ?)`, id, name, en, jsonString(graph)); err != nil {
		return nil, err
	}
	return s.GetWorkflow(ctx, app, appDir, id)
}

func (s *Store) listWorkflows(ctx context.Context, app, appDir, where string) ([]Workflow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT `+workflowCols+`
           FROM workflows `+where+`ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Workflow{}
	for rows.Next() {
		w, err := scanWorkflow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *w)
	}
	return out, rows.Err()
}

// ListWorkflows returns every workflow, oldest first.
func (s *Store) ListWorkflows(ctx context.Context, app, appDir string) ([]Workflow, error) {
	return s.listWorkflows(ctx, app, appDir, "")
}

// ListEnabled returns the enabled workflows (trigger matching hot path).
func (s *Store) ListEnabled(ctx context.Context, app, appDir string) ([]Workflow, error) {
	return s.listWorkflows(ctx, app, appDir, "WHERE enabled = 1 ")
}

// GetWorkflow returns one workflow (nil when absent).
func (s *Store) GetWorkflow(ctx context.Context, app, appDir, id string) (*Workflow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	w, err := scanWorkflow(h.QueryRowContext(ctx, `SELECT `+workflowCols+`
           FROM workflows WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return w, err
}

// WorkflowPatch: Has* false = `undefined` (untouched); a present value may
// be any JS value, null included (String(null) / JSON 'null').
type WorkflowPatch struct {
	Name, Enabled, Graph          any
	HasName, HasEnabled, HasGraph bool
}

// UpdateWorkflow applies a patch (updated_at bumps only when something is set).
func (s *Store) UpdateWorkflow(ctx context.Context, app, appDir, id string, p WorkflowPatch) (*Workflow, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	var sets []string
	var params []any
	if p.HasName {
		sets = append(sets, "name = ?")
		params = append(params, y.ToString(p.Name))
	}
	if p.HasEnabled {
		sets = append(sets, "enabled = ?")
		v := 0
		if y.Truthy(p.Enabled) {
			v = 1
		}
		params = append(params, v)
	}
	if p.HasGraph {
		sets = append(sets, "graph_json = ?")
		params = append(params, safeJSON(p.Graph))
	}
	if len(sets) > 0 {
		sets = append(sets, "updated_at = datetime('now')")
		params = append(params, id)
		if _, err := h.ExecContext(ctx, `UPDATE workflows SET `+strings.Join(sets, ", ")+` WHERE id = ?`, params...); err != nil {
			return nil, err
		}
	}
	return s.GetWorkflow(ctx, app, appDir, id)
}

// DeleteWorkflow removes a workflow and cascades its run history.
func (s *Store) DeleteWorkflow(ctx context.Context, app, appDir, id string) (bool, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return false, err
	}
	res, err := h.ExecContext(ctx, `DELETE FROM workflows WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	if _, err := h.ExecContext(ctx, `DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?)`, id); err != nil {
		return false, err
	}
	if _, err := h.ExecContext(ctx, `DELETE FROM runs WHERE workflow_id = ?`, id); err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---------------------------------------------------------------------------
// Runs + steps
// ---------------------------------------------------------------------------

const runCols = `id, workflow_id, trigger_event, status, started_at, ended_at, error`

func scanRun(row interface{ Scan(...any) error }) (*Run, error) {
	var r Run
	var ended, errS sql.NullString
	if err := row.Scan(&r.ID, &r.WorkflowID, &r.TriggerEvent, &r.Status, &r.StartedAt, &ended, &errS); err != nil {
		return nil, err
	}
	switch r.Status {
	case "running", "ok", "failed":
	default:
		r.Status = "queued"
	}
	if ended.Valid {
		r.EndedAt = &ended.String
	}
	if errS.Valid {
		r.Error = &errS.String
	}
	return &r, nil
}

// CreateRun inserts a run row (status default queued).
func (s *Store) CreateRun(ctx context.Context, app, appDir, workflowID, triggerEvent, status string) (*Run, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	if status == "" {
		status = "queued"
	}
	id := uuid.NewString()
	if _, err := h.ExecContext(ctx, `INSERT INTO runs (id, workflow_id, trigger_event, status)
           VALUES (?, ?, ?, ?)`, id, workflowID, triggerEvent, status); err != nil {
		return nil, err
	}
	return s.GetRun(ctx, app, appDir, id)
}

// FinishRun sets the final status, ended_at and error.
func (s *Store) FinishRun(ctx context.Context, app, appDir, id, status string, errMsg *string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE runs SET status = ?, ended_at = datetime('now'), error = ?
           WHERE id = ?`, status, errMsg, id)
	return err
}

// SetRunStatus updates the status only.
func (s *Store) SetRunStatus(ctx context.Context, app, appDir, id, status string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE runs SET status = ? WHERE id = ?`, status, id)
	return err
}

// GetRun returns one run (nil when absent).
func (s *Store) GetRun(ctx context.Context, app, appDir, id string) (*Run, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	r, err := scanRun(h.QueryRowContext(ctx, `SELECT `+runCols+`
           FROM runs WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return r, err
}

// ListRuns lists runs newest first; limit nil = 50, clamped to [1, 500].
func (s *Store) ListRuns(ctx context.Context, app, appDir, workflowID string, limit *float64) ([]Run, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	lim := 50.0
	if limit != nil {
		lim = *limit
	}
	lim = math.Max(1, math.Min(500, lim))
	where, params := "", []any{}
	if workflowID != "" {
		where, params = "WHERE workflow_id = ? ", append(params, workflowID)
	}
	params = append(params, int64(lim))
	rows, err := h.QueryContext(ctx, `SELECT `+runCols+`
           FROM runs `+where+`ORDER BY started_at DESC, rowid DESC LIMIT ?`, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// RecordStep appends a run step.
func (s *Store) RecordStep(ctx context.Context, app, appDir string, st StepRecord) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	col := func(v any) any {
		if y.IsUndefined(v) {
			return nil
		}
		return safeJSON(v)
	}
	var msCol any
	if st.Ms != nil {
		msCol = int64(math.Floor(*st.Ms + 0.5))
	}
	_, err = h.ExecContext(ctx, `INSERT INTO run_steps
           (id, run_id, box_id, box_type, status, input_json, output_json, ms, error, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), st.RunID, st.BoxID, st.BoxType, st.Status, col(st.Input), col(st.Output), msCol, st.Error, st.Seq)
	return err
}

// ListSteps returns a run's steps in order.
func (s *Store) ListSteps(ctx context.Context, app, appDir, runID string) ([]Step, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT id, run_id, box_id, box_type, status, input_json, output_json, ms, error
           FROM run_steps WHERE run_id = ? ORDER BY seq ASC, rowid ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Step{}
	for rows.Next() {
		var st Step
		var in, outJ, errS sql.NullString
		var msV sql.NullFloat64
		if err := rows.Scan(&st.ID, &st.RunID, &st.BoxID, &st.BoxType, &st.Status, &in, &outJ, &msV, &errS); err != nil {
			return nil, err
		}
		if st.Status != "failed" && st.Status != "skipped" {
			st.Status = "ok"
		}
		st.Input, st.Output = parseJSON(in), parseJSON(outJ)
		if msV.Valid {
			st.Ms = &msV.Float64
		}
		if errS.Valid {
			st.Error = &errS.String
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// PruneHistory deletes runs (and steps) older than retentionDays.
func (s *Store) PruneHistory(ctx context.Context, app, appDir string, retentionDays int) (int, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return 0, err
	}
	days := fmt.Sprintf("-%d days", max(1, retentionDays))
	rows, err := h.QueryContext(ctx, `SELECT id FROM runs WHERE started_at < datetime('now', ?)`, days)
	if err != nil {
		return 0, err
	}
	var stale []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		stale = append(stale, id)
	}
	rows.Close()
	if len(stale) == 0 {
		return 0, nil
	}
	for _, id := range stale {
		if _, err := h.ExecContext(ctx, `DELETE FROM run_steps WHERE run_id = ?`, id); err != nil {
			return 0, err
		}
	}
	if _, err := h.ExecContext(ctx, `DELETE FROM runs WHERE started_at < datetime('now', ?)`, days); err != nil {
		return 0, err
	}
	return len(stale), nil
}

// ---------------------------------------------------------------------------
// Secrets (value_enc is ciphertext, never plain)
// ---------------------------------------------------------------------------

// SetSecret upserts an encrypted secret.
func (s *Store) SetSecret(ctx context.Context, app, appDir, name, valueEnc, last4 string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT INTO secrets (name, value_enc, last4)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             value_enc  = excluded.value_enc,
             last4      = excluded.last4,
             updated_at = datetime('now')`, name, valueEnc, last4)
	return err
}

// ListSecretMeta returns masked metadata for every secret.
func (s *Store) ListSecretMeta(ctx context.Context, app, appDir string) ([]SecretMeta, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT name, last4, created_at, updated_at
           FROM secrets ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SecretMeta{}
	for rows.Next() {
		var m SecretMeta
		if err := rows.Scan(&m.Name, &m.Last4, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetSecretEnc returns the ciphertext of one secret ("", false when absent).
func (s *Store) GetSecretEnc(ctx context.Context, app, appDir, name string) (string, bool) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return "", false
	}
	var enc string
	if err := h.QueryRowContext(ctx, `SELECT value_enc FROM secrets WHERE name = ?`, name).Scan(&enc); err != nil {
		return "", false
	}
	return enc, true
}

// DeleteSecret removes a secret; true when a row was deleted.
func (s *Store) DeleteSecret(ctx context.Context, app, appDir, name string) (bool, error) {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return false, err
	}
	res, err := h.ExecContext(ctx, `DELETE FROM secrets WHERE name = ?`, name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---------------------------------------------------------------------------
// AI budget (per calendar month, UTC)
// ---------------------------------------------------------------------------

// currentMonth is YYYY-MM (UTC).
func currentMonth(now time.Time) string { return now.UTC().Format("2006-01") }

// MonthlyUSD is the estimated spend of the month (0 when none).
func (s *Store) MonthlyUSD(ctx context.Context, app, appDir string, month string) float64 {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return 0
	}
	var usd float64
	if err := h.QueryRowContext(ctx, `SELECT est_usd FROM ai_usage WHERE month = ?`, month).Scan(&usd); err != nil {
		return 0
	}
	return usd
}

// AddUsage accumulates usage into the month bucket.
func (s *Store) AddUsage(ctx context.Context, app, appDir string, tokens, usd float64, month string) error {
	h, err := s.DB(ctx, app, appDir)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT INTO ai_usage (month, tokens, est_usd) VALUES (?, ?, ?)
           ON CONFLICT(month) DO UPDATE SET
             tokens = ai_usage.tokens + excluded.tokens,
             est_usd = ai_usage.est_usd + excluded.est_usd`,
		month, int64(math.Max(0, math.Floor(tokens+0.5))), math.Max(0, usd))
	return err
}
