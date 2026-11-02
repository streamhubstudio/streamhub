package web

import (
	"bytes"
	"regexp"
	"strings"
)

// HLSTokenParam is the query parameter that carries the HLS token
// (playback.SignHLS mints it).
const HLSTokenParam = "st"

// Segment URIs carry the token through playlist REWRITING rather than a path
// cookie: a query token works in every player (hls.js, Safari/AVPlayer,
// ExoPlayer, ffmpeg, smart TVs) and in third-party embeds, where a cookie on
// the media origin is a third-party cookie that ITP / ETP / 3PC phase-out
// drop. The direct-serve proxies keep working: they send every playlist to
// the core (tiny, no-cache) and only the segments go straight from disk,
// after an auth_request / forward_auth subrequest (hlsAuthHandler).

var (
	uriAttr   = regexp.MustCompile(`URI="([^"]*)"`)
	hasScheme = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
)

// RewritePlaylist appends st=<token> to every RELATIVE URI of an m3u8: the
// URI lines (segments, variant playlists) and the URI="…" attribute of the
// tags (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF,
// EXT-X-PART, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT…). Absolute URIs
// (a scheme or //host) are left alone so the token never leaks to another
// origin; skd:/data: key URIs have a scheme too. Line endings are kept.
func RewritePlaylist(body []byte, token string) []byte {
	if token == "" {
		return body
	}
	lines := bytes.Split(body, []byte("\n"))
	for i, raw := range lines {
		line := string(raw)
		cr := ""
		if strings.HasSuffix(line, "\r") {
			line, cr = line[:len(line)-1], "\r"
		}
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			continue
		case strings.HasPrefix(trimmed, "#"):
			if !strings.Contains(line, `URI="`) {
				continue
			}
			line = uriAttr.ReplaceAllStringFunc(line, func(attr string) string {
				v := uriAttr.FindStringSubmatch(attr)[1]
				return `URI="` + withToken(v, token) + `"`
			})
		default:
			line = withToken(trimmed, token)
		}
		lines[i] = []byte(line + cr)
	}
	return bytes.Join(lines, []byte("\n"))
}

// withToken appends the token to a relative URI (before any #fragment).
func withToken(u, token string) string {
	if u == "" || hasScheme.MatchString(u) || strings.HasPrefix(u, "//") {
		return u
	}
	frag := ""
	if i := strings.IndexByte(u, '#'); i >= 0 {
		u, frag = u[:i], u[i:]
	}
	sep := "?"
	if strings.Contains(u, "?") {
		sep = "&"
		if strings.HasSuffix(u, "?") || strings.HasSuffix(u, "&") {
			sep = ""
		}
	}
	return u + sep + HLSTokenParam + "=" + token + frag
}

// WithHLSToken appends st=<token> to a playlist URL (absolute or not) — what
// the core puts in the playlistUrl it hands out. "" leaves the URL as is.
func WithHLSToken(rawURL, token string) string {
	if token == "" {
		return rawURL
	}
	frag := ""
	if i := strings.IndexByte(rawURL, '#'); i >= 0 {
		rawURL, frag = rawURL[:i], rawURL[i:]
	}
	sep := "?"
	if strings.Contains(rawURL, "?") {
		sep = "&"
	}
	return rawURL + sep + HLSTokenParam + "=" + token + frag
}
