package system

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
)

// HwaccelMode is auto | gpu | cpu.
type HwaccelMode = string

// sidecar is apps/<app>/transcoding.json, owned by this service.
const sidecar = "transcoding.json"

func validMode(m string) bool { return m == "auto" || m == "gpu" || m == "cpu" }

// HwaccelDecision is an app preference resolved against the live GPU.
type HwaccelDecision struct {
	Requested HwaccelMode `json:"requested"`
	Effective string      `json:"effective"` // gpu | cpu
	Type      GpuType     `json:"type"`
	Reason    string      `json:"reason"`
}

// EgressEncoding is the explicit H.264 EncodingOptions attached when GPU is
// chosen (the LiveKit port maps it onto livekit.EncodingOptions:
// H264_MAIN).
type EgressEncoding struct {
	Width           int
	Height          int
	Framerate       int
	VideoBitrate    int
	KeyFrameSeconds float64
}

// IngressPreset is the ingress video preset attached when GPU is chosen
// (TrackSource.CAMERA + IngressVideoEncodingPreset.H264_720P_30FPS_3_LAYERS).
const IngressPreset = "H264_720P_30FPS_3_LAYERS"

// TranscodeMetrics records which path a media op used (recordTranscode).
type TranscodeMetrics interface {
	RecordTranscode(kind, effective string, typ GpuType)
}

// HwAccel is HwAccelService: per-app sidecar preference + resolution +
// SDK-option decisions. Every method degrades to CPU.
type HwAccel struct {
	cfg     *config.Config
	gpu     *Gpu
	logs    Logger
	metrics TranscodeMetrics // optional
}

// NewHwAccel builds the resolver.
func NewHwAccel(cfg *config.Config, gpu *Gpu, logs Logger) *HwAccel {
	return &HwAccel{cfg: cfg, gpu: gpu, logs: logs}
}

// SetMetrics late-binds the transcode counter.
func (h *HwAccel) SetMetrics(m TranscodeMetrics) { h.metrics = m }

// DefaultMode is TRANSCODING_HWACCEL (validated) or auto.
func (h *HwAccel) DefaultMode() HwaccelMode {
	if raw := strings.ToLower(h.cfg.Env("TRANSCODING_HWACCEL")); validMode(raw) {
		return raw
	}
	return "auto"
}

func (h *HwAccel) sidecarPath(app string) string {
	return filepath.Join(h.cfg.DataDir, "apps", app, sidecar)
}

// GetMode reads the app's mode (missing/invalid sidecar → default).
func (h *HwAccel) GetMode(app string) HwaccelMode {
	if raw, err := os.ReadFile(h.sidecarPath(app)); err == nil {
		var parsed struct {
			Hwaccel any `json:"hwaccel"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			if s, ok := parsed.Hwaccel.(string); ok && validMode(strings.ToLower(s)) {
				return strings.ToLower(s)
			}
		}
	}
	return h.DefaultMode()
}

type modeMeta struct {
	App   string `json:"app"`
	Mode  string `json:"mode"`
	Error string `json:"error"`
}

// SetMode persists the app's mode ({"hwaccel": mode}, 2-space JSON).
func (h *HwAccel) SetMode(app string, mode HwaccelMode) (HwaccelMode, error) {
	if !validMode(mode) {
		return "", fmt.Errorf("invalid hwaccel mode %q", mode)
	}
	file := h.sidecarPath(app)
	err := os.MkdirAll(filepath.Dir(file), 0o775)
	if err == nil {
		err = os.WriteFile(file, []byte("{\n  \"hwaccel\": \""+mode+"\"\n}"), 0o644)
	}
	if err != nil {
		h.logs.Write("warn", "transcoding", "could not persist hwaccel mode", modeMeta{app, mode, err.Error()}, nil)
	}
	return mode, nil
}

// Resolve is the effective gpu/cpu decision for app.
func (h *HwAccel) Resolve(ctx context.Context, app string) HwaccelDecision {
	requested := h.GetMode(app)
	if requested == "cpu" {
		return HwaccelDecision{requested, "cpu", "none", "app configured hwaccel=cpu"}
	}
	gpu := h.gpu.Status(ctx)
	if gpu.Available {
		reason := "hwaccel=auto resolved to " + gpu.Type + " GPU"
		if requested == "gpu" {
			reason = "hwaccel=gpu and " + gpu.Type + " GPU available"
		}
		return HwaccelDecision{requested, "gpu", gpu.Type, reason}
	}
	reason := "hwaccel=auto and no GPU detected — CPU"
	if requested == "gpu" {
		reason = "hwaccel=gpu but no GPU detected — CPU fallback"
	}
	return HwaccelDecision{requested, "cpu", "none", reason}
}

// EgressOptions: explicit H.264 720p30 options when GPU is chosen, nil on
// CPU (today's default behaviour).
func (h *HwAccel) EgressOptions(ctx context.Context, app string) (*EgressEncoding, HwaccelDecision) {
	d := h.Resolve(ctx, app)
	if d.Effective != "gpu" {
		return nil, d
	}
	return &EgressEncoding{Width: 1280, Height: 720, Framerate: 30, VideoBitrate: 3000, KeyFrameSeconds: 2}, d
}

// IngressOptions: the simulcast preset name when GPU is chosen, "" on CPU.
func (h *HwAccel) IngressOptions(ctx context.Context, app string) (string, HwaccelDecision) {
	d := h.Resolve(ctx, app)
	if d.Effective != "gpu" {
		return "", d
	}
	return IngressPreset, d
}

// RecordUsage forwards the accel path to the metrics counter (best-effort).
func (h *HwAccel) RecordUsage(kind string, d HwaccelDecision) {
	if h.metrics == nil {
		return
	}
	defer func() { _ = recover() }()
	h.metrics.RecordTranscode(kind, d.Effective, d.Type)
}
