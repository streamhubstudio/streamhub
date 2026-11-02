package web

import (
	"bytes"
	"fmt"
	"os"
	"strings"
)

// Cache policy for /hls, ported from modules/streams/hls-cache.ts:
//   - .ts segments are immutable → 1y + immutable (always);
//   - .m3u8 playlists: no-cache unless STREAMHUB_HLS_CDN, then a short
//     max-age + stale-while-revalidate (live; HLSCachePolicy) or 1h
//     (finished, #EXT-X-ENDLIST).

// HLSSegmentDurationS is the historical live HLS egress segment length (the
// STREAMHUB_HLS_SEGMENT_S default).
const HLSSegmentDurationS = 4

const (
	segmentMaxAgeS          = 31536000
	finishedPlaylistMaxAgeS = 3600
)

// HLSCachePolicy is the live-playlist cache math under STREAMHUB_HLS_CDN.
type HLSCachePolicy struct {
	// SegmentS is the live segment length (STREAMHUB_HLS_SEGMENT_S): the
	// stale-while-revalidate window is half of it (>= 1 s). < 1 = 4.
	SegmentS int
	// PlaylistMaxAge is the live playlist max-age (STREAMHUB_HLS_PLAYLIST_MAX_AGE).
	// 0 = no TTL and no stale serving: `max-age=0, must-revalidate`, for an
	// edge that micro-caches on its own (proxy_cache_lock + a short
	// proxy_cache_valid) — ENV.md.
	PlaylistMaxAge int
}

// DefaultHLSCache is the historical policy: 4 s segments, max-age=1.
var DefaultHLSCache = HLSCachePolicy{SegmentS: HLSSegmentDurationS, PlaylistMaxAge: 1}

// livePlaylist is the Cache-Control of a live (unfinished) playlist.
func (p HLSCachePolicy) livePlaylist() string {
	if p.PlaylistMaxAge <= 0 {
		return "public, max-age=0, must-revalidate"
	}
	seg := p.SegmentS
	if seg < 1 {
		seg = HLSSegmentDurationS
	}
	return fmt.Sprintf("public, max-age=%d, stale-while-revalidate=%d", p.PlaylistMaxAge, max(1, seg/2))
}

// HLSCacheHeaders is DefaultHLSCache.Headers.
func HLSCacheHeaders(file string, cdn, finished bool) map[string]string {
	return DefaultHLSCache.Headers(file, cdn, finished)
}

// Headers returns Cache-Control / Content-Type / CORS for an /hls file.
func (p HLSCachePolicy) Headers(file string, cdn, finished bool) map[string]string {
	h := map[string]string{"Access-Control-Allow-Origin": "*"}
	switch {
	case strings.HasSuffix(file, ".ts"):
		h["Content-Type"] = "video/mp2t"
		h["Cache-Control"] = fmt.Sprintf("public, max-age=%d, immutable", segmentMaxAgeS)
	case strings.HasSuffix(file, ".m4s"):
		// fMP4 media segment (HEVC passthrough, E1): immutable like .ts
		h["Content-Type"] = "video/iso.segment"
		h["Cache-Control"] = fmt.Sprintf("public, max-age=%d, immutable", segmentMaxAgeS)
	case strings.HasSuffix(file, "/init.mp4") || file == "init.mp4":
		// fMP4 init segment: rewritten when the publish restarts
		h["Content-Type"] = "video/mp4"
		h["Cache-Control"] = "no-cache"
	case strings.HasSuffix(file, ".m3u8"):
		h["Content-Type"] = "application/vnd.apple.mpegurl"
		switch {
		case !cdn:
			h["Cache-Control"] = "no-cache, no-store, must-revalidate"
		case finished:
			h["Cache-Control"] = fmt.Sprintf("public, max-age=%d", finishedPlaylistMaxAgeS)
		default:
			h["Cache-Control"] = p.livePlaylist()
		}
	}
	return h
}

// playlistIsFinished reports whether a playlist carries #EXT-X-ENDLIST.
func playlistIsFinished(file string) bool {
	b, err := os.ReadFile(file)
	return err == nil && bytes.Contains(b, []byte("#EXT-X-ENDLIST"))
}
