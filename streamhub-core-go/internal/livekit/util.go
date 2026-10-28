package livekit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// ---------------------------------------------------------------------------
// ingress-encoding.util.ts — the "efficient transcode profile" (presets only)
// ---------------------------------------------------------------------------

// TranscodeHeights are the allowed transcode resolution caps, ascending.
var TranscodeHeights = []int{360, 480, 720, 1080}

// DefaultTranscodeMaxHeight is the cap used when unset/invalid.
const DefaultTranscodeMaxHeight = 720

// SanitizeTranscodeMaxHeight snaps a raw transcode_max_height to one of the
// four tiers: garbage / non-positive ⇒ 720, out-of-set ⇒ the nearest tier
// (ties keep the earlier best, starting from 720 — the Node reduce).
func SanitizeTranscodeMaxHeight(v float64) int {
	n := math.Floor(v)
	for _, h := range TranscodeHeights {
		if n == float64(h) {
			return h
		}
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return DefaultTranscodeMaxHeight
	}
	best := DefaultTranscodeMaxHeight
	for _, h := range TranscodeHeights {
		if math.Abs(float64(h)-n) < math.Abs(float64(best)-n) {
			best = h
		}
	}
	return best
}

// BuildIngressVideoOptions is buildIngressVideoOptions: single-layer by
// default (1080 cap → 1080p preset, anything else → 720p), the matching
// 3-layer preset only for an explicit adaptive. maxHeight nil = unset.
func BuildIngressVideoOptions(maxHeight *float64, adaptive bool) *livekit.IngressVideoOptions {
	h := DefaultTranscodeMaxHeight
	if maxHeight != nil {
		h = SanitizeTranscodeMaxHeight(*maxHeight)
	}
	var preset livekit.IngressVideoEncodingPreset
	switch {
	case adaptive && h == 1080:
		preset = livekit.IngressVideoEncodingPreset_H264_1080P_30FPS_3_LAYERS
	case adaptive:
		preset = livekit.IngressVideoEncodingPreset_H264_720P_30FPS_3_LAYERS
	case h == 1080:
		preset = livekit.IngressVideoEncodingPreset_H264_1080P_30FPS_1_LAYER
	default:
		preset = livekit.IngressVideoEncodingPreset_H264_720P_30FPS_1_LAYER
	}
	return &livekit.IngressVideoOptions{
		Source:          livekit.TrackSource_CAMERA,
		EncodingOptions: &livekit.IngressVideoOptions_Preset{Preset: preset},
	}
}

// ---------------------------------------------------------------------------
// ingress-rtmp-url.util.ts
// ---------------------------------------------------------------------------

const (
	// DefaultRtmpHost is used when RTMP_PUBLIC_HOST is unset.
	DefaultRtmpHost = "media.digitalhub.com.ar"
	// RtmpPort is LiveKit ingress' plaintext RTMP port.
	RtmpPort = 1935
	// RtmpApp is the RTMP application segment before the stream key.
	RtmpApp = "live"
	// RtmpPassthroughPort is the passthrough front's default port.
	RtmpPassthroughPort = 1937
)

// RtmpURLConfig is the RTMP/RTMPS URL config snapshot.
type RtmpURLConfig struct {
	RtmpPublicHost  string
	RtmpsEnable     bool
	RtmpsPublicHost string
	RtmpsPort       int
}

// BuildRtmpURL is rtmp://<host>:1935/live/<key> ("" without a key).
func BuildRtmpURL(streamKey string, c RtmpURLConfig) string {
	if streamKey == "" {
		return ""
	}
	host := c.RtmpPublicHost
	if host == "" {
		host = DefaultRtmpHost
	}
	return fmt.Sprintf("rtmp://%s:%d/%s/%s", host, RtmpPort, RtmpApp, streamKey)
}

// BuildRtmpsURL is rtmps://<host>:<port>/live/<key>, only when RTMPS is on.
func BuildRtmpsURL(streamKey string, c RtmpURLConfig) string {
	if streamKey == "" || !c.RtmpsEnable {
		return ""
	}
	host := c.RtmpsPublicHost
	if host == "" {
		host = c.RtmpPublicHost
	}
	if host == "" {
		host = DefaultRtmpHost
	}
	return fmt.Sprintf("rtmps://%s:%d/%s/%s", host, c.RtmpsPort, RtmpApp, streamKey)
}

