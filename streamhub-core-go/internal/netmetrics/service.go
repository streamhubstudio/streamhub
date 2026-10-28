// Package netmetrics is modules/net-metrics: per-app media-plane byte
// accounting (HLS egress, MediaMTX ingest/delivery, LiveKit egress output),
// flushed every 60 s into the per-app net_samples table by UTC hour bucket;
// the rolling threshold monitor; and the read API.
package netmetrics

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	// flushEvery is the flush + MediaMTX poll cadence.
	flushEvery         = 60 * time.Second
	mediamtxTimeout    = 3 * time.Second
	mediamtxMaxPages   = 100
	historyMaxHours    = 24 * 30
	defaultHistoryHour = 48
)

// AppDBs opens a per-app DB (db.Service.App).
type AppDBs func(ctx context.Context, app string) (*sql.DB, error)

type accKey struct{ app, direction, source string }

type mtxSeen struct{ received, sent float64 }

// Service is NetMetricsService. RecordBytes is the collector sink: cheap
// and never failing.
type Service struct {
	appDB AppDBs
	logs  logsink.Writer

	mediamtxEnable bool
	mediamtxAPI    string
	// HTTP is the MediaMTX API client (tests inject a fake transport).
	HTTP *http.Client

	mu       sync.Mutex
	acc      map[accKey]int64
	flushing bool

	pollMu  sync.Mutex
	polling bool
	seen    map[string]mtxSeen
}

// New builds the service.
func New(appDB AppDBs, mediamtxEnable bool, mediamtxAPIURL string, logs logsink.Writer) *Service {
	return &Service{
		appDB: appDB, logs: logs, mediamtxEnable: mediamtxEnable, mediamtxAPI: mediamtxAPIURL,
		HTTP: &http.Client{}, acc: map[accKey]int64{}, seen: map[string]mtxSeen{},
	}
}

// Start runs the 60 s flush timer (+ the MediaMTX poller when enabled) and
// a final best-effort flush on shutdown.
func (s *Service) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(flushEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				s.FlushOnce(context.WithoutCancel(ctx), time.Now())
				return
			case <-t.C:
				s.FlushOnce(ctx, time.Now())
			}
		}
	}()
	if !s.mediamtxEnable {
		return
	}
	go func() {
		t := time.NewTicker(flushEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.PollMediamtxOnce(ctx)
			}
		}
	}()
}

// RecordBytes adds bytes of traffic for app on direction (in|out) / source
// (hls, mediamtx, livekit-egress, …). Non-positive counts are ignored.
func (s *Service) RecordBytes(app, direction, source string, bytes int64) {
	if app == "" || source == "" || bytes <= 0 {
		return
	}
	s.mu.Lock()
	s.acc[accKey{app, direction, source}] += bytes
	s.mu.Unlock()
}

// CountHLS implements web.ByteCounter: bytes served under /hls are HLS
// egress of the app.
func (s *Service) CountHLS(app string, bytes int64) {
	s.RecordBytes(app, "out", "hls", bytes)
}

// FlushOnce UPSERTs the accumulated bytes into net_samples under the
// current hour bucket. A failed app re-accumulates for the next flush.
func (s *Service) FlushOnce(ctx context.Context, now time.Time) {
	s.mu.Lock()
	if s.flushing || len(s.acc) == 0 {
		s.mu.Unlock()
		return
	}
	s.flushing = true
	entries := s.acc
	s.acc = map[accKey]int64{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.flushing = false
		s.mu.Unlock()
	}()

	bucket := HourBucket(now)
	for k, bytes := range entries {
		err := s.upsert(ctx, k, bucket, bytes)
		if err != nil {
			s.mu.Lock()
			s.acc[k] += bytes
			s.mu.Unlock()
			s.warn(k.app, "net_samples flush failed", err)
		}
	}
}

