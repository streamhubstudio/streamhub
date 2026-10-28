package livekit

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
)

// GET /api/v1/stats — HealthService.stats(): host CPU/mem/disk, LiveKit
// reachability, app/room/active-stream counts, egress/ingress status and
// the DB/VOD storage footprint. Never fails: every probe degrades.

// DiskStats is the data-dir filesystem usage.
type DiskStats struct {
	TotalBytes int64 `json:"totalBytes"`
	FreeBytes  int64 `json:"freeBytes"`
	UsedBytes  int64 `json:"usedBytes"`
}

// EndpointStatus is one LiveKit service's reachability + session counts.
type EndpointStatus struct {
	Reachable bool `json:"reachable"`
	Active    int  `json:"active"`
	Total     int  `json:"total"`
}

// StorageStats is the DB + VOD footprint.
type StorageStats struct {
	DBSizeBytes      int64   `json:"dbSizeBytes"`
	AppsDBSizeBytes  int64   `json:"appsDbSizeBytes"`
	TotalDBSizeBytes int64   `json:"totalDbSizeBytes"`
	VodTotalBytes    float64 `json:"vodTotalBytes"`
	VodCount         int64   `json:"vodCount"`
}

// ServerStats is the /stats body.
type ServerStats struct {
	Ts            string `json:"ts"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	Version       string `json:"version"`
	CPU           struct {
		LoadAvg []float64 `json:"loadAvg"`
		Cores   int       `json:"cores"`
	} `json:"cpu"`
	Memory struct {
		TotalBytes int64 `json:"totalBytes"`
		FreeBytes  int64 `json:"freeBytes"`
		UsedBytes  int64 `json:"usedBytes"`
	} `json:"memory"`
	Disk             *DiskStats `json:"disk"`
	LivekitReachable bool       `json:"livekitReachable"`
	Counts           struct {
		Apps          int64 `json:"apps"`
		Rooms         int   `json:"rooms"`
		ActiveStreams int64 `json:"activeStreams"`
	} `json:"counts"`
	Egress  EndpointStatus `json:"egress"`
	Ingress EndpointStatus `json:"ingress"`
	Storage StorageStats   `json:"storage"`
}

type statsSource struct {
	cfg       *config.Config
	store     *db.Service
	clients   *Clients // nil when LiveKit is not configured
	log       *slog.Logger
	startedAt time.Time
}

func newStatsSource(cfg *config.Config, store *db.Service, c Clients, log *slog.Logger) *statsSource {
	s := &statsSource{cfg: cfg, store: store, log: log, startedAt: time.Now()}
	// Only build clients when minimally configured (else: unreachable).
	if HTTPURL(cfg.LivekitURL) != "" && cfg.LivekitAPIKey != "" && cfg.LivekitAPISecret != "" {
		s.clients = &c
	}
	return s
}

// Stats collects the /stats payload.
func (s *statsSource) Stats(ctx context.Context) ServerStats {
	var (
		wg              sync.WaitGroup
		rooms           *int
		egress, ingress EndpointStatus
	)
	wg.Add(3)
	go func() { defer wg.Done(); rooms = s.roomCount(ctx) }()
	go func() { defer wg.Done(); egress = s.egressStatus(ctx) }()
	go func() { defer wg.Done(); ingress = s.ingressStatus(ctx) }()
	wg.Wait()

	var out ServerStats
	out.Ts = jsx.ISO(time.Now())
	out.UptimeSeconds = int64(time.Since(s.startedAt) / time.Second)
	out.Version = version.Get()
	out.CPU.LoadAvg = loadAvg()
	out.CPU.Cores = runtime.NumCPU()
	total, free := memory()
	out.Memory.TotalBytes, out.Memory.FreeBytes, out.Memory.UsedBytes = total, free, total-free
	out.Disk = diskStats(s.cfg.DataDir)
	out.LivekitReachable = rooms != nil
	out.Counts.Apps, out.Counts.ActiveStreams = s.dbCounts(ctx)
	if rooms != nil {
		out.Counts.Rooms = *rooms
	}
	out.Egress, out.Ingress = egress, ingress
	sz := s.store.ServerSizes(ctx)
	out.Storage = StorageStats{sz.DBSizeBytes, sz.AppsDBSizeBytes, sz.TotalDBSizeBytes, sz.VodTotalBytes, sz.VodCount}
	return out
}

func (s *statsSource) roomCount(ctx context.Context) *int {
	if s.clients == nil {
		return nil
	}
	res, err := s.clients.Room.ListRooms(ctx, &livekit.ListRoomsRequest{Names: []string{}})
	if err != nil {
		s.log.Debug("listRooms failed: " + err.Error())
		return nil
	}
	n := len(res.GetRooms())
	return &n
}

func (s *statsSource) egressStatus(ctx context.Context) EndpointStatus {
	if s.clients == nil {
		return EndpointStatus{}
	}
	res, err := s.clients.Egress.ListEgress(ctx, &livekit.ListEgressRequest{})
	if err != nil {
		s.log.Debug("listEgress failed: " + err.Error())
		return EndpointStatus{}
	}
	active := 0
	for _, e := range res.GetItems() {
		switch e.GetStatus() {
		case livekit.EgressStatus_EGRESS_STARTING, livekit.EgressStatus_EGRESS_ACTIVE, livekit.EgressStatus_EGRESS_ENDING:
			active++
		}
	}
	return EndpointStatus{true, active, len(res.GetItems())}
}

func (s *statsSource) ingressStatus(ctx context.Context) EndpointStatus {
	if s.clients == nil {
		return EndpointStatus{}
	}
	res, err := s.clients.Ingress.ListIngress(ctx, &livekit.ListIngressRequest{})
	if err != nil {
		s.log.Debug("listIngress failed: " + err.Error())
		return EndpointStatus{}
	}
	active := 0
	for _, i := range res.GetItems() {
		if i.GetState().GetStatus() == livekit.IngressState_ENDPOINT_PUBLISHING {
			active++
		}
	}
	return EndpointStatus{true, active, len(res.GetItems())}
}

// dbCounts: app count + active streams across every app.db.
func (s *statsSource) dbCounts(ctx context.Context) (apps, active int64) {
	g, err := s.store.Global(ctx)
	if err != nil {
		return 0, 0
	}
	rows, err := g.QueryContext(ctx, `SELECT name FROM apps`)
	if err != nil {
		s.log.Warn("db counts failed: " + err.Error())
		return 0, 0
	}
	var names []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			names = append(names, n)
		}
	}
	rows.Close()
	apps = int64(len(names))
	for _, n := range names {
		h, err := s.store.App(ctx, n)
		if err != nil {
			continue
		}
		var c sql.NullInt64
		if err := h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM streams WHERE status = 'active'`).Scan(&c); err == nil {
			active += c.Int64
		}
	}
	return apps, active
}

type statsOut struct{ Body ServerStats }

func (m *Module) registerStats(a huma.API) {
	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "HealthController_getStats", Method: http.MethodGet, Path: api.Prefix + "/stats",
		Summary:     "Server stats (auth)",
		Description: "CPU/mem/disk, uptime, version, LiveKit reachability, counts of apps/rooms/active streams, and egress/ingress status.",
		Tags:        []string{"health"},
	}), func(ctx context.Context, _ *struct{}) (*statsOut, error) {
		return &statsOut{Body: m.stats.Stats(ctx)}, nil
	})
}
