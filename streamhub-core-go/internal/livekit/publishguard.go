package livekit

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// Per-app publisher guards (AntMedia-matrix quick wins, 3.4.0), both off
// unless the app's config.yaml sets them:
//
//   - features.allowed_publisher_cidr (allowedPublisherCIDR): the source
//     address of a publish-capable token mint must fall in the list. The
//     MediaMTX single-port front applies the same list to RTMP/SRT pushes
//     (internal/passthrough); a push straight to the LiveKit ingress port
//     never reaches the core, so there is nothing to check there.
//   - features.max_bitrate_accept (maxBitrateAccept, bits/s): a LiveKit
//     ingress whose measured input bitrate exceeds the cap is cut. LiveKit
//     has no admission hook for it, so the cut is REACTIVE: the ingress
//     state is swept every BitrateGuardInterval (LiveKit sends no webhook on
//     a state/bitrate update) and checked once more on ingress_started.

// BitrateGuardInterval is the maxBitrateAccept sweep period.
const BitrateGuardInterval = 15 * time.Second

// bitrateCutCooldown keeps a session that was just cut from being cut (and
// reported) again while LiveKit still lists its stale state.
const bitrateCutCooldown = 2 * BitrateGuardInterval

// ReasonMaxBitrateExceeded is the stream_ended reason of a cut.
const ReasonMaxBitrateExceeded = "max_bitrate_exceeded"

// bitrateCuts remembers recent cuts per ingress session (id + startedAt).
type bitrateCuts struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// claim reports whether session may be cut now (and records it).
func (c *bitrateCuts) claim(session string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen == nil {
		c.seen = map[string]time.Time{}
	}
	for k, at := range c.seen {
		if now.Sub(at) >= bitrateCutCooldown {
			delete(c.seen, k)
		}
	}
	if _, recent := c.seen[session]; recent {
		return false
	}
	c.seen[session] = now
	return true
}

func (c *bitrateCuts) release(session string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.seen, session)
}

// assertPublisherSource is allowedPublisherCIDR on a publish-capable token:
// the caller's address (httpx.ClientIP, as the network guard sees it) must
// be inside the app list. 403 otherwise.
func (m *Module) assertPublisherSource(ctx context.Context, cfg *contracts.AppConfig, app string) error {
	if cfg == nil || len(cfg.Features.AllowedPublisherCidr) == 0 {
		return nil
	}
	ip := httpx.ClientIP(api.Request(ctx))
	if security.PublisherAllowed(cfg.Features.AllowedPublisherCidr, ip) {
		return nil
	}
	m.logWrite("warn", "livekit", "publisher token refused: source outside allowedPublisherCidr",
		map[string]any{"app": app, "ip": ip})
	if ip == "" {
		ip = "an unknown address"
	}
	return httpx.Forbidden("publishing to app " + app + " is not allowed from " + ip + " (allowedPublisherCidr)")
}

// IngressBitrate is the measured input bitrate (video + audio, bits/s) of a
// PUBLISHING ingress; 0 when it is not publishing or not measured yet.
func IngressBitrate(info *livekit.IngressInfo) int64 {
	st := info.GetState()
	if st.GetStatus() != livekit.IngressState_ENDPOINT_PUBLISHING {
		return 0
	}
	return int64(st.GetVideo().GetAverageBitrate()) + int64(st.GetAudio().GetAverageBitrate())
}

type bitrateExceededPayload struct {
	StreamID         string `json:"streamId"`
	Room             string `json:"room"`
	IngressID        string `json:"ingressId"`
	Reason           string `json:"reason"`
	Bitrate          int64  `json:"bitrate"`
	MaxBitrateAccept int64  `json:"maxBitrateAccept"`
}

// enforceBitrate cuts info (kicks the ingress participant — the stream key
// survives, the encoder may reconnect and is re-checked) when it publishes
// above maxBps; reports whether it did.
func (m *Module) enforceBitrate(ctx context.Context, app string, maxBps float64, info *livekit.IngressInfo) bool {
	if maxBps <= 0 || info == nil {
		return false
	}
	bps := IngressBitrate(info)
	if bps <= int64(maxBps) {
		return false
	}
	room, identity := info.GetRoomName(), info.GetParticipantIdentity()
	if room == "" || identity == "" {
		return false
	}
	session := info.GetIngressId() + "@" + strconv.FormatInt(info.GetState().GetStartedAt(), 10)
	if !m.cuts.claim(session, m.now()) {
		return false
	}
	meta := map[string]any{"ingressId": info.GetIngressId(), "room": room, "app": app, "bitrate": bps, "maxBitrateAccept": int64(maxBps)}
	if err := m.svc.RemoveParticipant(ctx, room, identity); err != nil {
		m.cuts.release(session)
		m.whLog("error", "maxBitrateAccept enforcement failed: "+err.Error(), meta)
		return false
	}
	m.whLog("warn", "cut ingress publishing above maxBitrateAccept", meta)
	m.dispatch(ctx, app, "stream_ended", bitrateExceededPayload{
		streamKey(room, identity), room, info.GetIngressId(), ReasonMaxBitrateExceeded, bps, int64(maxBps),
	})
	return true
}

// SweepBitrate is one maxBitrateAccept pass over every LiveKit ingress.
// No app with a cap = no LiveKit call at all.
func (m *Module) SweepBitrate(ctx context.Context) {
	if m.apps == nil {
		return
	}
	list, err := m.apps.List(ctx, nil)
	if err != nil {
		return
	}
	caps := map[string]float64{}
	for _, a := range list {
		if cfg := m.appConfig(ctx, a.Name); cfg != nil && cfg.Features.MaxBitrateAccept > 0 {
			caps[a.Name] = cfg.Features.MaxBitrateAccept
		}
	}
	if len(caps) == 0 {
		return
	}
	res, err := m.svc.clients.Ingress.ListIngress(ctx, &livekit.ListIngressRequest{})
	if err != nil {
		m.whLog("warn", "maxBitrateAccept sweep: listIngress failed: "+err.Error(), nil)
		return
	}
	// Longest prefix first, as resolveApp does.
	sort.SliceStable(list, func(i, j int) bool { return len(list[i].LivekitRoomPrefix) > len(list[j].LivekitRoomPrefix) })
	for _, info := range res.GetItems() {
		room := info.GetRoomName()
		for _, a := range list {
			if room == a.LivekitRoomPrefix || strings.HasPrefix(room, a.LivekitRoomPrefix+"-") {
				if limit, ok := caps[a.Name]; ok {
					m.enforceBitrate(ctx, a.Name, limit, info)
				}
				break
			}
		}
	}
}

// Start runs the maxBitrateAccept sweep (a starter: never in shadow mode).
func (m *Module) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(BitrateGuardInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.SweepBitrate(ctx)
			}
		}
	}()
}
