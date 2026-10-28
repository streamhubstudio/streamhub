package transcription

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Port of transcription.util.spec.ts.

func sp(s string) *string { return &s }

func TestFormatSrtTimestamp(t *testing.T) {
	for in, want := range map[float64]string{
		0: "00:00:00,000", 0.5: "00:00:00,500", 3661.25: "01:01:01,250", 59.999: "00:00:59,999",
		1.0006: "00:00:01,001", -5: "00:00:00,000",
	} {
		if got := FormatSrtTimestamp(in); got != want {
			t.Errorf("%v → %s want %s", in, got, want)
		}
	}
	if got := FormatSrtTimestamp(math.NaN()); got != "00:00:00,000" {
		t.Errorf("NaN → %s", got)
	}
}

func TestBuildSrt(t *testing.T) {
	got := BuildSrt([]Segment{{Start: 0, End: 2.5, Text: "hola"}, {Start: 2.5, End: 4, Text: "mundo"}})
	want := "1\n00:00:00,000 --> 00:00:02,500\nhola\n\n2\n00:00:02,500 --> 00:00:04,000\nmundo\n"
	if got != want {
		t.Fatalf("%q", got)
	}
	cues := strings.Split(strings.TrimSpace(BuildSrt([]Segment{{Start: 5, End: 6, Text: "second"}, {Start: 1, End: 2, Text: "   "}, {Start: 0, End: 1, Text: "first"}})), "\n\n")
	if len(cues) != 2 || !strings.Contains(cues[0], "first") || !strings.Contains(cues[1], "second") {
		t.Fatalf("sorted/skipped: %q", cues)
	}
	if s := BuildSrt([]Segment{{Start: 0, End: 1, Text: "hi there", Speaker: sp("alice")}}); !strings.Contains(s, "[alice] hi there") {
		t.Fatalf("speaker: %q", s)
	}
	if s := BuildSrt([]Segment{{Start: 10, End: 10, Text: "blip"}}); !strings.Contains(s, "00:00:10,000 --> 00:00:10,500") {
		t.Fatalf("min cue: %q", s)
	}
	if BuildSrt(nil) != "" || BuildSrt([]Segment{{Start: 0, End: 1, Text: ""}}) != "" {
		t.Fatal("empty → \"\"")
	}
}

func TestMergeSpeakersPlainText(t *testing.T) {
	tracks := []TrackTranscript{
		{Speaker: sp("alice"), Segments: []Segment{{Start: 4, End: 5, Text: "and back to me"}, {Start: 0, End: 1, Text: "hello"}}},
		{Speaker: sp("bob"), Segments: []Segment{{Start: 2, End: 3, Text: "hi alice"}}},
		{Speaker: nil, Segments: nil},
	}
	merged := MergeTrackSegments(tracks)
	var texts, speakers []string
	for _, s := range merged {
		texts, speakers = append(texts, s.Text), append(speakers, *s.Speaker)
	}
	if !reflect.DeepEqual(texts, []string{"hello", "hi alice", "and back to me"}) || !reflect.DeepEqual(speakers, []string{"alice", "bob", "alice"}) {
		t.Fatalf("%v %v", texts, speakers)
	}
	if got := CollectSpeakers(merged); !reflect.DeepEqual(got, []string{"alice", "bob"}) {
		t.Fatalf("speakers %v", got)
	}
	if got := PlainTranscriptText(merged); got != "[alice] hello\n[bob] hi alice\n[alice] and back to me" {
		t.Fatalf("%q", got)
	}
	if got := PlainTranscriptText([]Segment{{Start: 0, End: 1, Text: "mixed room"}}); got != "mixed room" {
		t.Fatalf("%q", got)
	}
}

func TestMp3ExtractArgs(t *testing.T) {
	want := []string{"-y", "-i", "/in/rec.mp4", "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "128k", "-ac", "1", "-ar", "16000", "/out/rec.mp3"}
	if got := Mp3ExtractArgs("/in/rec.mp4", "/out/rec.mp3", 0); !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	if got := Mp3ExtractArgs("/in/rec.mp4", "/out/rec-a2.mp3", 2); got[5] != "0:a:2" {
		t.Fatalf("%v", got)
	}
}

func TestProbeAudioStreamCount(t *testing.T) {
	var gotBin string
	var gotArgs []string
	run := func(_ context.Context, bin string, args []string, _ time.Duration) (string, error) {
		gotBin, gotArgs = bin, args
		return `{"streams":[{"index":1},{"index":2}]}`, nil
	}
	if n := ProbeAudioStreamCount(context.Background(), "/in/rec.mp4", run); n != 2 {
		t.Fatalf("n=%d", n)
	}
	if gotBin != "ffprobe" || !reflect.DeepEqual(gotArgs, AudioProbeArgs("/in/rec.mp4")) {
		t.Fatalf("%s %v", gotBin, gotArgs)
	}
	if n := ProbeAudioStreamCount(context.Background(), "/x.mp4", func(context.Context, string, []string, time.Duration) (string, error) { return "{}", nil }); n != 0 {
		t.Fatalf("no audio: %d", n)
	}
	if n := ProbeAudioStreamCount(context.Background(), "/x.mp4", func(context.Context, string, []string, time.Duration) (string, error) {
		return "", errors.New("ffprobe missing")
	}); n != -1 {
		t.Fatalf("failure: %d", n)
	}
}

func TestExtractMp3Track(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "nested", "a0.mp3")
	var gotArgs []string
	ok := ExtractMp3Track(context.Background(), "/in/rec.mp4", out, 0, func(_ context.Context, bin string, args []string, _ time.Duration) (string, error) {
		if bin != "ffmpeg" {
			t.Fatalf("bin %s", bin)
		}
		gotArgs = args
		return "", os.WriteFile(args[len(args)-1], []byte("mp3"), 0o644)
	})
	if !ok || !reflect.DeepEqual(gotArgs, Mp3ExtractArgs("/in/rec.mp4", out, 0)) {
		t.Fatalf("ok=%v args=%v", ok, gotArgs)
	}
	out = filepath.Join(dir, "b0.mp3")
	if ExtractMp3Track(context.Background(), "/in/rec.mp4", out, 0, func(context.Context, string, []string, time.Duration) (string, error) {
		return "", errors.New("boom")
	}) {
		t.Fatal("ffmpeg failure → false")
	}
	if ExtractMp3Track(context.Background(), "/in/rec.mp4", out, 0, func(context.Context, string, []string, time.Duration) (string, error) { return "", nil }) {
		t.Fatal("no output → false")
	}
}

func TestSrtKeyForVod(t *testing.T) {
	for in, want := range map[string]string{
		"rec-1699999999.mp4": "rec-1699999999.srt", "streamhub/live/rec.mp4": "streamhub/live/rec.srt", "noext": "noext.srt",
		"  ": "transcripts/vod-42.srt",
	} {
		if got := SrtKeyForVod(sp(in), 42); got != want {
			t.Errorf("%q → %s", in, got)
		}
	}
	if got := SrtKeyForVod(nil, 42); got != "transcripts/vod-42.srt" {
		t.Fatal(got)
	}
}
