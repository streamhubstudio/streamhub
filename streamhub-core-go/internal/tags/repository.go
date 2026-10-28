// Package tags is the port of src/modules/tags (Vision-Edge §E): the per-app
// `tags` table (a named entity with a `config_json` settings blob) and the
// `streams.tags` JSON-array column referencing tags by slug. CRUD at
// /apps/:app/tags, stream/room tagging at /apps/:app/streams/:id/tags and
// /apps/:app/tags/room/:room. Deleting a tag prunes its slug from every
// stream atomically.
package tags

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// SlugRE is TAG_SLUG_RE: kebab-case, lowercase alphanumerics in hyphen groups.
var SlugRE = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// TagRecord is the public shape of a tag (config_json parsed to an object,
// JS key order kept).
type TagRecord struct {
	Slug       string `json:"slug"`
	Label      string `json:"label"`
	Kind       string `json:"kind"`
	ConfigJSON *y.Map `json:"config_json"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

// CreateInput is CreateTagInput. ConfigJSON nil = absent ({}).
type CreateInput struct {
	Slug       string
	Label      string
	Kind       *string
	ConfigJSON *y.Map
}

// UpdateInput is UpdateTagInput (nil = untouched; slug is immutable).
type UpdateInput struct {
	Label      *string
	Kind       *string
	ConfigJSON *y.Map
}

// StreamTagsState is the result of a stream-tagging read/write.
type StreamTagsState struct {
	StreamID string   `json:"streamId"`
	Tags     []string `json:"tags"`
}

// RoomTagsState is the result of a room-scoped tagging write.
type RoomTagsState struct {
	Room    string   `json:"room"`
	Tags    []string `json:"tags"`
	Updated int64    `json:"updated"`
}

// Repository is TagsRepository.
type Repository struct {
	store  *db.Service
	global *sql.DB
}

// New builds the repository over the global registry + per-app DBs.
func New(store *db.Service, global *sql.DB) *Repository {
	return &Repository{store: store, global: global}
}

// internalError is Nest's body for an unexpected (non-HTTP) exception.
func internalError() error { return httpx.Internal("Internal server error") }

// requireApp: the app must exist in the global registry BEFORE touching
// appDb(app) (which would otherwise create a stray app.db).
func (r *Repository) requireApp(ctx context.Context, app string) (*sql.DB, error) {
	var id int64
	err := r.global.QueryRowContext(ctx, "SELECT id FROM apps WHERE name = ?", app).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	if err != nil {
		return nil, httpx.Unavailable(fmt.Sprintf("db error: %s", err))
	}
	adb, err := r.store.App(ctx, app)
	if err != nil {
		return nil, internalError()
	}
	return adb, nil
}

type tagRow struct {
	slug, label, kind    string
	configJSON           sql.NullString
	createdAt, updatedAt string
}

const tagCols = "slug, label, kind, config_json, created_at, updated_at"

func scanTag(sc interface{ Scan(...any) error }) (*tagRow, error) {
	var t tagRow
	if err := sc.Scan(&t.slug, &t.label, &t.kind, &t.configJSON, &t.createdAt, &t.updatedAt); err != nil {
		return nil, err
	}
	return &t, nil
}

func (t *tagRow) record() TagRecord {
	cfg := y.NewMap()
	raw := "{}"
	if t.configJSON.Valid {
		raw = t.configJSON.String
	}
	if v, err := y.ParseJSON([]byte(raw)); err == nil {
		if m, ok := v.(*y.Map); ok {
			cfg = m
		}
	}
	return TagRecord{t.slug, t.label, t.kind, cfg, t.createdAt, t.updatedAt}
}

// List returns an app's tags (optionally filtered by kind), newest first.
func (r *Repository) List(ctx context.Context, app, kind string) ([]TagRecord, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	var rows *sql.Rows
	if kind != "" {
		rows, err = adb.QueryContext(ctx, "SELECT "+tagCols+" FROM tags WHERE kind = ? ORDER BY created_at DESC, id DESC", kind)
	} else {
		rows, err = adb.QueryContext(ctx, "SELECT "+tagCols+" FROM tags ORDER BY created_at DESC, id DESC")
	}
	if err != nil {
		return nil, internalError()
	}
	defer rows.Close()
	out := []TagRecord{}
	for rows.Next() {
		t, err := scanTag(rows)
		if err != nil {
			return nil, internalError()
		}
		out = append(out, t.record())
	}
	if rows.Err() != nil {
		return nil, internalError()
	}
	return out, nil
}

// Get returns one tag, or nil when absent.
func (r *Repository) Get(ctx context.Context, app, slug string) (*TagRecord, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	return getTag(ctx, adb, slug)
}

func getTag(ctx context.Context, adb *sql.DB, slug string) (*TagRecord, error) {
	t, err := scanTag(adb.QueryRowContext(ctx, "SELECT "+tagCols+" FROM tags WHERE slug = ?", slug))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError()
	}
	rec := t.record()
	return &rec, nil
}

// Create validates the slug (kebab-case), rejects a duplicate with 409 and
// defaults kind to 'custom' and config_json to {}.
func (r *Repository) Create(ctx context.Context, app string, in CreateInput) (*TagRecord, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	slug := jsTrim(in.Slug)
	if !SlugRE.MatchString(slug) {
		return nil, httpx.BadRequest("invalid slug (kebab-case: lowercase a-z, 0-9, hyphen-separated)")
	}
	label := jsTrim(in.Label)
	if label == "" {
		return nil, httpx.BadRequest("label is required")
	}
	kind := "custom"
	if in.Kind != nil {
		kind = jsTrim(*in.Kind)
	}
	if kind == "" {
		kind = "custom"
	}
	cfg := stringifyConfig(in.ConfigJSON)
	var one int
	switch err := adb.QueryRowContext(ctx, "SELECT 1 FROM tags WHERE slug = ?", slug).Scan(&one); {
	case err == nil:
		return nil, httpx.Conflict(fmt.Sprintf("tag '%s' already exists", slug))
	case !errors.Is(err, sql.ErrNoRows):
		return nil, internalError()
	}
	if _, err := adb.ExecContext(ctx, "INSERT INTO tags (slug, label, kind, config_json) VALUES (?, ?, ?, ?)", slug, label, kind, cfg); err != nil {
		return nil, internalError()
	}
	return getTag(ctx, adb, slug)
}

// Update patches label / kind / config_json (any subset); 404 when absent.
// Bumps updated_at only when something changes.
func (r *Repository) Update(ctx context.Context, app, slug string, patch UpdateInput) (*TagRecord, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	existing, err := getTag(ctx, adb, slug)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, httpx.NotFound(fmt.Sprintf("tag '%s' not found", slug))
	}
	var sets []string
	var params []any
	if patch.Label != nil {
		label := jsTrim(*patch.Label)
		if label == "" {
			return nil, httpx.BadRequest("label cannot be empty")
		}
		sets = append(sets, "label = ?")
		params = append(params, label)
	}
	if patch.Kind != nil {
		kind := jsTrim(*patch.Kind)
		if kind == "" {
			kind = "custom"
		}
		sets = append(sets, "kind = ?")
		params = append(params, kind)
	}
	if patch.ConfigJSON != nil {
		sets = append(sets, "config_json = ?")
		params = append(params, stringifyConfig(patch.ConfigJSON))
	}
	if len(sets) > 0 {
		sets = append(sets, "updated_at = datetime('now')")
		params = append(params, slug)
		if _, err := adb.ExecContext(ctx, "UPDATE tags SET "+strings.Join(sets, ", ")+" WHERE slug = ?", params...); err != nil {
			return nil, internalError()
		}
	}
	return getTag(ctx, adb, slug)
}

// Remove deletes the tag AND prunes its slug from every stream's tags array
// in one transaction; 404 (nothing touched) when the tag does not exist.
func (r *Repository) Remove(ctx context.Context, app, slug string) error {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return err
	}
	tx, err := adb.BeginTx(ctx, nil)
	if err != nil {
		return internalError()
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, "DELETE FROM tags WHERE slug = ?", slug)
	if err != nil {
		return internalError()
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return httpx.NotFound(fmt.Sprintf("tag '%s' not found", slug))
	}
	type streamTags struct {
		id   int64
		tags sql.NullString
	}
	rows, err := tx.QueryContext(ctx, "SELECT id, tags FROM streams")
	if err != nil {
		return internalError()
	}
	var all []streamTags
	for rows.Next() {
		var st streamTags
		if err := rows.Scan(&st.id, &st.tags); err != nil {
			rows.Close()
			return internalError()
		}
		all = append(all, st)
	}
	rows.Close()
	for _, st := range all {
		current := ParseTags(st.tags.String)
		if !contains(current, slug) {
			continue
		}
		next := []string{}
		for _, t := range current {
			if t != slug {
				next = append(next, t)
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE streams SET tags = ? WHERE id = ?", jsonArray(next), st.id); err != nil {
			return internalError()
		}
	}
	if err := tx.Commit(); err != nil {
		return internalError()
	}
	return nil
}

// GetStreamTags returns a stream's applied slugs; 404 when the row is absent.
func (r *Repository) GetStreamTags(ctx context.Context, app, streamID string) (*StreamTagsState, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	var raw sql.NullString
	err = adb.QueryRowContext(ctx, "SELECT tags FROM streams WHERE stream_id = ?", streamID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	if err != nil {
		return nil, internalError()
	}
	return &StreamTagsState{streamID, ParseTags(raw.String)}, nil
}

// SetStreamTags replaces a stream's slugs (all must exist → else 400; 404
// when the stream row is absent).
func (r *Repository) SetStreamTags(ctx context.Context, app, streamID string, slugs []any) (*StreamTagsState, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	tags, err := normalizeAndValidate(ctx, adb, slugs)
	if err != nil {
		return nil, err
	}
	res, err := adb.ExecContext(ctx, "UPDATE streams SET tags = ? WHERE stream_id = ?", jsonArray(tags), streamID)
	if err != nil {
		return nil, internalError()
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	return &StreamTagsState{streamID, tags}, nil
}

// SetRoomTags replaces the slugs on EVERY stream row of a room; updated is
// the row count (0 when the room has no rows yet — not an error).
func (r *Repository) SetRoomTags(ctx context.Context, app, room string, slugs []any) (*RoomTagsState, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	tags, err := normalizeAndValidate(ctx, adb, slugs)
	if err != nil {
		return nil, err
	}
	res, err := adb.ExecContext(ctx, "UPDATE streams SET tags = ? WHERE room = ?", jsonArray(tags), room)
	if err != nil {
		return nil, internalError()
	}
	n, _ := res.RowsAffected()
	return &RoomTagsState{room, tags, n}, nil
}

// TagConfigs returns the parsed config_json of the given slugs, in order,
// skipping unknown ones (for the vision scheduler's settings resolution).
func (r *Repository) TagConfigs(ctx context.Context, app string, slugs []string) ([]*y.Map, error) {
	adb, err := r.requireApp(ctx, app)
	if err != nil {
		return nil, err
	}
	out := []*y.Map{}
	for _, s := range slugs {
		t, err := getTag(ctx, adb, s)
		if err != nil {
			return nil, err
		}
		if t != nil {
			out = append(out, t.ConfigJSON)
		}
	}
	return out, nil
}

// normalizeAndValidate dedupes/trims/drops empties and asserts every slug
// exists ("unknown tag slug(s): a, b").
func normalizeAndValidate(ctx context.Context, adb *sql.DB, slugs []any) ([]string, error) {
	tags := Normalize(slugs)
	if len(tags) == 0 {
		return tags, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?, ", len(tags)), ", ")
	args := make([]any, len(tags))
	for i, t := range tags {
		args[i] = t
	}
	rows, err := adb.QueryContext(ctx, "SELECT slug FROM tags WHERE slug IN ("+ph+")", args...)
	if err != nil {
		return nil, internalError()
	}
	known := map[string]bool{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return nil, internalError()
		}
		known[s] = true
	}
	rows.Close()
	var unknown []string
	for _, t := range tags {
		if !known[t] {
			unknown = append(unknown, t)
		}
	}
	if len(unknown) > 0 {
		return nil, httpx.BadRequest("unknown tag slug(s): " + strings.Join(unknown, ", "))
	}
	return tags, nil
}

// Normalize coerces to a deduped array of non-empty trimmed strings (order
// preserved; non-strings dropped).
func Normalize(ids []any) []string {
	out := []string{}
	for _, id := range ids {
		s, ok := id.(string)
		if !ok {
			continue
		}
		t := jsTrim(s)
		if t != "" && !contains(out, t) {
			out = append(out, t)
		}
	}
	return out
}

// ParseTags parses a JSON-array cell into a clean slug array ([] on null /
// corrupt / non-array).
func ParseTags(raw string) []string {
	if raw == "" {
		return []string{}
	}
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return []string{}
	}
	arr, ok := v.([]any)
	if !ok {
		return []string{}
	}
	return Normalize(arr)
}

// stringifyConfig is JSON.stringify(config ?? {}).
func stringifyConfig(m *y.Map) string {
	if m == nil {
		return "{}"
	}
	s, err := y.Stringify(m)
	if err != nil {
		return "{}"
	}
	return s
}

// jsonArray is JSON.stringify(string[]).
func jsonArray(a []string) string {
	s, _ := y.Stringify(toAny(a))
	return s
}

func toAny(a []string) []any {
	out := make([]any, len(a))
	for i, s := range a {
		out[i] = s
	}
	return out
}

func contains(a []string, s string) bool {
	for _, x := range a {
		if x == s {
			return true
		}
	}
	return false
}

// jsTrim is String#trim (ECMAScript WhiteSpace + LineTerminator).
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}
