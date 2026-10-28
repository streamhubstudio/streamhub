package logs

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// AppLog is AppLogService: the additive per-app rotated sink
// <DATA_DIR>/apps/<app>/logs/app.log, one RotatingFile per app opened lazily,
// tuned by the same LOG_MAX_BYTES / LOG_MAX_FILES / LOG_RETENTION_DAYS knobs.
type AppLog struct {
	dataDir       string
	retentionDays int
	now           func() time.Time

	mu      sync.Mutex
	streams map[string]*RotatingFile
}

// NewAppLog builds the sink.
func NewAppLog(dataDir string, retentionDays int) *AppLog {
	return &AppLog{dataDir: dataDir, retentionDays: retentionDays, now: time.Now, streams: map[string]*RotatingFile{}}
}

// Line appends a raw line verbatim (newline added when missing).
func (a *AppLog) Line(app, line string) {
	if !strings.HasSuffix(line, "\n") {
		line += "\n"
	}
	a.streamFor(app).Write(line)
}

// Record appends rec as one JSON line with an ISO ts stamped first when rec
// has none ({ts, ...line} in Node: rec's own ts overrides, keeping the
// position first). rec must marshal to a JSON object.
func (a *AppLog) Record(app string, rec any) {
	body, err := jsx.Stringify(rec)
	if err != nil || !strings.HasPrefix(body, "{") {
		return
	}
	ts, _ := jsx.Stringify(jsx.ISO(a.now()))
	var probe map[string]json.RawMessage
	if json.Unmarshal([]byte(body), &probe) == nil {
		if own, ok := probe["ts"]; ok {
			ts = string(own)
			body = removeKey(body, "ts")
		}
	}
	inner := strings.TrimPrefix(strings.TrimSuffix(body, "}"), "{")
	line := `{"ts":` + ts
	if inner != "" {
		line += "," + inner
	}
	a.Line(app, line+"}")
}

// Sweep prunes every open app stream (retention pass).
func (a *AppLog) Sweep() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, s := range a.streams {
		s.Sweep()
	}
}

// Close closes every stream.
func (a *AppLog) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, s := range a.streams {
		s.Close()
	}
	a.streams = map[string]*RotatingFile{}
}

func (a *AppLog) streamFor(app string) *RotatingFile {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.streams[app]
	if !ok {
		s = NewRotatingFile(RotationOptions{
			Dir:        filepath.Join(a.dataDir, "apps", app, "logs"),
			BaseName:   "app",
			MaxBytes:   int64(envInt("LOG_MAX_BYTES", 10*1024*1024)),
			MaxFiles:   envInt("LOG_MAX_FILES", 10),
			MaxAgeDays: a.retentionDays,
		})
		a.streams[app] = s
	}
	return s
}

// removeKey drops a top-level key from a flat JSON object produced by
// Stringify by re-encoding through an ordered decode.
func removeKey(obj, key string) string {
	dec := json.NewDecoder(strings.NewReader(obj))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return obj
	}
	var parts []string
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return obj
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return obj
		}
		k, _ := kt.(string)
		if k == key {
			continue
		}
		ks, _ := jsx.Stringify(k)
		parts = append(parts, ks+":"+string(raw))
	}
	return "{" + strings.Join(parts, ",") + "}"
}
