package healthworker

import (
	"context"
	"database/sql"

	_ "modernc.org/sqlite" // read-only per-room overrides

	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// Port of settings.js. Thresholds resolve exactly as the core does
// (streamhealth.ResolveThresholds: defaults ⊕ app install config ⊕ the
// per-room override); this file only adds the worker-side inputs.

// ParseAppConfig parses HEALTH_CONFIG_JSON (the app-level layer); an empty
// map on any trouble. ok=false means the variable was unset.
func ParseAppConfig(raw string, ok bool) *y.Map {
	if !ok {
		raw = "{}"
	}
	v, err := y.ParseJSON([]byte(raw))
	if err != nil {
		return y.NewMap()
	}
	if m, isObj := v.(*y.Map); isObj && m != nil {
		return m
	}
	return y.NewMap()
}

// ReadRoomOverrides reads every per-room override from stream-health.db,
// read-only, with a fresh open per cycle (WAL reads stay current, no lock is
// held). Any trouble — the core has not created the db yet, no table —
// yields an empty map; corrupt rows are skipped.
func ReadRoomOverrides(ctx context.Context, dbFile string) map[string]*y.Map {
	out := map[string]*y.Map{}
	h, err := sql.Open("sqlite", "file:"+dbFile+"?mode=ro")
	if err != nil {
		return out
	}
	defer h.Close()
	rows, err := h.QueryContext(ctx, `SELECT room, config_json FROM stream_settings`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var room, cfg sql.NullString
		if rows.Scan(&room, &cfg) != nil {
			continue
		}
		raw := "{}"
		if cfg.Valid {
			raw = cfg.String
		}
		v, err := y.ParseJSON([]byte(raw))
		if err != nil {
			continue
		}
		if m, isObj := v.(*y.Map); isObj && m != nil {
			name := "null" // String(row.room)
			if room.Valid {
				name = room.String
			}
			out[name] = m
		}
	}
	return out
}

// ReadRoomSources reads what the core knows of each room's publishers
// (stream_sources, kept by the core from the LiveKit track webhooks): room →
// whether any publisher carries an audio track. Same read-only, fresh open
// per cycle as the overrides; any trouble (a pre-3.4 db without the table,
// no db yet) yields an empty map = unknown, i.e. the detectors as before.
func ReadRoomSources(ctx context.Context, dbFile string) map[string]bool {
	out := map[string]bool{}
	h, err := sql.Open("sqlite", "file:"+dbFile+"?mode=ro")
	if err != nil {
		return out
	}
	defer h.Close()
	rows, err := h.QueryContext(ctx, `SELECT room, has_audio FROM stream_sources`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var room string
		var audio int64
		if rows.Scan(&room, &audio) != nil {
			continue
		}
		out[room] = audio != 0
	}
	return out
}
