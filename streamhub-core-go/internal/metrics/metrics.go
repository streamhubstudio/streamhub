// Package metrics is the Prometheus facade (modules/metrics): one registry
// with the event counters the business modules increment in-line, the
// DB-derived gauges refreshed at scrape time, the root /metrics endpoint and
// the request interceptor.
//
// Every streamhub_* name, type, label set and help text is identical to the
// Node core (dashboards and alert rules depend on them). Node's default
// nodejs_* metrics cannot exist in Go; the Go runtime (go_*) and process
// (process_*) collectors take their place.
//
// All event hooks are nil-safe: a module holding a nil *Service no-ops,
// exactly like Node's @Optional() MetricsService.
package metrics

import (
	"bytes"
	"context"
	"database/sql"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/common/expfmt"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
)

const prefix = "streamhub_"

// ContentType is what Node answers (prom-client's type after Express moved
// the charset first).
const ContentType = "text/plain; charset=utf-8; version=0.0.4"

// httpBuckets are tuned for a management API plus a few slow media ops.
var httpBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

var (
	quotaMetrics = []string{"maxApps", "maxConcurrentStreams", "maxRecordingMinutesMonth", "maxEgressGbMonth", "maxStorageGb"}
	usageMetrics = []string{"apps", "concurrentStreams", "recordingMinutesMonth", "egressGbMonth", "storageGb"}
)

// UsageSource is the quotas surface the tenant gauges read (optional).
type UsageSource interface {
	GetUsage(ctx context.Context, tenantID string) quotas.UsageReport
}

// AppDBs opens a per-app DB (db.Service.App).
type AppDBs func(ctx context.Context, app string) (*sql.DB, error)

// Deps are the service's inputs.
type Deps struct {
	Global  *sql.DB
	AppDB   AppDBs
	DataDir string
	Quotas  UsageSource // nil → no tenant quota/usage gauges
	Env     func(string) string
	Log     *slog.Logger
	// Now is injectable for tests (default time.Now).
	Now func() time.Time
}

// Service owns the registry.
type Service struct {
	d        Deps
	Registry *prometheus.Registry

	httpRequests *prometheus.CounterVec
	httpDuration *prometheus.HistogramVec
	httpInFlight prometheus.Gauge

	activeStreams *prometheus.GaugeVec
	streamViewers *prometheus.GaugeVec
	streamEvents  *prometheus.CounterVec

	recordingsStarted *prometheus.CounterVec
	vodsGenerated     *prometheus.CounterVec
	recordingFailures *prometheus.CounterVec
	uploadQueueDepth  *prometheus.GaugeVec
	vodsByStatus      *prometheus.GaugeVec

	s3Uploads     *prometheus.CounterVec
	s3UploadBytes *prometheus.CounterVec
	s3Errors      *prometheus.CounterVec

	callbacks *prometheus.CounterVec

	tenantQuota *prometheus.GaugeVec
	tenantUsage *prometheus.GaugeVec
	appsTotal   *prometheus.GaugeVec

	clusterNodeUp            *prometheus.GaugeVec
	clusterNodeCPURatio      *prometheus.GaugeVec
	clusterNodeMemUsedRatio  *prometheus.GaugeVec
	clusterNodeDiskUsedRatio *prometheus.GaugeVec
	clusterNodeGPU           *prometheus.GaugeVec
	clusterNodeVramFreeMb    *prometheus.GaugeVec
	clusterNodeWeight        *prometheus.GaugeVec
	edgeAssignments          *prometheus.GaugeVec
	edgePendingAssignments   prometheus.Gauge
	edgeEligibleNodes        *prometheus.GaugeVec

	errors *prometheus.CounterVec

	mediaTranscode *prometheus.CounterVec
	gpuAvailable   *prometheus.GaugeVec
}

