// Package logs ports modules/logs: structured logging to console + a
// rotating file (<DATA_DIR>/logs/streamhub.log) + the server_logs table, the
// log viewers (GET /logs, GET /apps/:app/logs), the retention timer and the
// per-app rotated sink (AppLog, apps/<app>/logs/app.log).
package logs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Levels are the valid LogLevel values, in severity order.
var Levels = []string{"trace", "debug", "info", "warn", "error", "fatal"}

func validLevel(l string) bool {
	for _, v := range Levels {
		if v == l {
			return true
		}
	}
	return false
}

const (
	defaultLimit = 100
	maxLimit     = 1000
	// appIDTTL is how long a resolved app name→id (or a miss) stays cached.
	appIDTTL = 60 * time.Second
	// purgeKickoff delays the first retention pass after boot.
	purgeKickoff = 60 * time.Second
	// purgeEvery is the interval between retention passes.
	purgeEvery = 6 * time.Hour
)

// Entry is one server_logs row as the viewers return it (LogEntry).
type Entry struct {
	ID       int64   `json:"id"`
	Ts       string  `json:"ts"`
	Level    string  `json:"level"`
	Source   string  `json:"source"`
	AppID    *int64  `json:"appId"`
	Message  string  `json:"message"`
	MetaJSON *string `json:"metaJson"`
}

// Filters are the read filters of Query/Count (LogFilters).
type Filters struct {
	App    string
	Level  string
	Source string
	Q      string
	Since  string
	Until  string
	Limit  *int
	Offset *int
}

// MQTTSink forwards app-attributed log lines (MqttService.publishLog). It
// self-gates on the app's mqtt.logs config.
type MQTTSink interface {
	PublishLog(ctx context.Context, app, level, source, message string, meta any) error
}

// Service is LogsService. Write is fire-and-forget and never fails.
type Service struct {
	db            *sql.DB
	file          *RotatingFile
	log           *slog.Logger
	dataDir       string
	retentionDays int
	now           func() time.Time

	mu    sync.Mutex
	cache map[string]cachedID
	mqtt  MQTTSink
}

type cachedID struct {
	id  *int64
	exp time.Time
}

// New builds the service (no I/O until the first Write). LOG_MAX_BYTES /
// LOG_MAX_FILES tune the file sink as in Node.
func New(cfg *config.Config, global *sql.DB, log *slog.Logger) *Service {
	return &Service{
		db:      global,
		log:     log,
		dataDir: cfg.DataDir,
		file: NewRotatingFile(RotationOptions{
			Dir:             filepath.Join(cfg.DataDir, "logs"),
			BaseName:        "streamhub",
			LegacyBaseNames: []string{"skyline"},
			MaxBytes:        int64(envInt("LOG_MAX_BYTES", 10*1024*1024)),
			MaxFiles:        envInt("LOG_MAX_FILES", 10),
			MaxAgeDays:      cfg.LogRetentionDays,
		}),
		retentionDays: cfg.LogRetentionDays,
		now:           time.Now,
		cache:         map[string]cachedID{},
	}
}

// envInt is this.int(process.env.X, fallback): parseInt, NaN → fallback.
func envInt(name string, fallback int) int {
	n, ok := config.ParseIntPrefix(os.Getenv(name))
	if !ok {
		return fallback
	}
	return n
}

// SetMQTTSink late-binds the MQTT forwarder (the mqtt module logs through
// us, so it cannot be a constructor dependency).
func (s *Service) SetMQTTSink(m MQTTSink) {
	s.mu.Lock()
	s.mqtt = m
	s.mu.Unlock()
}

type readyMeta struct {
	Dir           string `json:"dir"`
	RetentionDays int    `json:"retentionDays"`
}

// Init is onModuleInit: the boot self-log.
func (s *Service) Init() {
	s.Write("info", "logs", "LogsService ready", readyMeta{filepath.Join(s.dataDir, "logs"), s.retentionDays}, nil)
}

// Start schedules retention: 1 min after boot, then every 6h, until ctx ends
// (the file is closed then).
func (s *Service) Start(ctx context.Context) {
	go func() {
		defer s.file.Close()
		kick := time.NewTimer(purgeKickoff)
		defer kick.Stop()
		tick := time.NewTicker(purgeEvery)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-kick.C:
				s.runRetention()
			case <-tick.C:
				s.runRetention()
			}
		}
	}()
}

