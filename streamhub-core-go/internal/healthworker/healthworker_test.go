package healthworker

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streamhealth"
)

// Ports of health-worker/tests/*.test.js (playlist, tscc, probe, volume,
// state, settings).

func pl(seq int, uris []string, endlist bool, discAt int) string {
	lines := []string{"#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:" + itoa(seq)}
	for i, u := range uris {
		if i == discAt {
			lines = append(lines, "#EXT-X-DISCONTINUITY")
		}
		lines = append(lines, "#EXTINF:6.000,", u)
	}
	if endlist {
		lines = append(lines, "#EXT-X-ENDLIST")
	}
	return strings.Join(lines, "\n")
}

func itoa(n int) string { return y.JSNumberString(float64(n)) }

func uris(segs []Segment) []string {
	out := []string{}
	for _, s := range segs {
		out = append(out, s.URI)
	}
	return out
}

func TestParsePlaylist(t *testing.T) {
	p := ParsePlaylist(pl(42, []string{"a.ts", "b.ts", "c.ts"}, false, -1))
	if p.MediaSequence != 42 || p.TargetDuration == nil || *p.TargetDuration != 6 || p.Endlist || len(p.Segments) != 3 {
		t.Fatalf("%+v", p)
	}
	if p.Segments[0].Seq != 42 || p.Segments[2].Seq != 44 || p.Segments[0].Duration != 6 {
		t.Fatalf("%+v", p.Segments)
	}
	p = ParsePlaylist(pl(0, []string{"a.ts", "b.ts", "c.ts"}, false, 1))
	if p.Segments[0].Discontinuity || !p.Segments[1].Discontinuity || p.Segments[2].Discontinuity {
		t.Fatal("discontinuity must attach to the following segment only")
	}
	if ParsePlaylist("#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:3\n#EXTINF:6,\na.ts\n").Segments[0].Discontinuity {
		t.Fatal("EXT-X-DISCONTINUITY-SEQUENCE is not a tag")
	}
	if !ParsePlaylist(pl(0, []string{"a.ts"}, true, -1)).Endlist || len(ParsePlaylist("").Segments) != 0 {
		t.Fatal("endlist / empty")
	}
}

func TestDiffPlaylist(t *testing.T) {
	curr := ParsePlaylist(pl(10, []string{"a.ts", "b.ts"}, false, -1))
	if d := DiffPlaylist(nil, curr); !d.Advanced || len(d.NewSegments) != 2 || d.DroppedSegments != 0 {
		t.Fatalf("first poll: %+v", d)
	}
	prev := ParsePlaylist(pl(10, []string{"a.ts", "b.ts", "c.ts"}, false, -1))
	d := DiffPlaylist(&prev, ParsePlaylist(pl(11, []string{"b.ts", "c.ts", "d.ts"}, false, -1)))
	if !d.Advanced || !reflect.DeepEqual(uris(d.NewSegments), []string{"d.ts"}) || d.DroppedSegments != 0 {
		t.Fatalf("advance: %+v", d)
	}
	same := ParsePlaylist(pl(10, []string{"a.ts", "b.ts", "c.ts"}, false, -1))
	if d := DiffPlaylist(&prev, same); d.Advanced || len(d.NewSegments) != 0 {
		t.Fatalf("stall: %+v", d)
	}
	d = DiffPlaylist(&prev, ParsePlaylist(pl(15, []string{"x.ts", "y.ts", "z.ts"}, false, -1)))
	if d.DroppedSegments != 2 || !d.Advanced || len(d.NewSegments) != 3 {
		t.Fatalf("dropped: %+v", d)
	}
	p1 := ParsePlaylist(pl(0, []string{"a.ts", "b.ts", "c.ts"}, false, 1))
	d = DiffPlaylist(&p1, ParsePlaylist(pl(1, []string{"b.ts", "c.ts", "d.ts"}, false, 2)))
	if d.NewDiscontinuityTags != 1 || !reflect.DeepEqual(uris(d.NewSegments), []string{"d.ts"}) {
		t.Fatalf("disc tags: %+v", d)
	}
}