// New builds the registry. METRICS_DEFAULT_METRICS=off drops the runtime
// collectors (Node: collectDefaultMetrics).
func New(d Deps) *Service {
	if d.Env == nil {
		d.Env = os.Getenv
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	s := &Service{d: d, Registry: prometheus.NewRegistry()}
	r := s.Registry
	if d.Env("METRICS_DEFAULT_METRICS") != "off" {
		r.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	}

	counter := func(name, help string, labels ...string) *prometheus.CounterVec {
		c := prometheus.NewCounterVec(prometheus.CounterOpts{Name: prefix + name, Help: help}, labels)
		r.MustRegister(c)
		return c
	}
	gauge := func(name, help string, labels ...string) *prometheus.GaugeVec {
		g := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: prefix + name, Help: help}, labels)
		r.MustRegister(g)
		return g
	}
	scalar := func(name, help string) prometheus.Gauge {
		g := prometheus.NewGauge(prometheus.GaugeOpts{Name: prefix + name, Help: help})
		r.MustRegister(g)
		return g
	}

	s.httpRequests = counter("http_requests_total", "Total HTTP requests handled by streamhub-core.", "method", "route", "status")
	s.httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: prefix + "http_request_duration_seconds", Help: "HTTP request latency in seconds.", Buckets: httpBuckets,
	}, []string{"method", "route", "status"})
	r.MustRegister(s.httpDuration)
	s.httpInFlight = scalar("http_requests_in_flight", "HTTP requests currently being processed.")

	s.activeStreams = gauge("active_streams", "Currently active (live) streams, by app.", "app")
	s.streamViewers = gauge("stream_viewers", "Last observed subscriber (viewer) count for a live stream.", "app", "room")
	s.streamEvents = counter("stream_events_total", "Stream lifecycle events (stop, snapshot).", "app", "event")

	s.recordingsStarted = counter("recordings_started_total", "Recording sessions started.", "app")
	s.vodsGenerated = counter("vods_generated_total", "VODs successfully uploaded and marked ready.", "app")
	s.recordingFailures = counter("recording_failures_total", "Recording/upload flow failures, by reason.", "app", "reason")
	s.uploadQueueDepth = gauge("upload_queue_depth", "VODs pending upload (status recording|uploading), by app.", "app")
	s.vodsByStatus = gauge("vods", "VOD rows by status, by app.", "app", "status")

	s.s3Uploads = counter("s3_uploads_total", "S3 object uploads, by provider and result (ok|fail).", "provider", "result")
	s.s3UploadBytes = counter("s3_upload_bytes_total", "Total bytes uploaded to S3, by provider.", "provider")
	s.s3Errors = counter("s3_errors_total", "S3 operation errors, by op (upload|presign|delete|exists).", "op")

	s.callbacks = counter("callbacks_total", "Outbound app callbacks, by event and result (delivered|failed|dropped).", "app", "event", "result")

	s.tenantQuota = gauge("tenant_quota", "Configured quota limit per tenant and metric (-1 = unlimited).", "tenant", "metric")
	s.tenantUsage = gauge("tenant_usage", "Current consumption per tenant and metric.", "tenant", "metric")
	s.appsTotal = gauge("apps", "Registered apps, by tenant.", "tenant")

	s.clusterNodeUp = gauge("cluster_node_up", "Whether a cluster node is up (last heartbeat within the stale window), by node and type.", "node", "type")
	s.clusterNodeCPURatio = gauge("cluster_node_cpu_ratio", "Node CPU load ratio (load1/cores) from its last telemetry blob.", "node")
	s.clusterNodeMemUsedRatio = gauge("cluster_node_mem_used_ratio", "Node used-memory ratio (0..1) from its last telemetry blob.", "node")
	s.clusterNodeDiskUsedRatio = gauge("cluster_node_disk_used_ratio", "Node used-disk ratio (0..1) from its last telemetry blob.", "node")
	s.clusterNodeGPU = gauge("cluster_node_gpu", "Whether the node advertises a usable GPU (1/0).", "node")
	s.clusterNodeVramFreeMb = gauge("cluster_node_vram_free_mb", "Node free VRAM in MB (advertised GPU nodes only).", "node")
	s.clusterNodeWeight = gauge("cluster_node_weight", "Node scheduling weight (share for the weighted policy).", "node")
	s.edgeAssignments = gauge("edge_assignments", "Edge worker assignments by lifecycle status.", "status")
	s.edgePendingAssignments = scalar("edge_pending_assignments", "Edge assignments parked pending (no eligible node).")
	s.edgeEligibleNodes = gauge("edge_eligible_nodes", "Up + active placeable nodes the scheduler could take work on, split by GPU.", "gpu")

	s.errors = counter("errors_total", "Errors surfaced to clients, by source and code.", "source", "code")

	s.mediaTranscode = counter("media_transcode_total", "Media pipeline ops by kind (egress|ingress), accel (gpu|cpu) and GPU type.", "kind", "accel", "type")
	s.gpuAvailable = gauge("gpu_available", "Whether the node has a usable hardware-transcoding GPU (1/0), by type.", "type")
	return s
}

// ===========================================================================
// Event hooks (interceptor + business services). Nil-safe.
// ===========================================================================

