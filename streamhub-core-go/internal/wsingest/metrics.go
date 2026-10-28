package wsingest

import "github.com/prometheus/client_golang/prometheus"

// Metrics are the Prometheus series of the gateway (ws-ingest.metrics.ts),
// registered on the central /metrics registry. A nil registerer creates
// unregistered collectors (bare tests) — every hook stays a harmless no-op.
type Metrics struct {
	cameras *prometheus.GaugeVec
	frames  prometheus.Counter
	bytes   prometheus.Counter
	dropped *prometheus.CounterVec
	viewers *prometheus.GaugeVec
}

// NewMetrics builds (and registers, when reg != nil) the collectors.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		cameras: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "streamhub_ws_ingest_cameras",
			Help: "Live ws-mjpeg cameras connected to the ingest gateway, by app.",
		}, []string{"app"}),
		frames: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "streamhub_ws_ingest_frames_total",
			Help: "JPEG frames accepted from ws-mjpeg cameras.",
		}),
		bytes: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "streamhub_ws_ingest_bytes_total",
			Help: "Bytes of JPEG frames accepted from ws-mjpeg cameras.",
		}),
		dropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "streamhub_ws_ingest_dropped_frames_total",
			Help: "Frames dropped by the gateway, by reason (fps|too_large|not_jpeg|data_too_large|data_rate).",
		}, []string{"reason"}),
		viewers: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "streamhub_ws_ingest_viewers",
			Help: "Connected MJPEG viewers, by app and kind (ws|http).",
		}, []string{"app", "kind"}),
	}
	if reg != nil {
		for _, c := range []prometheus.Collector{m.cameras, m.frames, m.bytes, m.dropped, m.viewers} {
			_ = reg.Register(c)
		}
	}
	return m
}

// SetCameras sets the live camera gauge of an app.
func (m *Metrics) SetCameras(app string, n int) { m.cameras.WithLabelValues(app).Set(float64(n)) }

// Frame counts one accepted frame.
func (m *Metrics) Frame(bytes int) {
	m.frames.Inc()
	if bytes > 0 {
		m.bytes.Add(float64(bytes))
	}
}

// DroppedFrame counts one dropped frame by reason.
func (m *Metrics) DroppedFrame(reason string) { m.dropped.WithLabelValues(reason).Inc() }

// SetViewers sets the viewer gauge of an app/kind.
func (m *Metrics) SetViewers(app, kind string, n int) {
	m.viewers.WithLabelValues(app, kind).Set(float64(n))
}