// Write emits a structured log to console + file + server_logs (+ MQTT for
// app-attributed lines). meta is any JSON-marshalable value (nil = none; use
// a struct to keep Node's key order in meta_json). appID, when non-nil,
// wins over meta.app. Never fails.
func (s *Service) Write(level, source, message string, meta any, appID *int64) {
	lvl := level
	if !validLevel(lvl) {
		lvl = "info"
	}
	ts := jsx.ISO(s.now())
	src := source
	if src == "" {
		src = "app"
	}
	var metaJSON []byte
	if meta != nil {
		if b, err := jsx.Stringify(meta); err == nil && b != "null" {
			metaJSON = []byte(b)
		}
	}
	metaApp, hasApp := appOf(meta, metaJSON)
	aid := appID
	if aid == nil && hasApp {
		aid = s.resolveAppID(metaApp)
	}

	// 1) console
	s.console(lvl, src, message, aid, metaJSON)

	// 2) rotating file, one JSON object per line (ts, level, source, appId, message[, meta])
	var line strings.Builder
	line.WriteString(`{"ts":` + jsonStr(ts) + `,"level":` + jsonStr(lvl) + `,"source":` + jsonStr(src) + `,"appId":`)
	if aid == nil {
		line.WriteString("null")
	} else {
		fmt.Fprintf(&line, "%d", *aid)
	}
	line.WriteString(`,"message":` + jsonStr(message))
	if metaJSON != nil {
		line.WriteString(`,"meta":`)
		line.Write(metaJSON)
	}
	line.WriteString("}\n")
	s.file.Write(line.String())

	// 3) server_logs
	var metaCol any
	if metaJSON != nil {
		metaCol = string(metaJSON)
	}
	var aidCol any
	if aid != nil {
		aidCol = *aid
	}
	if _, err := s.db.Exec(`INSERT INTO server_logs (ts, level, source, app_id, message, meta_json)
           VALUES (?, ?, ?, ?, ?, ?)`, ts, lvl, src, aidCol, message, metaCol); err != nil {
		s.log.Error("server_logs insert failed: " + err.Error())
	}

	// 4) per-app MQTT forwarding (never 'mqtt' itself: loop guard)
	if hasApp && src != "mqtt" {
		s.mu.Lock()
		sink := s.mqtt
		s.mu.Unlock()
		if sink != nil {
			go func() {
				defer func() { _ = recover() }()
				_ = sink.PublishLog(context.Background(), metaApp, lvl, src, message, meta)
			}()
		}
	}
}

// Logf is Write without meta (convenience for Go callers).
func (s *Service) Logf(level, source, format string, args ...any) {
	s.Write(level, source, fmt.Sprintf(format, args...), nil, nil)
}

func (s *Service) console(lvl, src, message string, aid *int64, metaJSON []byte) {
	if s.log == nil {
		return
	}
	var sl slog.Level
	switch lvl {
	case "trace":
		sl = slog.LevelDebug - 4
	case "debug":
		sl = slog.LevelDebug
	case "warn":
		sl = slog.LevelWarn
	case "error":
		sl = slog.LevelError
	case "fatal":
		sl = slog.LevelError + 4
	default:
		sl = slog.LevelInfo
	}
	attrs := []any{"source", src, "appId", aid}
	if metaJSON != nil {
		attrs = append(attrs, "meta", json.RawMessage(metaJSON))
	}
	s.log.Log(context.Background(), sl, message, attrs...)
}

// appOf extracts a string meta.app.
func appOf(meta any, metaJSON []byte) (string, bool) {
	if m, ok := meta.(map[string]any); ok {
		app, ok := m["app"].(string)
		return app, ok
	}
	if metaJSON == nil || metaJSON[0] != '{' {
		return "", false
	}
	var probe struct {
		App any `json:"app"`
	}
	if json.Unmarshal(metaJSON, &probe) != nil {
		return "", false
	}
	app, ok := probe.App.(string)
	return app, ok
}

func jsonStr(s string) string {
	b, _ := jsx.Stringify(s)
	return b
}