// HTTPStart marks a request in flight.
func (s *Service) HTTPStart() {
	if s != nil {
		s.httpInFlight.Inc()
	}
}

// ObserveHTTP records a finished request.
func (s *Service) ObserveHTTP(method, route string, status int, durationSeconds float64) {
	if s == nil {
		return
	}
	code := strconv.Itoa(status)
	s.httpRequests.WithLabelValues(method, route, code).Inc()
	s.httpDuration.WithLabelValues(method, route, code).Observe(durationSeconds)
	s.httpInFlight.Dec()
	if status >= 500 {
		s.errors.WithLabelValues("http", code).Inc()
	}
}

// StreamStopped: a stream was explicitly stopped.
func (s *Service) StreamStopped(app string) {
	if s != nil {
		s.streamEvents.WithLabelValues(app, "stopped").Inc()
	}
}

// SnapshotTaken: a snapshot was captured for an app.
func (s *Service) SnapshotTaken(app string) {
	if s != nil {
		s.streamEvents.WithLabelValues(app, "snapshot").Inc()
	}
}

// SetViewers is the best-effort live viewer count of a room.
func (s *Service) SetViewers(app, room string, viewers float64) {
	if s != nil && !isNaNOrInf(viewers) {
		s.streamViewers.WithLabelValues(app, room).Set(viewers)
	}
}

// RecordingStarted counts a started recording session.
func (s *Service) RecordingStarted(app string) {
	if s != nil {
		s.recordingsStarted.WithLabelValues(app).Inc()
	}
}

// VodGenerated counts a VOD uploaded and marked ready.
func (s *Service) VodGenerated(app string) {
	if s != nil {
		s.vodsGenerated.WithLabelValues(app).Inc()
	}
}

// RecordingFailed counts a recording/upload failure ("" → unknown).
func (s *Service) RecordingFailed(app, reason string) {
	if s == nil {
		return
	}
	if reason == "" {
		reason = "unknown"
	}
	s.recordingFailures.WithLabelValues(app, reason).Inc()
}

// S3Upload counts an upload (bytes only on success).
func (s *Service) S3Upload(provider string, ok bool, bytes float64) {
	if s == nil {
		return
	}
	if provider == "" {
		provider = "unknown"
	}
	result := "fail"
	if ok {
		result = "ok"
	}
	s.s3Uploads.WithLabelValues(provider, result).Inc()
	if ok && bytes > 0 {
		s.s3UploadBytes.WithLabelValues(provider).Add(bytes)
	}
	if !ok {
		s.s3Errors.WithLabelValues("upload").Inc()
	}
}

// S3Error counts a failed S3 op ("" → unknown).
func (s *Service) S3Error(op string) {
	if s == nil {
		return
	}
	if op == "" {
		op = "unknown"
	}
	s.s3Errors.WithLabelValues(op).Inc()
}

// CallbackResult counts an outbound callback: delivered | failed | dropped.
func (s *Service) CallbackResult(app, event, result string) {
	if s != nil {
		s.callbacks.WithLabelValues(app, event, result).Inc()
	}
}

// RecordTranscode records the acceleration path of a media op.
func (s *Service) RecordTranscode(kind, accel, typ string) {
	if s == nil {
		return
	}
	if typ == "" {
		typ = "none"
	}
	s.mediaTranscode.WithLabelValues(kind, accel, typ).Inc()
}

// SetGPUAvailable publishes the node's GPU status: exactly one type at 1.
func (s *Service) SetGPUAvailable(available bool, typ string) {
	if s == nil {
		return
	}
	for _, t := range []string{"nvidia", "vaapi", "none"} {
		s.gpuAvailable.WithLabelValues(t).Set(0)
	}
	v := 0.0
	if available && typ != "none" {
		v = 1
	}
	s.gpuAvailable.WithLabelValues(typ).Set(v)
	if !available || typ == "none" {
		s.gpuAvailable.WithLabelValues("none").Set(1)
	}
}

// ===========================================================================
// Scrape
// ===========================================================================

