package security

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Generic bodies — deliberately reveal nothing about which rule/ban matched.
var (
	blockedBody = httpx.Envelope{Error: &httpx.EnvelopeError{Code: "forbidden", Message: "Access denied"}}
	bannedBody  = httpx.Envelope{Error: &httpx.EnvelopeError{Code: "rate_limited", Message: "Too many requests. Please retry later."}}
)

type ipAccessKey struct{}

// WouldBlock reports the log-mode annotation (req.ipAccess === 'would_block').
func WouldBlock(ctx context.Context) bool { v, _ := ctx.Value(ipAccessKey{}).(bool); return v }

// Middleware is SecurityMiddleware: one early hook on every path. Order:
// loopback/RFC1918 pass → explicit allow pass → active auto-ban 429 →
// block/allowlist-only 403 in enforce mode (log mode annotates only).
func Middleware(s Settings, rules *Rules, rep *Reputation, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.Mode == "off" && !s.AutobanEnabled { // fully dormant
				next.ServeHTTP(w, r)
				return
			}
			ip := NormalizeIP(httpx.ClientIP(r))
			if ip == "" || IsPrivateOrLoopback(ip) {
				next.ServeHTTP(w, r)
				return
			}
			if s.AutobanEnabled && s.Autoban404Enabled {
				rec := &statusWriter{ResponseWriter: w}
				w = rec
				defer func() {
					if rec.status == http.StatusNotFound {
						rep.RecordOffense(ip, OffenseNotFound)
					}
				}()
			}
			match := rules.Evaluate(ip)
			if match == MatchAllow {
				next.ServeHTTP(w, r)
				return
			}
			if s.AutobanEnabled && rep.IsBanned(ip) {
				deny(w, r, log, ip, "banned", http.StatusTooManyRequests, bannedBody)
				return
			}
			if s.Mode == "off" || !(match == MatchBlock || s.AllowlistOnly) {
				next.ServeHTTP(w, r)
				return
			}
			why := "allowlist_only"
			if match == MatchBlock {
				why = "blocklist"
			}
			if s.Mode == "enforce" {
				deny(w, r, log, ip, why, http.StatusForbidden, blockedBody)
				return
			}
			log.Warn(fmt.Sprintf("ip-access would_block ip=%s why=%s mode=log method=%s path=%s", ip, why, r.Method, r.URL.Path))
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ipAccessKey{}, true)))
		})
	}
}

func deny(w http.ResponseWriter, r *http.Request, log *slog.Logger, ip, why string, status int, body any) {
	log.Warn(fmt.Sprintf("ip-access deny ip=%s why=%s status=%d method=%s path=%s", ip, why, status, r.Method, r.URL.Path))
	httpx.WriteJSON(w, status, body)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// UpgradeRejectReason is the verdict for a WebSocket upgrade ("" = allow).
type UpgradeRejectReason string

const (
	RejectBanned  UpgradeRejectReason = "banned"
	RejectBlocked UpgradeRejectReason = "blocked"
)

// NetworkGuard answers "reject this IP?" for non-HTTP entry points with the
// middleware's exact precedence (network-guard.service.ts).
type NetworkGuard struct {
	s     Settings
	rules *Rules
	rep   *Reputation
}

// NewNetworkGuard builds the guard.
func NewNetworkGuard(s Settings, rules *Rules, rep *Reputation) *NetworkGuard {
	return &NetworkGuard{s, rules, rep}
}

// RejectUpgradeReason returns banned/blocked or "" to let the peer through.
// A missing or unparseable IP is always allowed (fail-open).
func (g *NetworkGuard) RejectUpgradeReason(ip string) (reason UpgradeRejectReason) {
	if g.s.Mode == "off" && !g.s.AutobanEnabled || ip == "" {
		return ""
	}
	defer func() {
		if recover() != nil {
			reason = ""
		}
	}()
	norm := NormalizeIP(ip)
	if IsPrivateOrLoopback(norm) {
		return ""
	}
	match := g.rules.Evaluate(norm)
	if match == MatchAllow {
		return ""
	}
	if g.s.AutobanEnabled && g.rep.IsBanned(norm) {
		return RejectBanned
	}
	if g.s.Mode == "enforce" && (match == MatchBlock || g.s.AllowlistOnly) {
		return RejectBlocked
	}
	return ""
}
