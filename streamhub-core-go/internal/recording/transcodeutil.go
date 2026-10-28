package recording

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of vod-transcode.util.ts: ffmpeg helpers for the VOD post-transcode
// pipeline (adaptive HLS ladder + WebM/VP8 alternate + DRM mezzanines). The
// argv builders are pure and byte-identical to Node's (testdata vectors);
// the run wrappers never error — false on any failure.

// transcodeTimeout is TRANSCODE_TIMEOUT_MS (long recordings are slow).
const transcodeTimeout = 30 * time.Minute

// num is a JS number → string (template literal / String()).
func xcNum(f float64) string { return yamljs.JSNumberString(f) }

// jsRound is Math.round.
func xcRound(f float64) float64 { return math.Floor(f + 0.5) }

var bitrateTable = map[float64]float64{2160: 12000, 1440: 8000, 1080: 5000, 720: 2800, 480: 1400, 360: 800, 240: 500, 144: 250}

// BitrateForHeight is the default video kbps: table hit or max(200, round(h·3.5)).
func BitrateForHeight(height float64) float64 {
	if b, ok := bitrateTable[height]; ok {
		return b
	}
	return math.Max(200, xcRound(height*3.5))
}

// ResolveVodRenditions is the effective VOD ladder: explicit
// transcoding.vodRenditions, else derived from webrtc.layers; floored,
// filtered (144..4320, bitrate > 0), deduped by height, sorted descending,
// capped at 5.
func ResolveVodRenditions(cfg *contracts.AppConfig) []contracts.VodRendition {
	source := cfg.Transcoding.VodRenditions
	if len(source) == 0 {
		source = nil
		for _, l := range cfg.Webrtc.Layers {
			source = append(source, contracts.VodRendition{Height: l.Height, BitrateKbps: BitrateForHeight(l.Height)})
		}
	}
	seen := map[float64]bool{}
	out := []contracts.VodRendition{}
	for _, r := range source {
		h, b := math.Floor(r.Height), math.Floor(r.BitrateKbps)
		if math.IsNaN(h) || math.IsInf(h, 0) || h < 144 || h > 4320 || math.IsNaN(b) || math.IsInf(b, 0) || b <= 0 || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, contracts.VodRendition{Height: h, BitrateKbps: b})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Height > out[j].Height })
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}

func xcEven(n float64) float64 { return 2 * xcRound(n/2) }

// WidthForHeight keeps the source aspect (16:9 when unknown); always even.
// sourceWidth / sourceHeight nil = unknown.
func WidthForHeight(height float64, sourceWidth, sourceHeight *float64) float64 {
	aspect := 16.0 / 9.0
	if sourceWidth != nil && sourceHeight != nil && *sourceWidth != 0 && *sourceHeight > 0 {
		aspect = *sourceWidth / *sourceHeight
	}
	return xcEven(height * aspect)
}

// MasterPlaylistEntry is one EXT-X-STREAM-INF of the master playlist.
type MasterPlaylistEntry struct {
	URI         string
	Height      float64
	BitrateKbps float64
	Width       *float64 // nil → 16:9 from the height
}

// BuildMasterPlaylist renders the HLS master (BANDWIDTH = video + 128k audio).
func BuildMasterPlaylist(entries []MasterPlaylistEntry) string {
	lines := []string{"#EXTM3U", "#EXT-X-VERSION:3"}
	for _, e := range entries {
		bw := (e.BitrateKbps + 128) * 1000
		w := WidthForHeight(e.Height, nil, nil)
		if e.Width != nil {
			w = *e.Width
		}
		lines = append(lines,
			"#EXT-X-STREAM-INF:BANDWIDTH="+xcNum(bw)+",RESOLUTION="+xcNum(w)+"x"+xcNum(e.Height)+`,CODECS="avc1.4d401f,mp4a.40.2"`,
			e.URI)
	}
	return strings.Join(lines, "\n") + "\n"
}

