package recording

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of app-stats.service.ts: GET /apps/:app/stats, cached 5 s per app.

// AppStats is the per-app operational snapshot.
type RecordingAppStats struct {
	Ts  string `json:"ts"`
	App struct {
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
	} `json:"app"`
	Live any `json:"live"`
	Vods struct {
		Count        int64        `json:"count"`
		TotalBytes   float64      `json:"totalBytes"`
		VodsByStatus VodsByStatus `json:"byStatus"`
	} `json:"vods"`
	Storage struct {
		AppDBBytes int64   `json:"appDbBytes"`
		VodBytes   float64 `json:"vodBytes"`
	} `json:"storage"`
	Ingress struct {
		Total  int64 `json:"total"`
		Active int64 `json:"active"`
	} `json:"ingress"`
	Events24h struct {
		Error int64 `json:"error"`
		Warn  int64 `json:"warn"`
		Info  int64 `json:"info"`
	} `json:"events24h"`
}

const statsTTL = 5 * time.Second

// Stats is the AppStatsService.
type Stats struct {
	s       *Service
	streams Streams
	mu      sync.Mutex
	cache   map[string]statsEntry
}

type statsEntry struct {
	at    time.Time
	value *RecordingAppStats
}

// NewStats builds the stats aggregator.
func NewStats(s *Service, streams Streams) *Stats {
	return &Stats{s: s, streams: streams, cache: map[string]statsEntry{}}
}

// Stats serves a cached (5 s) snapshot.
func (st *Stats) Stats(ctx context.Context, app string) (*RecordingAppStats, error) {
	now := st.s.now()
	st.mu.Lock()
	if e, ok := st.cache[app]; ok && now.Sub(e.at) < statsTTL {
		st.mu.Unlock()
		return e.value, nil
	}
	st.mu.Unlock()
	v, err := st.build(ctx, app)
	if err != nil {
		return nil, err
	}
	st.mu.Lock()
	st.cache[app] = statsEntry{now, v}
	st.mu.Unlock()
	return v, nil
}

func (st *Stats) build(ctx context.Context, app string) (*RecordingAppStats, error) {
	rec, err := st.s.apps.Get(ctx, app)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	var out RecordingAppStats
	if st.streams != nil {
		live, err := st.streams.LiveStats(ctx, app)
		if err != nil {
			return nil, err
		}
		out.Live = live
	}
	sz := st.s.store.AppSizes(ctx, app)
	by, _ := st.s.vods.CountByStatus(ctx, app)
	out.Ts = jsx.ISO(time.Now())
	out.App.Name, out.App.DisplayName = rec.Name, rec.DisplayName
	out.Vods.Count, out.Vods.TotalBytes, out.Vods.VodsByStatus = sz.VodCount, sz.VodTotalBytes, by
	out.Storage.AppDBBytes, out.Storage.VodBytes = sz.DBSizeBytes, sz.VodTotalBytes
	out.Ingress.Total, out.Ingress.Active = st.ingressCounts(ctx, app)
	out.Events24h.Error, out.Events24h.Warn, out.Events24h.Info = st.events24h(ctx, app)
	return &out, nil
}

func (st *Stats) ingressCounts(ctx context.Context, app string) (int64, int64) {
	h, err := st.s.store.App(ctx, app)
	if err != nil {
		return 0, 0
	}
	var total, active int64
	if h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM streams WHERE type IN ('rtmp','whip','rtsp')`).Scan(&total) != nil {
		return 0, 0
	}
	if h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM streams WHERE type IN ('rtmp','whip','rtsp') AND status = 'active'`).Scan(&active) != nil {
		return 0, 0
	}
	return total, active
}

func (st *Stats) events24h(ctx context.Context, app string) (errs, warns, infos int64) {
	g, err := st.s.store.Global(ctx)
	if err != nil {
		return
	}
	since := jsx.ISO(time.Now().Add(-24 * time.Hour))
	rows, err := g.QueryContext(ctx, `SELECT level, COUNT(*) AS n FROM server_logs
             WHERE app_id = (SELECT id FROM apps WHERE name = ?) AND ts >= ?
             GROUP BY level`, app, since)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var lvl *string
		var n int64
		if rows.Scan(&lvl, &n) != nil {
			continue
		}
		l := ""
		if lvl != nil {
			l = strings.ToLower(*lvl)
		}
		switch l {
		case "error", "fatal":
			errs += n
		case "warn", "warning":
			warns += n
		case "info":
			infos += n
		}
	}
	return
}
