package broadcast

import (
	"context"
	"errors"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

type fakeLK struct {
	started  []livekit.StartStreamEgressInput
	prefixes []string
	stopped  []string
	fail     error
	urls     []string
}

func (f *fakeLK) StartStreamEgress(_ context.Context, in livekit.StartStreamEgressInput) (livekit.StreamEgressInfo, error) {
	if f.fail != nil {
		return livekit.StreamEgressInfo{}, f.fail
	}
	f.started = append(f.started, in)
	return livekit.StreamEgressInfo{EgressID: "EG_1", Status: "EGRESS_STARTING", RoomName: in.RoomName, URLs: f.urls}, nil
}

func (f *fakeLK) StopEgress(_ context.Context, id string) (livekit.EgressInfo, error) {
	if f.fail != nil {
		return livekit.EgressInfo{}, f.fail
	}
	f.stopped = append(f.stopped, id)
	return livekit.EgressInfo{EgressID: id, Status: "EGRESS_ENDING"}, nil
}

func (f *fakeLK) ListStreamEgress(_ context.Context, prefix string) ([]livekit.StreamEgressInfo, error) {
	f.prefixes = append(f.prefixes, prefix)
	if f.fail != nil {
		return nil, f.fail
	}
	return nil, nil
}

type fakeApps struct {
	contracts.AppsService
	prefix string
	fail   bool
}

func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	if f.fail {
		return nil, errors.New("boom")
	}
	return &contracts.AppConfig{RoomPrefix: f.prefix}, nil
}

type logLine struct{ level, msg string }

type fakeLogs struct{ lines []logLine }

func (f *fakeLogs) Write(level, _, msg string, _ any, _ *int64) {
	f.lines = append(f.lines, logLine{level, msg})
}

func newSvc(lk *fakeLK, apps *fakeApps, logs *fakeLogs) *Service {
	return New(lk, apps, nil, func() Logs { return logs }, testutil.Log()).Svc
}

func errText(err error) string {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Error()
	}
	return ""
}

func TestStart(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name, room, url, wantRoom, wantErr string
		apps                               *fakeApps
	}{
		{"namespaces under prefix", " room1 ", " rtmp://a/live/k ", "pfx-room1", "", &fakeApps{prefix: "pfx"}},
		{"already namespaced", "pfx-room1", "rtmps://a/k", "pfx-room1", "", &fakeApps{prefix: "pfx"}},
		{"prefix itself", "pfx", "RTMP://a/k", "pfx", "", &fakeApps{prefix: "pfx"}},
		{"config failure → app name", "r", "rtmp://a/k", "live-r", "", &fakeApps{fail: true}},
		{"blank room", "  ", "rtmp://a/k", "", "roomName is required", &fakeApps{}},
		{"bad url", "r", "http://a/k", "", "rtmpUrl must start with rtmp:// or rtmps://", &fakeApps{}},
	}
	for _, c := range cases {
		lk, logs := &fakeLK{}, &fakeLogs{}
		info, err := newSvc(lk, c.apps, logs).Start(ctx, "live", c.room, c.url, "grid")
		if c.wantErr != "" {
			if errText(err) != c.wantErr || len(lk.started) != 0 {
				t.Errorf("%s: %v", c.name, err)
			}
			continue
		}
		if err != nil || lk.started[0].RoomName != c.wantRoom || info.RoomName != c.wantRoom || lk.started[0].Layout != "grid" {
			t.Errorf("%s: %+v %v", c.name, lk.started, err)
		}
		if logs.lines[0] != (logLine{"info", "broadcast started"}) {
			t.Errorf("%s: logs %v", c.name, logs.lines)
		}
	}
}

func TestEgressFailuresBecome500(t *testing.T) {
	ctx := context.Background()
	lk, logs := &fakeLK{fail: errors.New("LiveKit startStreamEgress failed: down")}, &fakeLogs{}
	s := newSvc(lk, &fakeApps{prefix: "live"}, logs)
	_, err := s.Start(ctx, "live", "r", "rtmp://a/k", "")
	var he *httpx.Error
	if !errors.As(err, &he) || he.Status != 500 || he.Error() != "failed to start broadcast: LiveKit startStreamEgress failed: down" {
		t.Fatalf("start: %v", err)
	}
	if _, err := s.Stop(ctx, "live", "EG_1"); !errors.As(err, &he) || he.Status != 500 || he.Error() != "failed to stop broadcast: LiveKit startStreamEgress failed: down" {
		t.Fatalf("stop: %v", err)
	}
	if got := s.List(ctx, "live"); got == nil || len(got) != 0 {
		t.Fatalf("list must degrade to []: %v", got)
	}
	if len(logs.lines) != 3 || logs.lines[0].level != "error" || logs.lines[2].level != "warn" {
		t.Fatalf("logs %v", logs.lines)
	}
}

func TestStopAndList(t *testing.T) {
	ctx := context.Background()
	lk := &fakeLK{}
	s := newSvc(lk, &fakeApps{prefix: "pfx"}, &fakeLogs{})
	if _, err := s.Stop(ctx, "live", "   "); errText(err) != "egress id is required" {
		t.Fatalf("blank id: %v", err)
	}
	res, err := s.Stop(ctx, "live", " EG_9 ")
	if err != nil || res.EgressID != "EG_9" || lk.stopped[0] != "EG_9" {
		t.Fatalf("stop %+v %v", res, err)
	}
	if got := s.List(ctx, "live"); got == nil || lk.prefixes[0] != "pfx" {
		t.Fatalf("list %v %v", got, lk.prefixes)
	}
}
