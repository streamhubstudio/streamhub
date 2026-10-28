// Package transcription is modules/transcription: per-VOD transcription
// (ffmpeg audio extraction → local faster-whisper worker via a file job
// exchange, or the OpenAI API) → merged speaker-labelled segments → SRT
// uploaded next to the VOD + the vod_transcripts row.
package transcription

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of transcription.util.ts.

// Segment is one transcript segment (seconds).
type Segment struct {
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
	Speaker *string `json:"speaker"`
}

// TrackTranscript is one transcribed audio track.
type TrackTranscript struct {
	Speaker  *string
	Segments []Segment
}

// Runner runs a command (bin, args, timeout) → stdout.
type Runner func(ctx context.Context, bin string, args []string, timeout time.Duration) (string, error)

// ExecRunner is the default os/exec runner.
func ExecRunner(ctx context.Context, bin string, args []string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	return string(out), err
}

const (
	extractTimeout = 15 * time.Minute
	probeTimeout   = 30 * time.Second
	minCueSeconds  = 0.5
)

// jsRound is Math.round.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// FormatSrtTimestamp is HH:MM:SS,mmm (clamped at 0).
func FormatSrtTimestamp(seconds float64) string {
	if math.IsNaN(seconds) {
		seconds = 0
	}
	total := int64(math.Max(0, jsRound(seconds*1000)))
	pad := func(n int64, w int) string {
		s := strconv.FormatInt(n, 10)
		for len(s) < w {
			s = "0" + s
		}
		return s
	}
	return pad(total/3600000, 2) + ":" + pad(total/60000%60, 2) + ":" + pad(total/1000%60, 2) + "," + pad(total%1000, 3)
}

func sortSegments(s []Segment) {
	sort.SliceStable(s, func(i, j int) bool {
		if s[i].Start != s[j].Start {
			return s[i].Start < s[j].Start
		}
		return s[i].End < s[j].End
	})
}

func label(s Segment) string {
	t := y.Trim(s.Text)
	if s.Speaker != nil && *s.Speaker != "" {
		return "[" + *s.Speaker + "] " + t
	}
	return t
}

// BuildSrt renders a SubRip document.
func BuildSrt(segments []Segment) string {
	var ordered []Segment
	for _, s := range segments {
		if y.Trim(s.Text) != "" {
			ordered = append(ordered, s)
		}
	}
	sortSegments(ordered)
	cues := make([]string, len(ordered))
	for i, s := range ordered {
		end := math.Max(s.End, s.Start+minCueSeconds)
		cues[i] = strconv.Itoa(i+1) + "\n" + FormatSrtTimestamp(s.Start) + " --> " + FormatSrtTimestamp(end) + "\n" + label(s)
	}
	if len(cues) == 0 {
		return ""
	}
	return strings.Join(cues, "\n\n") + "\n"
}

// MergeTrackSegments flattens per-track segments, chronologically.
func MergeTrackSegments(tracks []TrackTranscript) []Segment {
	out := []Segment{}
	for _, t := range tracks {
		for _, s := range t.Segments {
			out = append(out, Segment{Start: s.Start, End: s.End, Text: s.Text, Speaker: t.Speaker})
		}
	}
	sortSegments(out)
	return out
}

// PlainTranscriptText is one `[speaker] text` line per segment.
func PlainTranscriptText(segments []Segment) string {
	var lines []string
	for _, s := range segments {
		if y.Trim(s.Text) != "" {
			lines = append(lines, label(s))
		}
	}
	return strings.Join(lines, "\n")
}

// CollectSpeakers lists distinct speakers in first-appearance order.
func CollectSpeakers(segments []Segment) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range segments {
		if s.Speaker != nil && *s.Speaker != "" && !seen[*s.Speaker] {
			seen[*s.Speaker] = true
			out = append(out, *s.Speaker)
		}
	}
	return out
}

// Mp3ExtractArgs extracts one audio stream to a 16 kHz mono MP3.
func Mp3ExtractArgs(source, out string, index int) []string {
	return []string{"-y", "-i", source, "-vn", "-map", "0:a:" + strconv.Itoa(index), "-c:a", "libmp3lame",
		"-b:a", "128k", "-ac", "1", "-ar", "16000", out}
}

// AudioProbeArgs lists only the audio streams as JSON.
func AudioProbeArgs(source string) []string {
	return []string{"-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "a", source}
}

// ProbeAudioStreamCount is the number of audio streams (-1 = probe failed).
func ProbeAudioStreamCount(ctx context.Context, source string, run Runner) int {
	out, err := run(ctx, "ffprobe", AudioProbeArgs(source), probeTimeout)
	if err != nil {
		return -1
	}
	var parsed struct {
		Streams json.RawMessage `json:"streams"`
	}
	if json.Unmarshal([]byte(out), &parsed) != nil {
		return -1
	}
	var list []json.RawMessage
	if json.Unmarshal(parsed.Streams, &list) != nil {
		return 0
	}
	return len(list)
}

// ExtractMp3Track extracts one stream; true when the output exists.
func ExtractMp3Track(ctx context.Context, source, out string, index int, run Runner) bool {
	if os.MkdirAll(filepath.Dir(out), 0o777) != nil {
		return false
	}
	if _, err := run(ctx, "ffmpeg", Mp3ExtractArgs(source, out, index), extractTimeout); err != nil {
		return false
	}
	_, err := os.Stat(out)
	return err == nil
}

var extSuffix = regexp.MustCompile(`\.[^./\\]+$`)

// SrtKeyForVod puts the SRT next to the recording in S3.
func SrtKeyForVod(fileKey *string, vodID int64) string {
	if fileKey != nil && strings.TrimSpace(*fileKey) != "" {
		return extSuffix.ReplaceAllString(*fileKey, "") + ".srt"
	}
	return "transcripts/vod-" + strconv.FormatInt(vodID, 10) + ".srt"
}
