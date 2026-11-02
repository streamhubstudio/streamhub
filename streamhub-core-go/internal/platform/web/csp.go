package web

import (
	"net/http"
	"net/url"
	"strings"
)

// Dashboard CSP (security 3.3.4). Only the SPA handler sends it: /samples
// keeps its own sandbox CSP with `frame-ancestors *`, and /hls, /sdk, /live
// and the API are untouched, so every embeddable player stays embeddable.
//
// What it buys is script-src 'self' (no injected inline or third-party
// script), object-src/base-uri lockdown and, above all, frame-ancestors
// 'none' + X-Frame-Options: DENY against clickjacking of the dashboard.
// Media is deliberately loose: VOD plays from presigned per-app S3 URLs and
// HLS may come from a CDN, so img/media/connect allow https:; LiveKit
// signalling is wss:, so its PUBLIC_WS_URL origin is listed explicitly.
// 'unsafe-inline' styles: index.html and React/LiveKit components set
// inline style attributes.

// embeddablePrefixes are the SPA routes meant for third-party <iframe>s
// (the public /embed player and the /play share page): CSP without
// frame-ancestors restriction and no X-Frame-Options.
var embeddablePrefixes = []string{"/embed/", "/play/"}

// DashboardCSP builds the policy for publicWsURL (PUBLIC_WS_URL; "" = the
// SPA connects to LiveKit same-origin through /rtc, covered by 'self').
func DashboardCSP(publicWsURL string) string {
	connect := []string{"'self'"}
	connect = append(connect, liveKitOrigins(publicWsURL)...)
	connect = append(connect, "https:")
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https:",
		"media-src 'self' data: blob: https:",
		"font-src 'self' data:",
		"connect-src " + strings.Join(connect, " "),
		"worker-src 'self' blob:",
		"frame-src 'self' https:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
}

// liveKitOrigins is the websocket origin of PUBLIC_WS_URL plus its http(s)
// twin (livekit-client probes /rtc/validate over HTTP after a failed join).
func liveKitOrigins(raw string) []string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || strings.ContainsAny(u.Host, " ;,'\"") {
		return nil
	}
	switch strings.ToLower(u.Scheme) {
	case "wss", "https":
		return []string{"wss://" + u.Host, "https://" + u.Host}
	case "ws", "http":
		return []string{"ws://" + u.Host, "http://" + u.Host}
	}
	return nil
}

// setDashboardHeaders applies the policy to one SPA response; embeddable
// routes get it minus the anti-framing parts.
func setDashboardHeaders(h http.Header, csp, path string) {
	if csp == "" {
		return
	}
	if hasAnyPrefix(path, embeddablePrefixes) {
		h.Set("Content-Security-Policy", strings.Replace(csp, "frame-ancestors 'none'", "frame-ancestors *", 1))
		return
	}
	h.Set("Content-Security-Policy", csp)
	h.Set("X-Frame-Options", "DENY")
}
