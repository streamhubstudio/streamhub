package recording

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Runner runs an external binary (ffmpeg / ffprobe / shaka packager) and
// returns its stdout — execFile with a timeout. Behind an interface so tests
// record the exact argument vectors and never spawn anything.
type Runner interface {
	Run(ctx context.Context, bin string, args []string, timeout time.Duration) ([]byte, error)
}

// ExecRunner is the real os/exec Runner (execFile semantics: non-zero exit,
// timeout or a missing binary are errors).
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, bin string, args []string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdout = &out
	err := cmd.Run()
	return out.Bytes(), err
}

// ---------------------------------------------------------------------------
// media.util.ts — ffprobe metadata + ffmpeg snapshot
// ---------------------------------------------------------------------------

// ProbedMedia is the subset of ffprobe output the VOD rows keep.
type ProbedMedia struct {
	Width     *float64 `json:"width"`
	Height    *float64 `json:"height"`
	DurationS *float64 `json:"durationS"`
	Format    *string  `json:"format"`
}

// ProbeArgs is the ffprobe argv for a source (local path or URL).
func ProbeArgs(source string) []string {
	return []string{"-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", source}
}

// ProbeMedia runs ffprobe (30 s); any failure → all-null.
func ProbeMedia(ctx context.Context, r Runner, source string) ProbedMedia {
	out, err := r.Run(ctx, "ffprobe", ProbeArgs(source), 30*time.Second)
	if err != nil {
		return ProbedMedia{}
	}
	var parsed struct {
		Streams []struct {
			CodecType string   `json:"codec_type"`
			CodecName *string  `json:"codec_name"`
			Width     *float64 `json:"width"`
			Height    *float64 `json:"height"`
			Duration  *string  `json:"duration"`
		} `json:"streams"`
		Format *struct {
			Duration   *string `json:"duration"`
			FormatName *string `json:"format_name"`
		} `json:"format"`
	}
	if json.Unmarshal(out, &parsed) != nil {
		return ProbedMedia{}
	}
	var m ProbedMedia
	idx := -1
	for i, s := range parsed.Streams {
		if s.CodecType == "video" {
			idx = i
			break
		}
	}
	var durRaw *string
	if idx >= 0 {
		v := parsed.Streams[idx]
		m.Width, m.Height, durRaw, m.Format = v.Width, v.Height, v.Duration, v.CodecName
	}
	if durRaw == nil && parsed.Format != nil {
		durRaw = parsed.Format.Duration
	}
	if m.Format == nil && parsed.Format != nil {
		m.Format = parsed.Format.FormatName
	}
	if durRaw != nil && *durRaw != "" {
		if d := jsParseFloat(*durRaw); !math.IsNaN(d) && !math.IsInf(d, 0) {
			m.DurationS = &d
		}
	}
	return m
}

var floatPrefix = regexp.MustCompile(`^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)`)

// jsParseFloat is parseFloat (leading whitespace, longest numeric prefix).
func jsParseFloat(s string) float64 {
	m := floatPrefix.FindString(strings.TrimLeft(s, " \t\n\r\v\f"))
	if m == "" {
		return math.NaN()
	}
	switch strings.TrimLeft(m, "+-") {
	case "Infinity":
		if strings.HasPrefix(m, "-") {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	f, err := strconv.ParseFloat(m, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// SnapshotArgs is the ffmpeg argv extracting one JPEG at atSeconds.
func SnapshotArgs(source, out string, atSeconds float64) []string {
	return []string{"-y", "-ss", jsNum(math.Max(0, atSeconds)), "-i", source, "-frames:v", "1", "-q:v", "2", out}
}

// ExtractSnapshot runs ffmpeg (60 s); false on any failure.
func ExtractSnapshot(ctx context.Context, r Runner, source, out string, atSeconds float64) bool {
	_, err := r.Run(ctx, "ffmpeg", SnapshotArgs(source, out, atSeconds), 60*time.Second)
	return err == nil
}

func jsNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// ---------------------------------------------------------------------------
// filename-template.ts
// ---------------------------------------------------------------------------

// TemplateTokens feed renderFilenameTemplate.
type TemplateTokens struct {
	App, StreamID, Room, Type string
	Variables                 map[string]string
	Now                       time.Time
}

func p2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// FormatDate expands yyyy/yy/MM/dd/HH/mm/ss (UTC) in one left-to-right scan.
func FormatDate(f string, t time.Time) string {
	t = t.UTC()
	year := strconv.Itoa(t.Year())
	toks := [][2]string{
		{"yyyy", year}, {"yy", year[max(0, len(year)-2):]}, {"MM", p2(int(t.Month()))}, {"dd", p2(t.Day())},
		{"HH", p2(t.Hour())}, {"mm", p2(t.Minute())}, {"ss", p2(t.Second())},
	}
	var b strings.Builder
	for i := 0; i < len(f); {
		hit := false
		for _, tk := range toks {
			if strings.HasPrefix(f[i:], tk[0]) {
				b.WriteString(tk[1])
				i += len(tk[0])
				hit = true
				break
			}
		}
		if !hit {
			_, size := utf8.DecodeRuneInString(f[i:])
			b.WriteString(f[i : i+size])
			i += size
		}
	}
	return b.String()
}

func resolveToken(expr string, t TemplateTokens, now time.Time) string {
	e := jsTrim(expr)
	switch {
	case strings.HasPrefix(e, "date:"):
		return FormatDate(e[len("date:"):], now)
	case strings.HasPrefix(e, "var."):
		return t.Variables[e[len("var."):]]
	}
	switch e {
	case "app":
		return t.App
	case "streamId":
		return t.StreamID
	case "room":
		return t.Room
	case "type":
		return t.Type
	case "ts":
		return strconv.FormatInt(now.UnixMilli()/1000, 10)
	}
	return ""
}

var (
	unsafeRun  = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	dotRun     = regexp.MustCompile(`\.{2,}`)
	dashRun    = regexp.MustCompile(`-{2,}`)
	edgeTrim   = regexp.MustCompile(`^[.\-]+|[.\-]+$`)
	tailTrim   = regexp.MustCompile(`[.\-]+$`)
	tplPattern = regexp.MustCompile(`\$\{([^}]*)\}`)
)

// SanitizeSegment makes one filesystem-safe path segment (no traversal).
func SanitizeSegment(raw string) string {
	s := unsafeRun.ReplaceAllString(raw, "-")
	s = dotRun.ReplaceAllString(s, ".")
	s = dashRun.ReplaceAllString(s, "-")
	s = edgeTrim.ReplaceAllString(s, "")
	if len(s) > 200 { // ASCII only after the replace above
		s = s[:200]
	}
	return tailTrim.ReplaceAllString(s, "")
}

// RenderFilenameTemplate expands ${…} tokens; "" for a blank template.
func RenderFilenameTemplate(template string, t TemplateTokens) string {
	tpl := jsTrim(template)
	if tpl == "" {
		return ""
	}
	now := t.Now
	if now.IsZero() {
		now = time.Now()
	}
	expanded := tplPattern.ReplaceAllStringFunc(tpl, func(m string) string {
		return resolveToken(m[2:len(m)-1], t, now)
	})
	return SanitizeSegment(expanded)
}

// jsTrim is String#trim.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}
