// Package metrics renders the Prometheus text exposition of the encoder.
package metrics

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
)

type writer struct {
	w    io.Writer
	seen map[string]bool
}

func (m *writer) help(name, typ, help string) {
	if m.seen[name] {
		return
	}
	m.seen[name] = true
	fmt.Fprintf(m.w, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, typ)
}

func (m *writer) val(name string, labels map[string]string, v float64) {
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf(`%s="%s"`, k, esc(labels[k]))
	}
	if len(parts) > 0 {
		fmt.Fprintf(m.w, "%s{%s} %g\n", name, strings.Join(parts, ","), v)
	} else {
		fmt.Fprintf(m.w, "%s %g\n", name, v)
	}
}

func esc(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s)
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// Write renders all metrics.
func Write(w io.Writer, version string, chans []channel.ChannelStatus) {
	m := &writer{w: w, seen: map[string]bool{}}
	m.help("encoderd_build_info", "gauge", "Build information.")
	m.val("encoderd_build_info", map[string]string{"version": version}, 1)
	self := channel.ReadProcStat(os.Getpid())
	m.help("encoderd_process_resident_memory_bytes", "gauge", "encoderd RSS.")
	m.val("encoderd_process_resident_memory_bytes", nil, float64(self.RSSBytes))
	m.help("encoderd_process_cpu_seconds_total", "counter", "encoderd CPU time.")
	m.val("encoderd_process_cpu_seconds_total", nil, self.CPUSecs)
	m.help("encoderd_process_open_fds", "gauge", "encoderd open file descriptors.")
	m.val("encoderd_process_open_fds", nil, float64(self.FDs))

	for _, c := range chans {
		l := map[string]string{"channel": c.ID}
		m.help("encoder_channel_enabled", "gauge", "Channel desired state (1 = should run).")
		m.val("encoder_channel_enabled", l, b2f(c.Enabled))
		m.help("encoder_channel_up", "gauge", "1 when the channel is live (TS flowing).")
		m.val("encoder_channel_up", l, b2f(c.State == channel.StateLive || c.State == channel.StateDegraded))
		m.help("encoder_channel_state", "gauge", "Channel state (one series per state, value 1 for the current one).")
		for _, s := range []string{channel.StateStopped, channel.StateStarting, channel.StateLive, channel.StateDegraded, channel.StateReconnecting, channel.StateError} {
			m.val("encoder_channel_state", map[string]string{"channel": c.ID, "state": s}, b2f(c.State == s))
		}
		m.help("encoder_engine_stalls_total", "counter", "Watchdog restarts (engine running but no TS).")
		m.val("encoder_engine_stalls_total", l, float64(c.Stalls))
		if c.Engine != nil {
			m.help("encoder_engine_restarts_total", "counter", "Engine process restarts.")
			m.val("encoder_engine_restarts_total", l, float64(c.Engine.Restarts))
		}
		if p := c.EngineProc; p != nil {
			m.help("encoder_engine_resident_memory_bytes", "gauge", "Engine process RSS.")
			m.val("encoder_engine_resident_memory_bytes", l, float64(p.RSSBytes))
			m.help("encoder_engine_cpu_seconds_total", "counter", "Engine process CPU time.")
			m.val("encoder_engine_cpu_seconds_total", l, p.CPUSecs)
			m.help("encoder_engine_open_fds", "gauge", "Engine process open fds.")
			m.val("encoder_engine_open_fds", l, float64(p.FDs))
		}
		if s := c.Stats; s != nil {
			m.help("encoder_bitrate_kbps", "gauge", "Transport stream bitrate (last ~5 s).")
			m.val("encoder_bitrate_kbps", l, s.BitrateKbps)
			m.help("encoder_fps", "gauge", "Encoded video frames per second (last ~5 s).")
			m.val("encoder_fps", l, s.FPS)
			m.help("encoder_video_frames_total", "counter", "Encoded video frames.")
			m.val("encoder_video_frames_total", l, float64(s.VideoFrames))
			m.help("encoder_ts_bytes_total", "counter", "Transport stream bytes produced.")
			m.val("encoder_ts_bytes_total", l, float64(s.Bytes))
			m.help("encoder_ts_cc_errors_total", "counter", "MPEG-TS continuity counter errors seen on the internal bus.")
			m.val("encoder_ts_cc_errors_total", l, float64(s.CCErrors))
			m.help("encoder_pcr_drift_ms", "gauge", "PCR clock minus wall clock since the last re-anchor (ms).")
			m.val("encoder_pcr_drift_ms", l, s.PCRDriftMs)
			m.help("encoder_pcr_discontinuities_total", "counter", "PCR jumps (engine restarts, source switches).")
			m.val("encoder_pcr_discontinuities_total", l, float64(s.PCRResets))
		}
		if mo := c.Monitor; mo != nil {
			m.help("encoder_video_luma", "gauge", "Mean luma of the confidence thumbnail (0-255; black < 20).")
			m.val("encoder_video_luma", l, mo.Luma)
			m.help("encoder_video_motion", "gauge", "Mean absolute luma change between thumbnails (freeze < 0.25).")
			m.val("encoder_video_motion", l, mo.Motion)
			if ld := mo.Loudness; ld != nil {
				m.help("encoder_audio_loudness_lufs", "gauge", "EBU R128 loudness of the main track (window=momentary|short_term|integrated).")
				for w, v := range map[string]float64{"momentary": ld.MomentaryLUFS, "short_term": ld.ShortTermLUFS, "integrated": ld.IntegratedLUFS} {
					m.val("encoder_audio_loudness_lufs", map[string]string{"channel": c.ID, "window": w}, v)
				}
				m.help("encoder_audio_loudness_range_lu", "gauge", "EBU Tech 3342 loudness range.")
				m.val("encoder_audio_loudness_range_lu", l, ld.LoudnessRangeLU)
				m.help("encoder_audio_peak_dbfs", "gauge", "Sample peak per audio channel over the last second.")
				for i, p := range ld.SamplePeakDBFS {
					m.val("encoder_audio_peak_dbfs", map[string]string{"channel": c.ID, "ch": fmt.Sprint(i)}, p)
				}
			}
		}
		m.help("encoder_alarm_active", "gauge", "Active alarms (1 per alarm type/output).")
		for _, al := range c.Alarms {
			m.val("encoder_alarm_active", map[string]string{"channel": c.ID, "type": al.Type, "output": al.Output, "severity": al.Severity}, 1)
		}
		if sc := c.SCTE35; sc != nil {
			m.help("encoder_scte35_cues_total", "counter", "SCTE-35 cues inserted.")
			m.val("encoder_scte35_cues_total", l, float64(sc.CuesSent))
		}
		for _, o := range c.Outputs {
			ol := map[string]string{"channel": c.ID, "output": o.ID, "type": o.Type}
			m.help("encoder_output_up", "gauge", "1 when the output process is running.")
			m.val("encoder_output_up", ol, b2f(o.State == "running"))
			if o.Process != nil {
				m.help("encoder_output_restarts_total", "counter", "Output process restarts (reconnects).")
				m.val("encoder_output_restarts_total", ol, float64(o.Process.Restarts))
			}
			if o.Proc != nil {
				m.help("encoder_output_resident_memory_bytes", "gauge", "Output process RSS.")
				m.val("encoder_output_resident_memory_bytes", ol, float64(o.Proc.RSSBytes))
				m.help("encoder_output_cpu_seconds_total", "counter", "Output process CPU time.")
				m.val("encoder_output_cpu_seconds_total", ol, o.Proc.CPUSecs)
			}
			if o.Bus != nil {
				m.help("encoder_output_bus_datagrams_total", "counter", "TS datagrams handed to the output.")
				m.val("encoder_output_bus_datagrams_total", ol, float64(o.Bus.Sent))
				m.help("encoder_output_bus_dropped_total", "counter", "TS datagrams that could not be handed to the output.")
				m.val("encoder_output_bus_dropped_total", ol, float64(o.Bus.Dropped))
			}
		}
	}
}
