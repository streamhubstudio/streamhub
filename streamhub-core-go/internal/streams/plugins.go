package streams

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// PluginOverrides is StreamPluginOverridesService: the per-stream plugin
// opt-out stored in streams.disabled_plugins (JSON array of plugin ids the
// stream is opted OUT of). A stream is affected by every app-enabled plugin
// not listed. Like Node it opens the app DB without checking the registry.
type PluginOverrides struct {
	store *db.Service
}

// NewPluginOverrides builds the resolver.
func NewPluginOverrides(store *db.Service) *PluginOverrides { return &PluginOverrides{store: store} }

// StreamPluginsState is the opt-out list of one stream.
type StreamPluginsState struct {
	StreamID string   `json:"streamId"`
	Disabled []string `json:"disabled"`
}

// StreamScope selects the resolution scope (stream id wins over room).
type StreamScope struct {
	Stream string
	Room   string
}

// normalizeIDs coerces to a deduped array of non-empty trimmed strings.
func normalizeIDs(ids []any) []string {
	out := []string{}
	for _, id := range ids {
		s, ok := id.(string)
		if !ok {
			continue
		}
		t := jsTrim(s)
		if t == "" {
			continue
		}
		dup := false
		for _, o := range out {
			dup = dup || o == t
		}
		if !dup {
			out = append(out, t)
		}
	}
	return out
}

func parseIDs(raw sql.NullString) []string {
	if !raw.Valid || raw.String == "" {
		return []string{}
	}
	var v any
	if err := json.Unmarshal([]byte(raw.String), &v); err != nil {
		return []string{}
	}
	arr, ok := v.([]any)
	if !ok {
		return []string{}
	}
	return normalizeIDs(arr)
}

// GetForStream returns one stream's disabled list; 404 when the row is absent.
func (p *PluginOverrides) GetForStream(ctx context.Context, app, streamID string) (*StreamPluginsState, error) {
	adb, err := p.store.App(ctx, app)
	if err != nil {
		return nil, internalError()
	}
	var raw sql.NullString
	err = adb.QueryRowContext(ctx, "SELECT disabled_plugins FROM streams WHERE stream_id = ?", streamID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	if err != nil {
		return nil, internalError()
	}
	return &StreamPluginsState{streamID, parseIDs(raw)}, nil
}

// SetForStream replaces (normalized) a stream's disabled list; 404 when the
// row is absent.
func (p *PluginOverrides) SetForStream(ctx context.Context, app, streamID string, ids []any) (*StreamPluginsState, error) {
	disabled := normalizeIDs(ids)
	adb, err := p.store.App(ctx, app)
	if err != nil {
		return nil, internalError()
	}
	enc, _ := jsx.Stringify(disabled)
	res, err := adb.ExecContext(ctx, "UPDATE streams SET disabled_plugins = ? WHERE stream_id = ?", enc, streamID)
	if err != nil {
		return nil, internalError()
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, httpx.NotFound(fmt.Sprintf("stream '%s' not found", streamID))
	}
	return &StreamPluginsState{streamID, disabled}, nil
}

// DisabledForStream is the non-throwing lookup ([] when unknown).
func (p *PluginOverrides) DisabledForStream(ctx context.Context, app, streamID string) []string {
	adb, err := p.store.App(ctx, app)
	if err != nil {
		return []string{}
	}
	var raw sql.NullString
	if err := adb.QueryRowContext(ctx, "SELECT disabled_plugins FROM streams WHERE stream_id = ?", streamID).Scan(&raw); err != nil {
		return []string{}
	}
	return parseIDs(raw)
}

// DisabledForRoom is the union over the room's ACTIVE streams (first-seen order).
func (p *PluginOverrides) DisabledForRoom(ctx context.Context, app, room string) []string {
	if room == "" {
		return []string{}
	}
	adb, err := p.store.App(ctx, app)
	if err != nil {
		return []string{}
	}
	rows, err := adb.QueryContext(ctx, "SELECT disabled_plugins FROM streams WHERE room = ? AND status = 'active'", room)
	if err != nil {
		return []string{}
	}
	defer rows.Close()
	out := []string{}
	seen := map[string]bool{}
	for rows.Next() {
		var raw sql.NullString
		if err := rows.Scan(&raw); err != nil {
			return []string{}
		}
		for _, id := range parseIDs(raw) {
			if !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}

// ResolveDisabled prefers an exact stream id, then the room aggregate, else [].
func (p *PluginOverrides) ResolveDisabled(ctx context.Context, app string, scope StreamScope) []string {
	if s := jsTrim(scope.Stream); s != "" {
		return p.DisabledForStream(ctx, app, s)
	}
	if r := jsTrim(scope.Room); r != "" {
		return p.DisabledForRoom(ctx, app, r)
	}
	return []string{}
}
