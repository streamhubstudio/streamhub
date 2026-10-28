package healthworker

import (
	"context"
	"database/sql"

	_ "modernc.org/sqlite" // read-only per-room overrides

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
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