// BuildPassthroughRtmpURL is rtmp://<host>:<port>/<app>/<key>.
func BuildPassthroughRtmpURL(streamKey, host string, port int, app string) string {
	if streamKey == "" {
		return ""
	}
	if host == "" {
		host = DefaultRtmpHost
	}
	return fmt.Sprintf("rtmp://%s:%d/%s/%s", host, port, app, streamKey)
}

// BuildPassthroughSrtURL is srt://<host>:<port>?streamid=<key>.
func BuildPassthroughSrtURL(streamKey, host string, port int) string {
	if streamKey == "" {
		return ""
	}
	if host == "" {
		host = DefaultRtmpHost
	}
	return fmt.Sprintf("srt://%s:%d?streamid=%s", host, port, streamKey)
}

// ---------------------------------------------------------------------------
// playback-url.util.ts — signed short-lived playback URLs (P0-3)
// ---------------------------------------------------------------------------

const (
	DefaultPlaybackTTL = 300
	MinPlaybackTTL     = 30
	MaxPlaybackTTL     = 86400
)

// PlaybackSecretFor is HMAC-SHA256(master, "playback:<app>").
func PlaybackSecretFor(master, app string) []byte {
	m := hmac.New(sha256.New, []byte(master))
	m.Write([]byte("playback:" + app))
	return m.Sum(nil)
}

// SignPlayback is the hex HMAC over "app\nroom\nexp".
func SignPlayback(master, app, room string, exp int64) string {
	m := hmac.New(sha256.New, PlaybackSecretFor(master, app))
	fmt.Fprintf(m, "%s\n%s\n%d", app, room, exp)
	return hex.EncodeToString(m.Sum(nil))
}

// PlaybackVerdict is ok | expired | invalid.
type PlaybackVerdict string

const (
	PlaybackOK      PlaybackVerdict = "ok"
	PlaybackExpired PlaybackVerdict = "expired"
	PlaybackInvalid PlaybackVerdict = "invalid"
)

var (
	expPattern = regexp.MustCompile(`^\d{1,12}$`)
	sigPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// VerifyPlayback checks a signed playback URL: signature first (constant
// time), then expiry.
func VerifyPlayback(master, app, room, exp, sig string, now time.Time) PlaybackVerdict {
	if master == "" || !expPattern.MatchString(exp) {
		return PlaybackInvalid
	}
	n, _ := strconv.ParseInt(exp, 10, 64)
	sig = strings.ToLower(jsTrim(sig))
	if !sigPattern.MatchString(sig) {
		return PlaybackInvalid
	}
	a, _ := hex.DecodeString(sig)
	b, _ := hex.DecodeString(SignPlayback(master, app, room, n))
	if !hmac.Equal(a, b) {
		return PlaybackInvalid
	}
	if n*1000 < now.UnixMilli() {
		return PlaybackExpired
	}
	return PlaybackOK
}

// ClampPlaybackTTL clamps a requested TTL into [30, 86400] (300 when absent,
// non-finite or non-positive).
func ClampPlaybackTTL(ttl *float64) int64 {
	if ttl == nil || math.IsNaN(*ttl) || math.IsInf(*ttl, 0) || *ttl <= 0 {
		return DefaultPlaybackTTL
	}
	n := math.Floor(*ttl)
	return int64(math.Min(math.Max(n, MinPlaybackTTL), MaxPlaybackTTL))
}

// jsTrim is String#trim (JS whitespace + line terminators).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}

// ---------------------------------------------------------------------------
// ingress-url.guard.ts — SSRF guard for the URL-pull ingress
// ---------------------------------------------------------------------------

// AllowedPullSchemes are the schemes a pull ingress may use.
var AllowedPullSchemes = []string{"http:", "https:", "rtsp:", "rtsps:", "rtmp:", "rtmps:", "srt:"}

// AssertSafePullURL is assertSafePullUrl: scheme allowlist + host must not be
// / resolve to a private, loopback, link-local, metadata or unspecified
// address (every DNS answer checked). Failures are 400s.
func AssertSafePullURL(ctx context.Context, raw string, resolve security.HostResolver) error {
	// WHATWG `new URL` rejects a special scheme (http/https) without a host
	// outright, before the "has no host" check that non-special schemes hit.
	if u, err := url.Parse(raw); err == nil {
		s := strings.ToLower(u.Scheme)
		if (s == "http" || s == "https") && u.Hostname() == "" {
			return httpx.BadRequest(fmt.Sprintf("invalid ingress pull url: '%s'", raw))
		}
	}
	return security.AssertSafeEgressURL(ctx, raw, security.EgressOptions{
		AllowedSchemes: AllowedPullSchemes,
		Label:          "ingress pull url",
		Resolve:        resolve,
	})
}
