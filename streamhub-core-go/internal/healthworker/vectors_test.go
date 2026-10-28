package healthworker

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streamhealth"
)

// Replays testdata/vectors.json, recorded from the Node health-worker by
// testdata/gen_vectors.mjs (see its header for how to regenerate).

type vectors struct {
	Playlists []struct {
		Text   string `json:"text"`
		Parsed any    `json:"parsed"`
		Diff   any    `json:"diff"`
	} `json:"playlists"`
	Kbps []struct {
		Segs []struct{ Bytes, Duration float64 } `json:"segs"`
		Kbps any                                 `json:"kbps"`
	} `json:"kbps"`
	TSCC []struct {
		Hex    string   `json:"hex"`
		Result TSResult `json:"result"`
	} `json:"tscc"`
	TSNames []struct {
		Name string `json:"name"`
		TS   bool   `json:"ts"`
	} `json:"tsNames"`
	Probe []struct {
		Text  string `json:"text"`
		Facts any    `json:"facts"`
	} `json:"probe"`
	Fps []struct {
		Rate json.RawMessage `json:"rate"`
		Fps  any             `json:"fps"`
	} `json:"fps"`
	Volume []struct {
		Text   string `json:"text"`
		Volume any    `json:"volume"`
	} `json:"volume"`
	AppConfig []struct {
		JSON        *string `json:"json"`
		Stringified string  `json:"stringified"`
	} `json:"appConfig"`
	Thresholds []struct {
		App      json.RawMessage               `json:"app"`
		Override json.RawMessage               `json:"override"`
		Resolved streamhealth.HealthThresholds `json:"resolved"`
	} `json:"thresholds"`
	States []struct {
		T     streamhealth.HealthThresholds `json:"t"`
		Steps []struct {
			Now    float64 `json:"now"`
			Sample struct {
				SecondsSinceAdvance  float64  `json:"secondsSinceAdvance"`
				DroppedSegments      float64  `json:"droppedSegments"`
				CCErrors             float64  `json:"ccErrors"`
				NewDiscontinuityTags float64  `json:"newDiscontinuityTags"`
				HasAudioTrack        *bool    `json:"hasAudioTrack"`
				MeanDb               *float64 `json:"meanDb"`
				DesyncMs             *float64 `json:"desyncMs"`
				MeasuredKbps         *float64 `json:"measuredKbps"`
			} `json:"sample"`
			Events  json.RawMessage `json:"events"`
			Status  string          `json:"status"`
			Reasons []string        `json:"reasons"`
		} `json:"steps"`
	} `json:"states"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// generic round-trips v through JSON for a structural comparison.
func generic(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func segJSON(segs []Segment) []any {
	out := []any{}
	for _, s := range segs {
		out = append(out, map[string]any{"uri": s.URI, "duration": s.Duration, "discontinuity": s.Discontinuity, "seq": s.Seq})
	}
	return out
}

func playlistJSON(p Playlist) map[string]any {
	return map[string]any{"mediaSequence": p.MediaSequence, "targetDuration": p.TargetDuration, "endlist": p.Endlist, "segments": segJSON(p.Segments)}
}

func TestVectorsPlaylist(t *testing.T) {
	v := loadVectors(t)
	for i, c := range v.Playlists {
		got := ParsePlaylist(c.Text)
		if g := generic(t, playlistJSON(got)); !reflect.DeepEqual(g, c.Parsed) {
			t.Errorf("parse %d %q:\n got %v\nwant %v", i, c.Text, g, c.Parsed)
		}
		var prev *Playlist
		if i > 0 {
			p := ParsePlaylist(v.Playlists[i-1].Text)
			prev = &p
		}
		d := DiffPlaylist(prev, got)
		gd := generic(t, map[string]any{"advanced": d.Advanced, "newSegments": segJSON(d.NewSegments),
			"droppedSegments": d.DroppedSegments, "newDiscontinuityTags": d.NewDiscontinuityTags})
		if !reflect.DeepEqual(gd, c.Diff) {
			t.Errorf("diff %d:\n got %v\nwant %v", i, gd, c.Diff)
		}
	}
	for i, c := range v.Kbps {
		segs := make([]SegInfo, len(c.Segs))
		for j, s := range c.Segs {
			segs[j] = SegInfo{s.Bytes, s.Duration}
		}
		if g := generic(t, MeasuredKbps(segs)); !reflect.DeepEqual(g, c.Kbps) {
			t.Errorf("kbps %d %v: got %v want %v", i, c.Segs, g, c.Kbps)
		}
	}
}

func TestVectorsTSCC(t *testing.T) {
	v := loadVectors(t)
	for i, c := range v.TSCC {
		b, _ := hex.DecodeString(c.Hex)
		if got := AnalyzeTSContinuity(b); got != c.Result {
			t.Errorf("tscc %d: got %+v want %+v", i, got, c.Result)
		}
	}
	for _, c := range v.TSNames {
		if IsTSSegment(c.Name) != c.TS {
			t.Errorf("isTsSegment(%q) = %v", c.Name, !c.TS)
		}
	}
}

func factsJSON(f *Facts) any {
	if f == nil {
		return nil
	}
	m := map[string]any{"video": nil, "audio": nil, "durationSec": f.DurationSec, "overallBitrateKbps": f.OverallBitrateKbps, "desyncMs": f.DesyncMs}
	if v := f.Video; v != nil {
		m["video"] = map[string]any{"codec": v.Codec, "width": v.Width, "height": v.Height, "fps": v.Fps, "bitrateKbps": v.BitrateKbps, "startTime": v.StartTime}
	}
	if a := f.Audio; a != nil {
		m["audio"] = map[string]any{"codec": a.Codec, "sampleRate": a.SampleRate, "channels": a.Channels, "bitrateKbps": a.BitrateKbps, "startTime": a.StartTime}
	}
	return m
}

func TestVectorsProbe(t *testing.T) {
	v := loadVectors(t)
	for i, c := range v.Probe {
		if g := generic(t, factsJSON(ParseFfprobe(c.Text))); !reflect.DeepEqual(g, c.Facts) {
			t.Errorf("probe %d %q:\n got %v\nwant %v", i, c.Text, g, c.Facts)
		}
	}
	for _, c := range v.Fps {
		rate, _ := y.ParseJSON(c.Rate)
		if g := generic(t, ParseFps(rate)); !reflect.DeepEqual(g, c.Fps) {
			t.Errorf("fps %s: got %v want %v", c.Rate, g, c.Fps)
		}
	}
	for i, c := range v.Volume {
		var got any
		if r := ParseVolumeDetect(c.Text); r != nil {
			got = map[string]any{"meanDb": r.MeanDb, "maxDb": r.MaxDb}
		}
		if g := generic(t, got); !reflect.DeepEqual(g, c.Volume) {
			t.Errorf("volume %d %q: got %v want %v", i, c.Text, g, c.Volume)
		}
	}
}

func TestVectorsSettings(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.AppConfig {
		raw, ok := "", c.JSON != nil
		if ok {
			raw = *c.JSON
		}
		if s, _ := y.Stringify(ParseAppConfig(raw, ok)); s != c.Stringified {
			t.Errorf("parseAppConfig(%v): got %s want %s", c.JSON, s, c.Stringified)
		}
	}
	for i, c := range v.Thresholds {
		layer := func(raw json.RawMessage) *y.Map {
			if string(raw) == "null" || len(raw) == 0 {
				return nil
			}
			m, _ := y.ParseJSON(raw)
			return m.(*y.Map)
		}
		if got := streamhealth.ResolveThresholds(layer(c.App), layer(c.Override)); got != c.Resolved {
			t.Errorf("thresholds %d app=%s over=%s:\n got %+v\nwant %+v", i, c.App, c.Override, got, c.Resolved)
		}
	}
}

func TestVectorsStateMachine(t *testing.T) {
	v := loadVectors(t)
	for i, sc := range v.States {
		st := NewRoomState()
		for k, step := range sc.Steps {
			s := step.Sample
			r := Evaluate(st, Sample{SecondsSinceAdvance: s.SecondsSinceAdvance, DroppedSegments: s.DroppedSegments, CCErrors: s.CCErrors,
				NewDiscontinuityTags: s.NewDiscontinuityTags, HasAudioTrack: s.HasAudioTrack, MeanDb: s.MeanDb, DesyncMs: s.DesyncMs,
				MeasuredKbps: s.MeasuredKbps}, sc.T, step.Now)
			list := []any{}
			for _, e := range r.Events {
				m := y.NewMap()
				m.Set("event", e.Event)
				m.Set("data", e.Data)
				list = append(list, m)
			}
			got, _ := y.Stringify(list)
			want, _ := y.ParseJSON(step.Events)
			wantS, _ := y.Stringify(want)
			if got != wantS || r.Status != step.Status || !reflect.DeepEqual(r.Reasons, orEmpty(step.Reasons)) {
				t.Fatalf("scenario %d step %d (%+v):\n got %s %s %v\nwant %s %s %v", i, k, s, got, r.Status, r.Reasons, wantS, step.Status, step.Reasons)
			}
		}
	}
}

func orEmpty(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}
