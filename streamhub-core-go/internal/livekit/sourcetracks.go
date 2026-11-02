package livekit

import (
	"context"
	"time"

	"github.com/livekit/protocol/livekit"
)

// SourceTracks is told which media kinds a room's publishers carry after
// every publish change (3.4): stream-health uses it to tell "the source has
// no audio" (RTMP video-only — the HLS egress then muxes a silent AAC track)
// from "the audio went silent".
type SourceTracks interface {
	// Watching: does this app want reports (stream-health installed)?
	Watching(ctx context.Context, app string) bool
	RoomTracks(ctx context.Context, app, room string, audio, video bool)
}

const sourceTracksTimeout = 5 * time.Second

// reportSourceTracks asks LiveKit for the room's participants (not the
// event: several publishers and a missed webhook still add up) and reports
// whether any non-hidden publisher has an audio / video track. Async — the
// webhook answer never waits on LiveKit — and serialized, each run reading
// the room's state at its own time. A LiveKit error reports nothing (the
// worker keeps its last answer, or "unknown").
func (m *Module) reportSourceTracks(ctx context.Context, app, room string) {
	o := get(m.opt.SourceTracks)
	if o == nil || app == "" || room == "" || m.svc.clients.Room == nil || !o.Watching(ctx, app) {
		return
	}
	ctx = context.WithoutCancel(ctx)
	go func() {
		m.srcMu.Lock()
		defer m.srcMu.Unlock()
		ctx, cancel := context.WithTimeout(ctx, sourceTracksTimeout)
		defer cancel()
		// the raw client, not the guarded one: a dead LiveKit is no log line here
		res, err := m.svc.clients.Room.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
		if err != nil {
			return
		}
		audio, video := RoomMediaKinds(res.GetParticipants())
		o.RoomTracks(ctx, app, room, audio, video)
	}()
}

// RoomMediaKinds: does any non-hidden participant publish an audio / video
// track? (A muted track still counts: the source has audio, it is muted.)
func RoomMediaKinds(parts []*livekit.ParticipantInfo) (audio, video bool) {
	for _, p := range parts {
		if p.GetPermission().GetHidden() {
			continue
		}
		for _, t := range p.GetTracks() {
			switch t.GetType() {
			case livekit.TrackType_AUDIO:
				audio = true
			case livekit.TrackType_VIDEO:
				video = true
			}
		}
	}
	return audio, video
}