// resolveAppID maps an app name to its id, caching hits and misses for 60s.
// A failed SELECT clears the cache.
func (s *Service) resolveAppID(name string) *int64 {
	now := s.now()
	s.mu.Lock()
	hit, ok := s.cache[name]
	s.mu.Unlock()
	if ok && hit.exp.After(now) {
		return hit.id
	}
	var id int64
	err := s.db.QueryRow(`SELECT id FROM apps WHERE name = ?`, name).Scan(&id)
	switch {
	case err == nil:
		s.mu.Lock()
		s.cache[name] = cachedID{&id, now.Add(appIDTTL)}
		s.mu.Unlock()
		return &id
	case err == sql.ErrNoRows:
		s.mu.Lock()
		s.cache[name] = cachedID{nil, now.Add(appIDTTL)}
		s.mu.Unlock()
		return nil
	default:
		s.mu.Lock()
		s.cache = map[string]cachedID{}
		s.mu.Unlock()
		return nil
	}
}

// Query is the filtered, paginated read (newest first). Never fails.
func (s *Service) Query(ctx context.Context, f Filters) []Entry {
	where, params := buildWhere(f)
	limit := defaultLimit
	if f.Limit != nil {
		limit = min(max(*f.Limit, 1), maxLimit)
	}
	offset := 0
	if f.Offset != nil {
		offset = max(*f.Offset, 0)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, ts, level, source, app_id, message, meta_json
                     FROM server_logs
                     `+where+`
                     ORDER BY ts DESC, id DESC
                     LIMIT ? OFFSET ?`, append(params, limit, offset)...)
	if err != nil {
		s.log.Error("logs query failed: " + err.Error())
		return []Entry{}
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var (
			e      Entry
			source sql.NullString
			appID  sql.NullInt64
			meta   sql.NullString
		)
		if err := rows.Scan(&e.ID, &e.Ts, &e.Level, &source, &appID, &e.Message, &meta); err != nil {
			s.log.Error("logs query failed: " + err.Error())
			return []Entry{}
		}
		if !validLevel(e.Level) {
			e.Level = "info"
		}
		e.Source = "app"
		if source.Valid {
			e.Source = source.String
		}
		if appID.Valid {
			v := appID.Int64
			e.AppID = &v
		}
		if meta.Valid {
			v := meta.String
			e.MetaJSON = &v
		}
		out = append(out, e)
	}
	return out
}

// Count is the total matching rows (ignores limit/offset). Never fails.
func (s *Service) Count(ctx context.Context, f Filters) int64 {
	where, params := buildWhere(f)
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM server_logs `+where, params...).Scan(&n); err != nil {
		s.log.Error("logs count failed: " + err.Error())
		return 0
	}
	return n
}

type purgeMeta struct {
	RetentionDays int   `json:"retentionDays"`
	Deleted       int64 `json:"deleted"`
}

// PurgeOldLogs deletes rows older than LOG_RETENTION_DAYS (0 = keep forever)
// and returns how many went. Never fails.
func (s *Service) PurgeOldLogs() int64 {
	days := s.retentionDays
	if days <= 0 {
		return 0
	}
	res, err := s.db.Exec(`DELETE FROM server_logs WHERE ts < datetime('now', ? || ' days')`, fmt.Sprintf("-%d", days))
	if err != nil {
		s.log.Error("logs purge failed: " + err.Error())
		return 0
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		s.Write("info", "logs", fmt.Sprintf("purged %d expired log rows", n), purgeMeta{days, n}, nil)
	}
	return n
}

func (s *Service) runRetention() {
	s.PurgeOldLogs()
	s.file.Sweep()
}

func buildWhere(f Filters) (string, []any) {
	var clauses []string
	var params []any
	if f.App != "" {
		clauses = append(clauses, "app_id = (SELECT id FROM apps WHERE name = ?)")
		params = append(params, f.App)
	}
	if f.Level != "" && validLevel(f.Level) {
		clauses = append(clauses, "level = ?")
		params = append(params, f.Level)
	}
	if f.Source != "" {
		clauses = append(clauses, "source = ?")
		params = append(params, f.Source)
	}
	if f.Q != "" {
		clauses = append(clauses, `message LIKE ? ESCAPE '\'`)
		params = append(params, "%"+escapeLike(f.Q)+"%")
	}
	if f.Since != "" {
		clauses = append(clauses, "ts >= ?")
		params = append(params, f.Since)
	}
	if f.Until != "" {
		clauses = append(clauses, "ts <= ?")
		params = append(params, f.Until)
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return "WHERE " + strings.Join(clauses, " AND "), params
}

// escapeLike escapes \, % and _ for LIKE … ESCAPE '\'.
func escapeLike(v string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(v)
}