// Scrape renders the text exposition format, refreshing the DB gauges first.
func (s *Service) Scrape(ctx context.Context) ([]byte, error) {
	s.refreshDBGauges(ctx)
	s.refreshClusterGauges(ctx)
	mfs, err := s.Registry.Gather()
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := expfmt.NewEncoder(&buf, expfmt.NewFormat(expfmt.TypeTextPlain))
	for _, mf := range mfs {
		if err := enc.Encode(mf); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

type appRow struct {
	name   string
	tenant *string
}

// refreshDBGauges recomputes the gauges mirroring durable SQLite state.
// Fully defensive: failures are logged at debug and skipped.
func (s *Service) refreshDBGauges(ctx context.Context) {
	for _, g := range []*prometheus.GaugeVec{s.activeStreams, s.streamViewers, s.uploadQueueDepth, s.vodsByStatus, s.appsTotal, s.tenantQuota, s.tenantUsage} {
		g.Reset()
	}
	apps, err := s.listApps(ctx)
	if err != nil {
		s.d.Log.Debug("metrics: listApps failed: " + err.Error())
		return
	}
	perTenant := map[string]float64{}
	var tenants []string
	for _, a := range apps {
		tenant := "unknown"
		if a.tenant != nil {
			tenant = *a.tenant
		}
		if _, seen := perTenant[tenant]; !seen {
			tenants = append(tenants, tenant)
		}
		perTenant[tenant]++
		if !s.appDBExists(a.name) {
			s.activeStreams.WithLabelValues(a.name).Set(0)
			continue
		}
		if err := s.appGauges(ctx, a.name); err != nil {
			s.d.Log.Debug("metrics: app '" + a.name + "' gauges failed: " + err.Error())
		}
	}
	for _, t := range tenants {
		s.appsTotal.WithLabelValues(t).Set(perTenant[t])
	}
	if s.d.Quotas == nil {
		return
	}
	for _, t := range tenants {
		if t == "unknown" {
			continue
		}
		s.tenantGauges(ctx, t)
	}
}

func (s *Service) appGauges(ctx context.Context, app string) error {
	adb, err := s.d.AppDB(ctx, app)
	if err != nil {
		return err
	}
	var active float64
	if err := adb.QueryRowContext(ctx, "SELECT COUNT(*) AS n FROM streams WHERE status = 'active'").Scan(&active); err != nil {
		return err
	}
	s.activeStreams.WithLabelValues(app).Set(active)
	rows, err := adb.QueryContext(ctx, "SELECT status, COUNT(*) AS n FROM vods GROUP BY status")
	if err != nil {
		return err
	}
	defer rows.Close()
	var backlog float64
	for rows.Next() {
		var status sql.NullString
		var n float64
		if err := rows.Scan(&status, &n); err != nil {
			return err
		}
		label := status.String
		if !status.Valid {
			label = "null" // prom-client stringifies a null label value
		}
		s.vodsByStatus.WithLabelValues(app, label).Set(n)
		if status.String == "recording" || status.String == "uploading" {
			backlog += n
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.uploadQueueDepth.WithLabelValues(app).Set(backlog)
	return nil
}

func (s *Service) tenantGauges(ctx context.Context, tenant string) {
	defer func() {
		if r := recover(); r != nil {
			s.d.Log.Debug("metrics: quota usage for '" + tenant + "' failed")
		}
	}()
	rep := s.d.Quotas.GetUsage(ctx, tenant)
	q := []float64{float64(rep.Quotas.MaxApps), float64(rep.Quotas.MaxConcurrentStreams), float64(rep.Quotas.MaxRecordingMinutesMonth), float64(rep.Quotas.MaxEgressGBMonth), float64(rep.Quotas.MaxStorageGB)}
	u := []float64{float64(rep.Usage.Apps), float64(rep.Usage.ConcurrentStreams), rep.Usage.RecordingMinutesMonth, rep.Usage.EgressGBMonth, rep.Usage.StorageGB}
	for i, m := range quotaMetrics {
		s.tenantQuota.WithLabelValues(tenant, m).Set(q[i])
	}
	for i, m := range usageMetrics {
		s.tenantUsage.WithLabelValues(tenant, m).Set(u[i])
	}
}

// refreshClusterGauges re-exports the edge nodes' telemetry (they sit behind
// NAT; the master is the only place it lives).
func (s *Service) refreshClusterGauges(ctx context.Context) {
	for _, g := range []*prometheus.GaugeVec{s.clusterNodeUp, s.clusterNodeCPURatio, s.clusterNodeMemUsedRatio, s.clusterNodeDiskUsedRatio, s.clusterNodeGPU, s.clusterNodeVramFreeMb, s.clusterNodeWeight, s.edgeAssignments, s.edgeEligibleNodes} {
		g.Reset()
	}
	// Pending is a scalar the "no capacity" alert reads — always a number.
	s.edgePendingAssignments.Set(0)

	if nodes, err := s.nodeRows(ctx); err != nil {
		s.d.Log.Debug("metrics: cluster node gauges failed: " + err.Error())
	} else {
		now := s.d.Now()
		ms := make([]NodeMetrics, 0, len(nodes))
		for _, r := range nodes {
			m := ProjectNode(r, now)
			ms = append(ms, m)
			s.clusterNodeUp.WithLabelValues(m.Node, m.Type).Set(m.Up)
			s.clusterNodeGPU.WithLabelValues(m.Node).Set(m.GPU)
			s.clusterNodeWeight.WithLabelValues(m.Node).Set(m.Weight)
			setIf(s.clusterNodeCPURatio, m.Node, m.CPURatio)
			setIf(s.clusterNodeMemUsedRatio, m.Node, m.MemUsedRatio)
			setIf(s.clusterNodeDiskUsedRatio, m.Node, m.DiskUsedRatio)
			setIf(s.clusterNodeVramFreeMb, m.Node, m.VramFreeMb)
		}
		e := Eligible(ms, s.allowCommonNodes())
		s.edgeEligibleNodes.WithLabelValues("true").Set(float64(e.GPUTrue))
		s.edgeEligibleNodes.WithLabelValues("false").Set(float64(e.GPUFalse))
	}

	statuses, err := s.assignmentStatuses(ctx)
	if err != nil {
		s.d.Log.Debug("metrics: edge assignment gauges failed: " + err.Error())
		return
	}
	byStatus, pending := AssignmentCounts(statuses)
	for st, n := range byStatus {
		s.edgeAssignments.WithLabelValues(st).Set(float64(n))
	}
	s.edgePendingAssignments.Set(float64(pending))
}

func setIf(g *prometheus.GaugeVec, node string, v *float64) {
	if v != nil {
		g.WithLabelValues(node).Set(*v)
	}
}

func (s *Service) nodeRows(ctx context.Context) ([]RawNodeRow, error) {
	rows, err := s.d.Global.QueryContext(ctx, "SELECT name, type, weight, status, last_seen_at, stats_json FROM nodes")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RawNodeRow
	for rows.Next() {
		var r RawNodeRow
		var name, typ, last, stats, status sql.NullString
		var weight sql.NullFloat64
		if err := rows.Scan(&name, &typ, &weight, &status, &last, &stats); err != nil {
			return nil, err
		}
		r.Name = name.String
		if !name.Valid {
			r.Name = "null" // prom-client stringifies a null label value
		}
		r.Status = status.String
		if typ.Valid {
			r.Type = &typ.String
		}
		if weight.Valid {
			r.Weight = &weight.Float64
		}
		if last.Valid {
			r.LastSeenAt = &last.String
		}
		if stats.Valid {
			r.StatsJSON = &stats.String
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) assignmentStatuses(ctx context.Context) ([]string, error) {
	rows, err := s.d.Global.QueryContext(ctx, "SELECT status FROM edge_assignments")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var st sql.NullString
		if err := rows.Scan(&st); err != nil {
			return nil, err
		}
		out = append(out, st.String)
	}
	return out, rows.Err()
}

// allowCommonNodes is STREAMHUB_EDGE_ALLOW_COMMON.
func (s *Service) allowCommonNodes() bool {
	switch strings.ToLower(strings.TrimSpace(s.d.Env("STREAMHUB_EDGE_ALLOW_COMMON"))) {
	case "1", "true", "on", "yes":
		return true
	}
	return false
}

// listApps reads the registry, tolerating a missing tenant_id column.
func (s *Service) listApps(ctx context.Context) ([]appRow, error) {
	rows, err := s.d.Global.QueryContext(ctx, "SELECT name, tenant_id FROM apps")
	withTenant := err == nil
	if err != nil {
		if rows, err = s.d.Global.QueryContext(ctx, "SELECT name FROM apps"); err != nil {
			return nil, err
		}
	}
	defer rows.Close()
	var out []appRow
	for rows.Next() {
		var a appRow
		var tenant sql.NullString
		if withTenant {
			err = rows.Scan(&a.name, &tenant)
		} else {
			err = rows.Scan(&a.name)
		}
		if err != nil {
			return nil, err
		}
		if tenant.Valid {
			a.tenant = &tenant.String
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) appDBExists(app string) bool {
	_, err := os.Stat(filepath.Join(s.d.DataDir, "apps", app, "app.db"))
	return err == nil
}

func isNaNOrInf(f float64) bool { return math.IsNaN(f) || math.IsInf(f, 0) }
