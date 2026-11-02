// Package playback is the access control of anonymous playback (G2, 3.4.0):
//
//   - signed HLS: apps with features.public_playback:false only serve /hls
//     to a request carrying ?st=<exp>.<mac>, an HMAC over (app, room dir,
//     exp) minted by the core (token.go); the core rewrites the playlist so
//     every segment / key / variant URI carries the same token
//     (web.RewritePlaylist);
//   - geo-blocking: features.geo allow/deny lists against a local GeoLite2
//     base (STREAMHUB_GEOIP_DB), applied to play-token, /hls and the RTMP
//     publishes that go through the core (geo.go);
//   - the play-auth webhook: features.play_auth.webhook_url is consulted
//     before every anonymous playback grant (webhook.go).
//
// Guard (guard.go) ties them to the per-app config; /hls and the direct-serve
// auth endpoint /hls-auth (platform/web, through web.HLSGate), the livekit
// token routes, the streams playlistUrl and the MediaMTX publish hook call it.
package playback

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// hlsKeyLabel domain-separates the HLS token key from every other use of
// the server secret (the JWT signer, the signed play-token URLs).
const hlsKeyLabel = "streamhub/playback/hls-token/v1"

// HLS token lifetime (seconds): features.hls_token_ttl_seconds, clamped by
// the apps resolver into [60, 86400]; DefaultTTL matches the 6h LiveKit
// token the public play-token mints.
const DefaultTTL = 21600

// DeriveKey derives the HLS token key from the server secret
// (HMAC-SHA256(secret, label), a one-step HKDF-Expand with a fixed label):
// the raw secret never signs a token. "" (no secret) yields nil, and a nil
// key verifies nothing — private apps then fail closed.
func DeriveKey(secret string) []byte {
	if secret == "" {
		return nil
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(hlsKeyLabel))
	return m.Sum(nil)
}

// mac is the HMAC over the length-prefixed (app, dir, exp): the prefixes
// make the encoding injective whatever bytes the path segments carry.
func mac(key []byte, app, dir string, exp int64) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("hls|" + strconv.Itoa(len(app)) + ":" + app + "|" + strconv.Itoa(len(dir)) + ":" + dir +
		"|" + strconv.FormatInt(exp, 10)))
	return m.Sum(nil)
}

// SignHLS mints st=<exp>.<base64url(mac)> for one room directory of an app
// (the <room> segment of /hls/<app>/<room>/…). exp is unix seconds.
func SignHLS(key []byte, app, dir string, exp int64) string {
	return strconv.FormatInt(exp, 10) + "." + base64.RawURLEncoding.EncodeToString(mac(key, app, dir, exp))
}

// Verdict is the outcome of a token check.
type Verdict string

const (
	TokenOK      Verdict = "ok"
	TokenExpired Verdict = "expired"
	TokenInvalid Verdict = "invalid"
	TokenMissing Verdict = "missing"
)

var stPattern = regexp.MustCompile(`^(\d{1,12})\.([A-Za-z0-9_-]{43})$`)

// VerifyHLS checks st for (app, dir): the MAC first, compared in constant
// time, then the expiry — an expired token is only reported as such once it
// is proven authentic.
func VerifyHLS(key []byte, app, dir, st string, now time.Time) Verdict {
	if st == "" {
		return TokenMissing
	}
	m := stPattern.FindStringSubmatch(strings.TrimSpace(st))
	if m == nil || len(key) == 0 {
		return TokenInvalid
	}
	exp, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return TokenInvalid
	}
	got, err := base64.RawURLEncoding.Strict().DecodeString(m[2])
	if err != nil || !hmac.Equal(got, mac(key, app, dir, exp)) {
		return TokenInvalid
	}
	if exp < now.Unix() {
		return TokenExpired
	}
	return TokenOK
}

// TTLOr is the configured TTL, else DefaultTTL.
func TTLOr(configured int64) int64 {
	if configured > 0 {
		return configured
	}
	return DefaultTTL
}
