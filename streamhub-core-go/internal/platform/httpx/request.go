package httpx

import (
	"context"
	"net"
	"net/http"
	"strings"
)

// ClientIP mirrors Express with `trust proxy = 1`: behind exactly one reverse
// proxy (Caddy/nginx) the client is the right-most X-Forwarded-For entry; with
// no header it is the socket peer. IPv4-mapped IPv6 is unwrapped like req.ip.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return normalizeIP(ip)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return normalizeIP(host)
}

func normalizeIP(ip string) string {
	return strings.TrimPrefix(ip, "::ffff:")
}

// BearerToken extracts the token from "Authorization: Bearer <t>" ("" if none).
func BearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

type requestKey struct{}

// WithRequest stashes the inbound *http.Request in its context so huma
// handlers (which only see a context) can read the client IP and headers —
// the Express `@Req()` equivalent.
func WithRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestKey{}, r)))
	})
}

// RequestFrom returns the request stashed by WithRequest (nil outside one).
func RequestFrom(ctx context.Context) *http.Request {
	r, _ := ctx.Value(requestKey{}).(*http.Request)
	return r
}
