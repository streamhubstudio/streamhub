// Package restream is src/modules/restream: multi-destination RTMP forwarding
// of a live stream (AntMedia "endpoints") — one LiveKit stream egress per
// destination, per-endpoint state in the app's restream_targets table, masked
// URLs, a bounded relaunch-with-backoff on failure.
package restream

import (
	"errors"
	"regexp"
	"strings"
)

// Platforms are the supported destination platforms (`custom` = full URL).
var Platforms = []string{"youtube", "twitch", "facebook", "custom"}

type preset struct{ base, label string }

// presets are the well-known RTMP ingest bases (key appended as last segment).
var presets = map[string]preset{
	"youtube":  {"rtmp://a.rtmp.youtube.com/live2", "YouTube Live"},
	"twitch":   {"rtmp://live.twitch.tv/app", "Twitch"},
	"facebook": {"rtmps://live-api-s.facebook.com:443/rtmp", "Facebook Live"},
}

var (
	rtmpShape    = regexp.MustCompile(`(?i)^rtmps?://[^\s/]+(/\S*)?$`)
	keyForbidden = regexp.MustCompile(`[\s/]`)
	maskShape    = regexp.MustCompile(`(?i)^(rtmps?://[^/]+)(/.*)?$`)
	trailSlashes = regexp.MustCompile(`/+$`)
)

// IsRtmpURL is the loose rtmp(s)://host[/path] shape check.
func IsRtmpURL(url string) bool { return rtmpShape.MatchString(strings.TrimSpace(url)) }

// BuildTargetURL builds the destination push URL from platform + url/key;
// the error text is the 400 message.
func BuildTargetURL(platform, url, key string) (string, error) {
	key, url = strings.TrimSpace(key), strings.TrimSpace(url)
	if platform == "custom" {
		if url == "" {
			return "", errors.New("url is required for a custom destination")
		}
		if !IsRtmpURL(url) {
			return "", errors.New("url must start with rtmp:// or rtmps://")
		}
		if key == "" {
			return url, nil
		}
		return trailSlashes.ReplaceAllString(url, "") + "/" + key, nil
	}
	p, ok := presets[platform]
	if !ok {
		return "", errors.New("unknown platform '" + platform + "'")
	}
	if key == "" {
		return "", errors.New("stream key is required for " + p.label)
	}
	if keyForbidden.MatchString(key) {
		return "", errors.New("stream key must not contain spaces or slashes")
	}
	return p.base + "/" + key, nil
}

// MaskRtmpURL redacts the stream key (last path segment → first 4 chars + …;
// keys of ≤ 4 chars are fully hidden). URLs without a path are untouched.
func MaskRtmpURL(url string) string {
	raw := strings.TrimSpace(url)
	m := maskShape.FindStringSubmatch(raw)
	if m == nil {
		return raw
	}
	origin, path := m[1], m[2]
	if path == "" || path == "/" {
		return raw
	}
	cut := strings.LastIndex(path, "/")
	prefix, key := path[:cut+1], path[cut+1:]
	if key == "" {
		return raw
	}
	visible := ""
	if r := []rune(key); len(r) > 4 {
		visible = string(r[:4])
	}
	return origin + prefix + visible + "…"
}