// HlsContentType is the Content-Type for transcode / DRM output files.
func HlsContentType(file string) string {
	switch {
	case strings.HasSuffix(file, ".m3u8"):
		return "application/vnd.apple.mpegurl"
	case strings.HasSuffix(file, ".ts"):
		return "video/mp2t"
	case strings.HasSuffix(file, ".mp4"):
		return "video/mp4"
	case strings.HasSuffix(file, ".m4s"):
		return "video/iso.segment"
	}
	return "application/octet-stream"
}

// x264Args are the shared scaled H.264 + AAC encoder settings.
func x264Args(source string, r contracts.VodRendition) []string {
	k := r.BitrateKbps
	return []string{
		"-y", "-i", source,
		"-vf", "scale=-2:" + xcNum(r.Height),
		"-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast",
		"-b:v", xcNum(k) + "k", "-maxrate", xcNum(xcRound(k*1.07)) + "k", "-bufsize", xcNum(k*2) + "k",
		"-c:a", "aac", "-b:a", "128k", "-ac", "2",
	}
}

// HlsRenditionArgs is the ffmpeg argv of one HLS rendition under outDir.
func HlsRenditionArgs(source, outDir string, r contracts.VodRendition, segSeconds int) []string {
	return append(x264Args(source, r),
		"-hls_time", xcNum(float64(segSeconds)), "-hls_playlist_type", "vod", "-hls_list_size", "0",
		"-hls_segment_filename", filepath.Join(outDir, "seg_%04d.ts"), filepath.Join(outDir, "index.m3u8"))
}

// RenditionMp4Args is the ffmpeg argv of one DRM mezzanine MP4.
func RenditionMp4Args(source, outPath string, r contracts.VodRendition) []string {
	return append(x264Args(source, r), "-movflags", "+faststart", outPath)
}

// WebmVp8Args is the ffmpeg argv of the WebM/VP8 (+Opus) alternate.
func WebmVp8Args(source, outPath string, kbps float64) []string {
	return []string{
		"-y", "-i", source, "-c:v", "libvpx", "-b:v", xcNum(kbps) + "k", "-deadline", "good", "-cpu-used", "2",
		"-c:a", "libopus", "-b:a", "128k", outPath,
	}
}

// TranscodeHlsRendition transcodes one rendition (seg 0 → 4 s); true when
// outDir/index.m3u8 exists afterwards.
func TranscodeHlsRendition(ctx context.Context, run Runner, source, outDir string, r contracts.VodRendition, segSeconds int) bool {
	if segSeconds == 0 {
		segSeconds = 4
	}
	if os.MkdirAll(outDir, 0o777) != nil {
		return false
	}
	if _, err := run.Run(ctx, "ffmpeg", HlsRenditionArgs(source, outDir, r, segSeconds), transcodeTimeout); err != nil {
		return false
	}
	return xcExists(filepath.Join(outDir, "index.m3u8"))
}

// TranscodeRenditionMp4 writes one mezzanine MP4 (DRM path).
func TranscodeRenditionMp4(ctx context.Context, run Runner, source, outPath string, r contracts.VodRendition) bool {
	if os.MkdirAll(filepath.Dir(outPath), 0o777) != nil {
		return false
	}
	if _, err := run.Run(ctx, "ffmpeg", RenditionMp4Args(source, outPath, r), transcodeTimeout); err != nil {
		return false
	}
	return xcExists(outPath)
}

// TranscodeWebmVp8 writes the WebM/VP8 alternate (kbps 0 → 2500).
func TranscodeWebmVp8(ctx context.Context, run Runner, source, outPath string, kbps float64) bool {
	if kbps == 0 {
		kbps = 2500
	}
	if os.MkdirAll(filepath.Dir(outPath), 0o777) != nil {
		return false
	}
	if _, err := run.Run(ctx, "ffmpeg", WebmVp8Args(source, outPath, kbps), transcodeTimeout); err != nil {
		return false
	}
	return xcExists(outPath)
}
