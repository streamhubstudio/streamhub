package main

import (
	"context"

	lkproto "github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/callbacks"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
)

// The livekit plane: the LiveKit SDK wrapper (rooms, ingress, egress, data,
// tokens), the per-app token/ingress/playback routes, the rooms/moderation
// API, the LiveKit webhook sink and GET /stats.
//
// Provides: "livekit" (*livekit.Service — the guarded SDK wrapper recording /
// restream / broadcast / live-control / scheduled-live call), "livekit.hls"
// (streams.Egress over it, for the streams plane's HLS + watchdog),
// "ingressAuth" (*livekit.IngressAuth — the ingress_auth key store the
// passthrough and ws-ingest planes share), "ingressBackup"
// (*livekit.IngressBackup).
//
// Optional collaborators are resolved at CALL time (Node's lazy ModuleRef),
// so planes wired later are picked up: "logs", "callbacks", "streams",
// "recording", "restream", "netmetrics", "passthrough" (each must satisfy
// the narrow interface in internal/livekit/deps.go) and "hwaccel"
// (*system.HwAccel, adapted below).
func init() {
	registerPlane(40, "livekit", func(ctx context.Context, c *core) error {
		hw := lazy[*system.HwAccel](c, "hwaccel")
		m := livekit.New(livekit.Deps{
			Config: c.cfg, Store: c.store, Log: c.log,
			Apps:   need[contracts.AppsService](c, "apps"),
			Quotas: need[*quotas.Service](c, "quotas"),
			Audit:  need[*audit.Service](c, "audit"),
			Optional: livekit.Optional{
				Logs:        lazy[livekit.Logs](c, "logs"),
				Callbacks:   lazy[livekit.Callbacks](c, "callbacks"),
				Streams:     lazy[livekit.Streams](c, "streams"),
				Recording:   lazy[livekit.Recording](c, "recording"),
				Restream:    lazy[livekit.Restream](c, "restream"),
				NetMetrics:  lazy[livekit.NetMetrics](c, "netmetrics"),
				Passthrough: lazy[livekit.Passthrough](c, "passthrough"),
				HwAccel: func() livekit.HwAccel {
					if h := hw(); h != nil {
						return hwAccel{h}
					}
					return nil
				},
			},
		})
		provide(c, "livekit", m.Service())
		provide[streams.Egress](c, "livekit.hls", hlsEgress{m.Service()})
		provide(c, "ingressAuth", m.Auth)
		provide(c, "ingressBackup", m.Backup)
		c.modules = append(c.modules, m)
		return nil
	})
}

// hwAccel adapts system.HwAccel (HwAccelService) to the SDK options the
// LiveKit wrapper attaches, recording the accel path used.
type hwAccel struct{ h *system.HwAccel }

func (a hwAccel) EgressEncoding(ctx context.Context, app string) (*lkproto.EncodingOptions, error) {
	enc, d := a.h.EgressOptions(ctx, app)
	a.h.RecordUsage("egress", d)
	if enc == nil {
		return nil, nil
	}
	return &lkproto.EncodingOptions{
		Width: int32(enc.Width), Height: int32(enc.Height), Framerate: int32(enc.Framerate),
		VideoCodec: lkproto.VideoCodec_H264_MAIN, VideoBitrate: int32(enc.VideoBitrate),
		KeyFrameInterval: enc.KeyFrameSeconds,
	}, nil
}

func (a hwAccel) IngressVideo(ctx context.Context, app string) (*lkproto.IngressVideoOptions, error) {
	preset, d := a.h.IngressOptions(ctx, app)
	a.h.RecordUsage("ingress", d)
	if preset == "" {
		return nil, nil
	}
	return &lkproto.IngressVideoOptions{
		Source: lkproto.TrackSource_CAMERA,
		EncodingOptions: &lkproto.IngressVideoOptions_Preset{
			Preset: lkproto.IngressVideoEncodingPreset(lkproto.IngressVideoEncodingPreset_value[preset]),
		},
	}, nil
}

// hlsEgress is the streams plane's HLS slice of the LiveKit wrapper.
type hlsEgress struct{ s *livekit.Service }

func (e hlsEgress) StartHlsEgress(ctx context.Context, in streams.StartHlsEgressInput) (*streams.HlsEgressInfo, error) {
	info, err := e.s.StartHlsEgress(ctx, livekit.StartHlsEgressInput{
		AppName: in.AppName, RoomName: in.RoomName, OutputDir: in.OutputDir, PlaylistName: in.PlaylistName,
		LivePlaylistName: in.LivePlaylistName, SegmentDurationS: float64(in.SegmentDurationS),
	})
	if err != nil {
		return nil, err
	}
	return &streams.HlsEgressInfo{EgressID: info.EgressID, Status: info.Status, RoomName: info.RoomName}, nil
}

func (e hlsEgress) ListHlsEgress(ctx context.Context, roomPrefix string) ([]streams.HlsEgressInfo, error) {
	list, err := e.s.ListHlsEgress(ctx, roomPrefix)
	if err != nil {
		return nil, err
	}
	out := make([]streams.HlsEgressInfo, 0, len(list))
	for _, i := range list {
		out = append(out, streams.HlsEgressInfo{EgressID: i.EgressID, Status: i.Status, RoomName: i.RoomName})
	}
	return out, nil
}

func (e hlsEgress) StopEgress(ctx context.Context, egressID string) (*streams.EgressInfo, error) {
	info, err := e.s.StopEgress(ctx, egressID)
	if err != nil {
		return nil, err
	}
	return &streams.EgressInfo{EgressID: info.EgressID, Status: info.Status}, nil
}

// The optional collaborators already ported must keep satisfying the
// livekit package's narrow views (else the lazy lookup silently skips them).
var (
	_ livekit.Streams   = (*streams.Service)(nil)
	_ livekit.Logs      = (*logs.Service)(nil)
	_ livekit.Callbacks = (*callbacks.Service)(nil)
)
