package livekit

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
)

// 3.4: the source-audio report stream-health reads (sourcetracks.go).

type fakeSources struct {
	mu      sync.Mutex
	watch   map[string]bool
	reports []string
}

func (f *fakeSources) Watching(_ context.Context, app string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.watch[app]
}

func (f *fakeSources) RoomTracks(_ context.Context, app, room string, audio, video bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports = append(f.reports, fmt.Sprintf("%s|%s|%v|%v", app, room, audio, video))
}

func (f *fakeSources) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.reports...)
}

func waitReports(t *testing.T, f *fakeSources, n int) []string {
	t.Helper()
	for i := 0; i < 400 && len(f.got()) < n; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if got := f.got(); len(got) != n {
		t.Fatalf("reports %v, want %d", got, n)
	}
	return f.got()
}

func TestRoomMediaKinds(t *testing.T) {
	tr := func(k livekit.TrackType) *livekit.TrackInfo { return &livekit.TrackInfo{Type: k} }
	hidden := &livekit.ParticipantInfo{Permission: &livekit.ParticipantPermission{Hidden: true}, Tracks: []*livekit.TrackInfo{tr(livekit.TrackType_AUDIO)}}
	video := &livekit.ParticipantInfo{Tracks: []*livekit.TrackInfo{tr(livekit.TrackType_VIDEO)}}
	mic := &livekit.ParticipantInfo{Tracks: []*livekit.TrackInfo{{Type: livekit.TrackType_AUDIO, Muted: true}}}
	for _, c := range []struct {
		parts        []*livekit.ParticipantInfo
		audio, video bool
	}{{nil, false, false}, {[]*livekit.ParticipantInfo{hidden, video}, false, true}, {[]*livekit.ParticipantInfo{video, mic}, true, true}} {
		if a, v := RoomMediaKinds(c.parts); a != c.audio || v != c.video {
			t.Errorf("%v → %v %v", c.parts, a, v)
		}
	}
}

func TestWebhookReportsSourceTracks(t *testing.T) {
	h := newHarness(t)
	h.src = &fakeSources{watch: map[string]bool{"live": true}}
	participants := `{"participants":[{"identity":"ing","kind":"INGRESS","tracks":[{"type":"VIDEO"}]},
	  {"identity":"egress","permission":{"hidden":true},"tracks":[{"type":"AUDIO"}]}]}`
	h.lk.on = func(method string, _ any) (string, bool) {
		if method == "ListParticipants" {
			return participants, true
		}
		return "", false
	}
	// an RTMP video-only ingress: video yes, audio no (the hidden one's audio doesn't count)
	expect(t, h.post(`{"event":"track_published","room":{"name":"live-r"},"participant":{"identity":"ing","kind":"INGRESS"},"track":{"type":"VIDEO"}}`), 200)
	if got := waitReports(t, h.src, 1); got[0] != "live|live-r|false|true" {
		t.Fatal(got)
	}
	// the publisher leaves: nothing published any more
	participants = `{"participants":[]}`
	expect(t, h.post(`{"event":"participant_left","room":{"name":"live-r"},"participant":{"identity":"ing"}}`), 200)
	if got := waitReports(t, h.src, 2); got[1] != "live|live-r|false|false" {
		t.Fatal(got)
	}
	// LiveKit unreachable → no report; an app without stream-health → LiveKit is not even asked
	h.lk.on = func(method string, _ any) (string, bool) {
		return "!error:connection refused", method == "ListParticipants"
	}
	expect(t, h.post(`{"event":"track_unpublished","room":{"name":"live-r"},"participant":{"identity":"u"}}`), 200)
	time.Sleep(50 * time.Millisecond)
	if got := h.src.got(); len(got) != 2 {
		t.Fatal(got)
	}
	h.src.mu.Lock()
	h.src.watch["live"] = false
	h.src.mu.Unlock()
	asked := h.lk.count("ListParticipants")
	expect(t, h.post(`{"event":"track_published","room":{"name":"live-r"},"participant":{"identity":"u"}}`), 200)
	time.Sleep(50 * time.Millisecond)
	if h.lk.count("ListParticipants") != asked || len(h.src.got()) != 2 {
		t.Fatal("unwatched app must not be reported")
	}
}
