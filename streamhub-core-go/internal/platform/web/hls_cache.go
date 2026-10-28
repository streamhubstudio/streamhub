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
//     max-age + stale-while-revalidate (live) or 1h (finished, #EXT-X-ENDLIST).

// HLSSegmentDurationS matches the live HLS egress segment length.
const HLSSegmentDurationS = 4

const (
	segmentMaxAgeS          = 31536000
	finishedPlaylistMaxAgeS = 3600
)

// HLSCacheHeaders returns Cache-Control / Content-Type / CORS for an /hls file.
func HLSCacheHeaders(file string, cdn, finished bool) map[string]string {
	h := map[string]string{"Access-Control-Allow-Origin": "*"}
	switch {
	case strings.HasSuffix(file, ".ts"):
		h["Content-Type"] = "video/mp2t"
		h["Cache-Control"] = fmt.Sprintf("public, max-age=%d, immutable", segmentMaxAgeS)
	case strings.HasSuffix(file, ".m3u8"):
		h["Content-Type"] = "application/vnd.apple.mpegurl"
		switch {
		case !cdn:
			h["Cache-Control"] = "no-cache, no-store, must-revalidate"
		case finished:
			h["Cache-Control"] = fmt.Sprintf("public, max-age=%d", finishedPlaylistMaxAgeS)
		default:
			h["Cache-Control"] = fmt.Sprintf("public, max-age=1, stale-while-revalidate=%d", max(1, HLSSegmentDurationS/2))
		}
	}
	return h
}

// playlistIsFinished reports whether a playlist carries #EXT-X-ENDLIST.
func playlistIsFinished(file string) bool {
	b, err := os.ReadFile(file)
	return err == nil && bytes.Contains(b, []byte("#EXT-X-ENDLIST"))
}