func TestMeasuredKbps(t *testing.T) {
	k := func(s ...SegInfo) any {
		if r := MeasuredKbps(s); r != nil {
			return *r
		}
		return nil
	}
	if k(SegInfo{1_500_000, 6}) != 2000.0 || k(SegInfo{750_000, 3}, SegInfo{750_000, 3}) != 2000.0 {
		t.Fatal("kbps")
	}
	if k() != nil || k(SegInfo{0, 6}) != nil {
		t.Fatal("null cases")
	}
}

type pktOpt struct{ noPayload, disc bool }

func packet(pid int, cc byte, o pktOpt) []byte {
	b := bytes.Repeat([]byte{0xff}, TSPacketSize)
	b[0], b[1], b[2] = 0x47, byte(pid>>8)&0x1f, byte(pid)
	var afc byte
	if o.disc {
		afc |= 0x2
	}
	if !o.noPayload {
		afc |= 0x1
	}
	if afc == 0 {
		afc = 0x2
	}
	b[3] = afc<<4 | cc&0x0f
	if afc&0x2 != 0 {
		b[4] = 1
		if o.disc {
			b[5] = 0x80
		} else {
			b[5] = 0
		}
	}
	return b
}

func TestTSContinuity(t *testing.T) {
	cat := func(p ...[]byte) []byte { return bytes.Join(p, nil) }
	p := func(pid int, cc byte) []byte { return packet(pid, cc, pktOpt{}) }
	cases := []struct {
		name string
		buf  []byte
		want TSResult
	}{
		{"clean", cat(p(0x100, 0), p(0x100, 1), p(0x100, 2), p(0x100, 3)), TSResult{4, 0, 0, 1}},
		{"wrap", cat(p(0x100, 15), p(0x100, 0)), TSResult{2, 0, 0, 1}},
		{"skip", cat(p(0x100, 0), p(0x100, 1), p(0x100, 3)), TSResult{3, 1, 0, 1}},
		{"per-pid", cat(p(0x100, 0), p(0x101, 7), p(0x100, 1), p(0x101, 8)), TSResult{4, 0, 0, 2}},
		{"duplicate", cat(p(0x100, 4), p(0x100, 4), p(0x100, 5)), TSResult{3, 0, 0, 1}},
		{"disc indicator", cat(p(0x100, 2), packet(0x100, 9, pktOpt{disc: true})), TSResult{2, 0, 0, 1}},
		{"null pid", cat(p(0x1fff, 0), p(0x1fff, 9), p(0x1fff, 3)), TSResult{3, 0, 0, 0}},
		{"no payload", cat(p(0x100, 5), packet(0x100, 5, pktOpt{noPayload: true}), p(0x100, 6)), TSResult{3, 0, 0, 1}},
		{"lost sync", cat(p(0x100, 0), make([]byte, 41), p(0x100, 1)), TSResult{2, 0, 1, 1}},
		{"truncated", p(0x100, 0)[:TSPacketSize], TSResult{1, 0, 0, 1}},
		{"empty", nil, TSResult{}},
	}
	for _, c := range cases {
		if got := AnalyzeTSContinuity(c.buf); got != c.want {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
	for name, want := range map[string]bool{"seg-1.ts": true, "seg-1.ts?v=2": true, "seg-1.m4s": false, "seg-1.mp4": false, "": false} {
		if IsTSSegment(name) != want {
			t.Errorf("IsTSSegment(%q)", name)
		}
	}
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func f(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func TestProbe(t *testing.T) {
	if !reflect.DeepEqual(FfprobeArgs("/x/seg.ts"), []string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams", "/x/seg.ts"}) {
		t.Fatal("ffprobe argv")
	}
	for rate, want := range map[string]any{"30000/1001": 30.0, "25/1": 25.0, "25": 25.0, "0/0": nil, "": nil, "x/y": nil} {
		if got := f(ParseFps(rate)); got != want {
			t.Errorf("ParseFps(%q) = %v", rate, got)
		}
	}
	r := ParseFfprobe(fixture(t, "ffprobe-av.json"))
	if r.Video.Codec != "h264" || f(r.Video.Width) != 1280.0 || f(r.Video.Height) != 720.0 || f(r.Video.Fps) != 30.0 ||
		f(r.Video.BitrateKbps) != 2143.0 || r.Audio.Codec != "aac" || f(r.Audio.SampleRate) != 48000.0 || f(r.Audio.Channels) != 2.0 ||
		f(r.OverallBitrateKbps) != 2296.0 || f(r.DurationSec) != 6.006 || f(r.DesyncMs) != 12.0 {
		t.Fatalf("av fixture: %+v %+v %+v", r, r.Video, r.Audio)
	}
	r = ParseFfprobe(fixture(t, "ffprobe-video-only.json"))
	if r.Audio != nil || r.DesyncMs != nil || f(r.Video.Fps) != 25.0 || f(r.Video.Width) != 1920.0 {
		t.Fatal("video-only fixture")
	}
	if f(ParseFfprobe(fixture(t, "ffprobe-desync.json")).DesyncMs) != 352.0 {
		t.Fatal("desync fixture")
	}
	for _, in := range []string{"not json", "", "42"} {
		if ParseFfprobe(in) != nil {
			t.Errorf("%q must parse to nil", in)
		}
	}
	r = ParseFfprobe(`{"format":{"duration":"6.0"}}`)
	if r.Video != nil || r.Audio != nil || f(r.DurationSec) != 6.0 {
		t.Fatal("no streams")
	}
}

func TestVolume(t *testing.T) {
	args := VolumeArgs("/x/seg.ts")
	idx := func(s string) int {
		for i, a := range args {
			if a == s {
				return i
			}
		}
		return -1
	}
	if idx("-vn") < 0 || idx("volumedetect") < 0 || args[idx("-f")+1] != "null" || args[idx("-i")+1] != "/x/seg.ts" {
		t.Fatal("volume argv")
	}
	if r := ParseVolumeDetect(fixture(t, "volumedetect-normal.txt")); r.MeanDb != -23.4 || f(r.MaxDb) != -5.1 {
		t.Fatal("normal")
	}
	if ParseVolumeDetect(fixture(t, "volumedetect-silent.txt")).MeanDb != -91 {
		t.Fatal("silent")
	}
	if ParseVolumeDetect(fixture(t, "volumedetect-noaudio.txt")) != nil || ParseVolumeDetect("") != nil {
		t.Fatal("missing audio must be nil")
	}
}

// --- state machine (state.test.js) --------------------------------------------

var T = streamhealth.DefaultThresholds

func ptr[V any](v V) *V { return &v }

func good(mut func(*Sample)) Sample {
	s := Sample{SecondsSinceAdvance: 2, HasAudioTrack: ptr(true), MeanDb: ptr(-23.0), DesyncMs: ptr(10.0), MeasuredKbps: ptr(2000.0)}
	if mut != nil {
		mut(&s)
	}
	return s
}

func names(r Result) []string {
	out := []string{}
	for _, e := range r.Events {
		out = append(out, e.Event)
	}
	return out
}

func has(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func TestStateHealthy(t *testing.T) {
	r := Evaluate(NewRoomState(), good(nil), T, 0)
	if len(r.Events) != 0 || r.Status != "healthy" || len(r.Reasons) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestStateStall(t *testing.T) {
	s := NewRoomState()
	r := Evaluate(s, good(func(x *Sample) { x.SecondsSinceAdvance = 25 }), T, 0)
	if !reflect.DeepEqual(names(r), []string{"health.stalled", "health.degraded"}) || r.Status != "critical" ||
		r.Events[1].Data.Get("status") != "critical" || !reflect.DeepEqual(r.Events[1].Data.Get("reasons"), []any{"stalled"}) {
		t.Fatalf("%+v", r)
	}
	if r = Evaluate(s, good(func(x *Sample) { x.SecondsSinceAdvance = 35 }), T, 10_000); len(r.Events) != 0 {
		t.Fatal("no repeat while stalled")
	}
	if r = Evaluate(s, good(nil), T, 20_000); len(r.Events) != 0 || r.Status != "critical" {
		t.Fatal("hysteresis")
	}
	r = Evaluate(s, good(nil), T, 30_000)
	if !reflect.DeepEqual(names(r), []string{"health.recovered"}) || !reflect.DeepEqual(r.Events[0].Data.Get("clearedReasons"), []any{"stalled"}) || r.Status != "healthy" {
		t.Fatalf("%+v", r)
	}
}

func TestStateAudioSilence(t *testing.T) {
	s := NewRoomState()
	db := func(v float64) func(*Sample) { return func(x *Sample) { x.MeanDb = &v } }
	if r := Evaluate(s, good(db(-80)), T, 0); len(r.Events) != 0 || r.Status != "healthy" {
		t.Fatal("too short")
	}
	if r := Evaluate(s, good(db(-85)), T, 10_000); len(r.Events) != 0 {
		t.Fatal("10s")
	}
	r := Evaluate(s, good(db(-90)), T, 20_000)
	if !reflect.DeepEqual(names(r), []string{"health.audio_lost", "health.degraded"}) || r.Events[0].Data.Get("reason") != "silence" ||
		r.Events[0].Data.Get("silenceDb") != -90.0 || r.Status != "degraded" {
		t.Fatalf("%+v", r)
	}
	if r = Evaluate(s, good(nil), T, 30_000); len(r.Events) != 0 || len(r.Reasons) != 0 || r.Status != "degraded" {
		t.Fatalf("%+v", r)
	}
	r = Evaluate(s, good(nil), T, 40_000)
	if !has(names(r), "health.audio_recovered") || !has(names(r), "health.recovered") || r.Status != "healthy" {
		t.Fatalf("%+v", r)
	}
	s = NewRoomState()
	Evaluate(s, good(db(-80)), T, 0)
	Evaluate(s, good(db(-20)), T, 10_000)
	if r := Evaluate(s, good(db(-80)), T, 20_000); len(r.Events) != 0 {
		t.Fatal("a loud gap must reset the silence clock")
	}
}

func TestStateAudioMissing(t *testing.T) {
	s := NewRoomState()
	missing := func(x *Sample) { x.HasAudioTrack, x.MeanDb = ptr(false), nil }
	r := Evaluate(s, good(missing), T, 0)
	if !reflect.DeepEqual(names(r), []string{"health.audio_lost", "health.degraded"}) || r.Events[0].Data.Get("reason") != "no_audio_track" {
		t.Fatalf("%+v", r)
	}
	r = Evaluate(s, good(func(x *Sample) { x.HasAudioTrack, x.MeanDb = nil, nil }), T, 10_000)
	if has(names(r), "health.audio_recovered") || !reflect.DeepEqual(r.Reasons, []string{"audio_silent"}) {
		t.Fatalf("coast: %+v", r)
	}
}

func TestStateDesync(t *testing.T) {
	s := NewRoomState()
	ds := func(v float64) func(*Sample) { return func(x *Sample) { x.DesyncMs = &v } }
	r := Evaluate(s, good(ds(350)), T, 0)
	if !reflect.DeepEqual(names(r), []string{"health.av_desync", "health.degraded"}) || r.Events[0].Data.Get("desyncMs") != 350.0 {
		t.Fatalf("%+v", r)
	}
	if r = Evaluate(s, good(ds(400)), T, 10_000); len(r.Events) != 0 {
		t.Fatal("repeat")
	}
	Evaluate(s, good(nil), T, 20_000)
	if r = Evaluate(s, good(nil), T, 30_000); !reflect.DeepEqual(names(r), []string{"health.recovered"}) {
		t.Fatalf("%+v", r)
	}
	if r = Evaluate(s, good(ds(500)), T, 40_000); !has(names(r), "health.av_desync") {
		t.Fatal("re-arm")
	}
}

func TestStateDiscontinuity(t *testing.T) {
	s := NewRoomState()
	r := Evaluate(s, good(func(x *Sample) { x.CCErrors = 7 }), T, 0)
	if !reflect.DeepEqual(names(r), []string{"health.discontinuity", "health.degraded"}) || r.Events[0].Data.Get("ccErrors") != 7.0 {
		t.Fatalf("%+v", r)
	}
	r = Evaluate(s, good(func(x *Sample) { x.DroppedSegments = 2 }), T, 30_000)
	if len(r.Events) != 0 || !reflect.DeepEqual(r.Reasons, []string{"discontinuity"}) {
		t.Fatalf("cooldown: %+v", r)
	}
	r = Evaluate(s, good(func(x *Sample) { x.NewDiscontinuityTags = 1 }), T, (DiscontinuityCooldownSec+31)*1000)
	if !has(names(r), "health.discontinuity") {
		t.Fatal("after cooldown")
	}
}

func TestStateBitrate(t *testing.T) {
	kb := func(v float64) func(*Sample) { return func(x *Sample) { x.MeasuredKbps = &v } }
	s := NewRoomState()
	Evaluate(s, good(kb(2000)), T, 0)
	r := Evaluate(s, good(kb(800)), T, 10_000)
	if !reflect.DeepEqual(names(r), []string{"health.degraded"}) || !reflect.DeepEqual(r.Events[0].Data.Get("reasons"), []any{"bitrate_low"}) || *s.BaselineKbps != 2000 {
		t.Fatalf("%+v", r)
	}
	Evaluate(s, good(kb(1900)), T, 20_000)
	if r = Evaluate(s, good(kb(2000)), T, 30_000); !reflect.DeepEqual(names(r), []string{"health.recovered"}) {
		t.Fatalf("%+v", r)
	}
	off := T
	off.BitrateDropPct = 0
	s = NewRoomState()
	Evaluate(s, good(kb(2000)), off, 0)
	if r = Evaluate(s, good(kb(100)), off, 10_000); len(r.Events) != 0 || r.Status != "healthy" {
		t.Fatal("0 disables")
	}
}

func TestStateRollup(t *testing.T) {
	s := NewRoomState()
	if r := Evaluate(s, good(func(x *Sample) { x.DesyncMs = ptr(400.0) }), T, 0); r.Status != "degraded" {
		t.Fatal("one issue")
	}
	r := Evaluate(s, good(func(x *Sample) { x.DesyncMs, x.CCErrors = ptr(400.0), 3 }), T, 10_000)
	if r.Status != "critical" || !has(names(r), "health.degraded") {
		t.Fatalf("%+v", r)
	}
	s = NewRoomState()
	Evaluate(s, good(func(x *Sample) { x.DesyncMs, x.CCErrors = ptr(400.0), 3 }), T, 0)
	if r = Evaluate(s, good(func(x *Sample) { x.DesyncMs = ptr(400.0) }), T, 10_000); len(r.Events) != 0 || r.Status != "degraded" {
		t.Fatal("no de-escalation event")
	}
	one := T
	one.RecoverSamples = 1
	s = NewRoomState()
	Evaluate(s, good(func(x *Sample) { x.DesyncMs = ptr(400.0) }), one, 0)
	if r = Evaluate(s, good(nil), one, 10_000); !reflect.DeepEqual(names(r), []string{"health.recovered"}) {
		t.Fatal("recover_samples=1")
	}
}

// --- settings (settings.test.js) ------------------------------------------------

func TestParseAppConfig(t *testing.T) {
	for raw, want := range map[string]string{`{"stall_sec":30}`: `{"stall_sec":30}`, "nope": "{}", "[1]": "{}"} {
		if got, _ := y.Stringify(ParseAppConfig(raw, true)); got != want {
			t.Errorf("%q: %s", raw, got)
		}
	}
	if got, _ := y.Stringify(ParseAppConfig("", false)); got != "{}" {
		t.Error("unset")
	}
}

func TestReadRoomOverrides(t *testing.T) {
	dbFile := filepath.Join(t.TempDir(), "stream-health.db")
	h, err := sql.Open("sqlite", "file:"+dbFile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Exec(`CREATE TABLE stream_settings (room TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}',
	  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
	  INSERT INTO stream_settings (room, config_json) VALUES ('cam-1', '{"silence_db":-35}'), ('bad', 'not json')`); err != nil {
		t.Fatal(err)
	}
	h.Close()
	m := ReadRoomOverrides(context.Background(), dbFile)
	if got, _ := y.Stringify(m["cam-1"]); got != `{"silence_db":-35}` {
		t.Fatalf("cam-1: %s", got)
	}
	if _, ok := m["bad"]; ok {
		t.Fatal("corrupt row must be skipped")
	}
	missing := filepath.Join(t.TempDir(), "nope", "stream-health.db")
	if len(ReadRoomOverrides(context.Background(), missing)) != 0 {
		t.Fatal("missing db → empty")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("a read-only open must not create the db")
	}
}