func (s *Service) upsert(ctx context.Context, k accKey, bucket string, bytes int64) error {
	db, err := s.appDB(ctx, k.app)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO net_samples (bucket, direction, source, bytes)
                 VALUES (?, ?, ?, ?)
               ON CONFLICT(bucket, direction, source)
                 DO UPDATE SET bytes = bytes + excluded.bytes`, bucket, k.direction, k.source, bytes)
	return err
}

// PollMediamtxOnce deltas the cumulative /v3/paths/list byte counters of
// app-attributable (passthrough) paths. First sight anchors a baseline; a
// counter reset counts the fresh cumulative. Never fails.
func (s *Service) PollMediamtxOnce(ctx context.Context) {
	s.pollMu.Lock()
	if s.polling {
		s.pollMu.Unlock()
		return
	}
	s.polling = true
	s.pollMu.Unlock()
	defer func() {
		s.pollMu.Lock()
		s.polling = false
		s.pollMu.Unlock()
	}()

	items, err := s.fetchMediamtxPaths(ctx)
	if err != nil {
		s.warn("", "MediaMTX poll failed", err)
		return
	}
	seenNow := map[string]bool{}
	for _, it := range items {
		name, _ := it["name"].(string)
		if name == "" {
			continue
		}
		app, ok := passthroughApp(name)
		if !ok {
			continue
		}
		seenNow[name] = true
		cur := mtxSeen{received: counter(it["bytesReceived"]), sent: counter(it["bytesSent"])}
		s.pollMu.Lock()
		prev, had := s.seen[name]
		s.seen[name] = cur
		s.pollMu.Unlock()
		if !had {
			continue
		}
		dIn, dOut := cur.received, cur.sent
		if cur.received >= prev.received {
			dIn = cur.received - prev.received
		}
		if cur.sent >= prev.sent {
			dOut = cur.sent - prev.sent
		}
		s.RecordBytes(app, "in", "mediamtx", int64(math.Floor(dIn)))
		s.RecordBytes(app, "out", "mediamtx", int64(math.Floor(dOut)))
	}
	s.pollMu.Lock()
	for name := range s.seen {
		if !seenNow[name] {
			delete(s.seen, name)
		}
	}
	s.pollMu.Unlock()
}

// counter is Math.max(0, Number(v) || 0).
func counter(v any) float64 {
	if v == nil {
		return 0
	}
	n := yamljs.ToNumber(v)
	if math.IsNaN(n) || n <= 0 {
		return 0
	}
	return n
}

func (s *Service) fetchMediamtxPaths(ctx context.Context) ([]map[string]any, error) {
	base := strings.TrimRight(s.mediamtxAPI, "/")
	var items []map[string]any
	for page := 0; page < mediamtxMaxPages; page++ {
		var body struct {
			PageCount any              `json:"pageCount"`
			Items     []map[string]any `json:"items"`
		}
		if err := s.getJSON(ctx, fmt.Sprintf("%s/v3/paths/list?page=%d&itemsPerPage=100", base, page), &body); err != nil {
			return nil, err
		}
		items = append(items, body.Items...)
		pageCount := 1.0
		if n, ok := body.PageCount.(float64); ok {
			pageCount = n
		}
		if float64(page+1) >= pageCount {
			break
		}
	}
	return items, nil
}

func (s *Service) getJSON(ctx context.Context, url string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, mediamtxTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	res, err := s.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Window is a per-direction rollup.
type Window = NetMetricsWindow

// NetMetricsWindow is the wire type (module-prefixed schema name).
type NetMetricsWindow struct {
	In    int64 `json:"in"`
	Out   int64 `json:"out"`
	Total int64 `json:"total"`
}

// SourceRow is a last-24h per-source breakdown row.
type SourceRow = NetMetricsSourceRow

// NetMetricsSourceRow is the wire type (module-prefixed schema name).
type NetMetricsSourceRow struct {
	Source string `json:"source"`
	In     int64  `json:"in"`
	Out    int64  `json:"out"`
}

// ThresholdState is the instantaneous threshold posture.
type ThresholdState = NetMetricsThresholdState

// NetMetricsThresholdState is the wire type (module-prefixed schema name).
type NetMetricsThresholdState struct {
	GBPerDay       float64  `json:"gbPerDay"`
	ThresholdBytes float64  `json:"thresholdBytes"`
	Usage24hBytes  int64    `json:"usage24hBytes"`
	Percent        *float64 `json:"percent"`
	Exceeded       bool     `json:"exceeded"`
}

// Summary is GET /apps/:app/net.
type Summary = NetMetricsSummary

// NetMetricsSummary is the wire type (module-prefixed schema name).
type NetMetricsSummary struct {
	Today     Window         `json:"today"`
	Last24h   Window         `json:"last24h"`
	Last7d    Window         `json:"last7d"`
	BySource  []SourceRow    `json:"bySource"`
	Threshold ThresholdState `json:"threshold"`
}

// HistoryBucket is one sparkline row.
type HistoryBucket = NetMetricsHistoryBucket

// NetMetricsHistoryBucket is the wire type (module-prefixed schema name).
type NetMetricsHistoryBucket struct {
	Bucket string `json:"bucket"`
	In     int64  `json:"in"`
	Out    int64  `json:"out"`
}

// Summary rolls up today / 24h / 7d plus per-source and the threshold.
func (s *Service) Summary(ctx context.Context, app string, now time.Time, thresholdGBDay float64) Summary {
	last24h := s.windowSince(ctx, app, WindowStartBucket(now, 24))
	gb := 0.0
	if thresholdGBDay > 0 {
		gb = thresholdGBDay
	}
	thresholdBytes := 0.0
	if gb > 0 {
		thresholdBytes = gb * GBBytes
	}
	st := ThresholdState{GBPerDay: gb, ThresholdBytes: thresholdBytes, Usage24hBytes: last24h.Total}
	if thresholdBytes > 0 {
		p := float64(last24h.Total) / thresholdBytes * 100
		st.Percent = &p
		st.Exceeded = float64(last24h.Total) >= thresholdBytes
	}
	return Summary{
		Today:     s.windowSince(ctx, app, HourBucket(now)[:10]+"T00"),
		Last24h:   last24h,
		Last7d:    s.windowSince(ctx, app, WindowStartBucket(now, 168)),
		BySource:  s.sourcesSince(ctx, app, WindowStartBucket(now, 24)),
		Threshold: st,
	}
}

// History is the bucketed history (oldest first), hours clamped to [1, 720].
func (s *Service) History(ctx context.Context, app string, hours float64, now time.Time) []HistoryBucket {
	clamped := math.Min(math.Max(1, math.Floor(hours)), historyMaxHours)
	out := []HistoryBucket{}
	db, err := s.appDB(ctx, app)
	if err != nil {
		s.warn(app, "net history query failed", err)
		return out
	}
	rows, err := db.QueryContext(ctx, `SELECT bucket, direction, SUM(bytes) AS bytes
             FROM net_samples
            WHERE bucket >= ?
            GROUP BY bucket, direction
            ORDER BY bucket ASC`, WindowStartBucket(now, clamped))
	if err != nil {
		s.warn(app, "net history query failed", err)
		return out
	}
	defer rows.Close()
	index := map[string]int{}
	for rows.Next() {
		var bucket, dir string
		var bytes int64
		if err := rows.Scan(&bucket, &dir, &bytes); err != nil {
			s.warn(app, "net history query failed", err)
			return []HistoryBucket{}
		}
		i, ok := index[bucket]
		if !ok {
			i = len(out)
			index[bucket] = i
			out = append(out, HistoryBucket{Bucket: bucket})
		}
		switch dir {
		case "in":
			out[i].In += bytes
		case "out":
			out[i].Out += bytes
		}
	}
	return out
}

func (s *Service) windowSince(ctx context.Context, app, start string) Window {
	var w Window
	err := s.query(ctx, app, `SELECT direction, SUM(bytes) AS bytes
             FROM net_samples WHERE bucket >= ? GROUP BY direction`, start, func(rows *sql.Rows) error {
		var dir string
		var bytes int64
		if err := rows.Scan(&dir, &bytes); err != nil {
			return err
		}
		switch dir {
		case "in":
			w.In += bytes
		case "out":
			w.Out += bytes
		}
		return nil
	})
	if err != nil {
		s.warn(app, "net window query failed", err)
		return Window{}
	}
	w.Total = w.In + w.Out
	return w
}

func (s *Service) sourcesSince(ctx context.Context, app, start string) []SourceRow {
	out := []SourceRow{}
	index := map[string]int{}
	err := s.query(ctx, app, `SELECT source, direction, SUM(bytes) AS bytes
             FROM net_samples WHERE bucket >= ? GROUP BY source, direction`, start, func(rows *sql.Rows) error {
		var src, dir string
		var bytes int64
		if err := rows.Scan(&src, &dir, &bytes); err != nil {
			return err
		}
		i, ok := index[src]
		if !ok {
			i = len(out)
			index[src] = i
			out = append(out, SourceRow{Source: src})
		}
		switch dir {
		case "in":
			out[i].In += bytes
		case "out":
			out[i].Out += bytes
		}
		return nil
	})
	if err != nil {
		s.warn(app, "net sources query failed", err)
		return []SourceRow{}
	}
	// Array#sort is stable: ties keep first-seen order.
	sort.SliceStable(out, func(a, b int) bool { return out[a].In+out[a].Out > out[b].In+out[b].Out })
	return out
}

func (s *Service) query(ctx context.Context, app, q, arg string, scan func(*sql.Rows) error) error {
	db, err := s.appDB(ctx, app)
	if err != nil {
		return err
	}
	rows, err := db.QueryContext(ctx, q, arg)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Service) warn(app, message string, err error) {
	defer func() { _ = recover() }()
	if s.logs == nil {
		return
	}
	meta := map[string]any{"error": err.Error()}
	if app != "" {
		meta["app"] = app
	}
	s.logs.Write("warn", "net-metrics", message, meta)
}
