package httpx

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Port of shared/http/auth-rate-limit.ts (Fase-0 M6): express-rate-limit on
// the credential-guessing endpoints only, never the whole API.

// AuthRateLimitPaths are the limited path prefixes (app.use(path) semantics:
// the path itself or anything below it).
var AuthRateLimitPaths = []string{
	"/api/v1/auth/login",
	"/api/v1/auth/magic-link",
	"/api/v1/auth/magic/verify",
}

// rateLimitedBody is the 429 body (also the default handler's message).
var rateLimitedBody = Envelope{Error: &EnvelopeError{
	Code:    "rate_limited",
	Message: "Too many attempts. Please retry later.",
}}

// RateLimiter is express-rate-limit's MemoryStore + draft-7 headers: a fixed
// window per client key that starts on the key's first hit.
type RateLimiter struct {
	window time.Duration
	limit  int
	paths  []string
	now    func() time.Time

	mu        sync.Mutex
	clients   map[string]*rlClient
	nextSweep time.Time
	reporter  func(ip string)
}

type rlClient struct {
	hits    int
	resetAt time.Time
}

// NewAuthRateLimiter reads AUTH_RATE_LIMIT_MAX (10) and
// AUTH_RATE_LIMIT_WINDOW_MS (900000); non-positive/invalid → default.
func NewAuthRateLimiter(env func(string) string) *RateLimiter {
	return NewRateLimiter(
		time.Duration(envPositive(env, "AUTH_RATE_LIMIT_WINDOW_MS", 15*60*1000))*time.Millisecond,
		envPositive(env, "AUTH_RATE_LIMIT_MAX", 10),
		AuthRateLimitPaths,
	)
}

// NewRateLimiter limits the given path prefixes.
func NewRateLimiter(window time.Duration, limit int, paths []string) *RateLimiter {
	return &RateLimiter{window: window, limit: limit, paths: paths, now: time.Now, clients: map[string]*rlClient{}}
}

// SetOffenseReporter installs the security module's hook (a 429 counts as an
// offense for the auto-ban). nil clears it.
func (l *RateLimiter) SetOffenseReporter(fn func(ip string)) {
	l.mu.Lock()
	l.reporter = fn
	l.mu.Unlock()
}

func envPositive(env func(string) string, name string, fallback int) int {
	raw := env(name)
	if raw == "" {
		return fallback
	}
	n, err := parseIntPrefix(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func parseIntPrefix(s string) (int, error) {
	var n int
	_, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &n)
	return n, err
}

func (l *RateLimiter) matches(path string) bool {
	for _, p := range l.paths {
		if len(path) >= len(p) && strings.EqualFold(path[:len(p)], p) &&
			(len(path) == len(p) || path[len(p)] == '/') {
			return true
		}
	}
	return false
}

// Middleware applies the limiter to the configured paths.
func (l *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.matches(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		ip := ClientIP(r)
		hits, resetAt := l.increment(rateKey(ip))
		now := l.now()
		resetS := int(math.Max(0, math.Ceil(float64(resetAt.Sub(now))/float64(time.Second))))
		remaining := l.limit - hits
		if remaining < 0 {
			remaining = 0
		}
		h := w.Header()
		h.Set("RateLimit-Policy", fmt.Sprintf("%d;w=%d", l.limit, int(math.Ceil(l.window.Seconds()))))
		h.Set("RateLimit", fmt.Sprintf("limit=%d, remaining=%d, reset=%d", l.limit, remaining, resetS))
		if hits > l.limit {
			h.Set("Retry-After", fmt.Sprint(resetS))
			l.report(ip)
			WriteJSON(w, http.StatusTooManyRequests, rateLimitedBody)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (l *RateLimiter) report(ip string) {
	l.mu.Lock()
	fn := l.reporter
	l.mu.Unlock()
	if fn == nil || ip == "" {
		return
	}
	defer func() { _ = recover() }() // never break the 429 path
	fn(ip)
}

func (l *RateLimiter) increment(key string) (int, time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.After(l.nextSweep) {
		for k, c := range l.clients {
			if !c.resetAt.After(now) {
				delete(l.clients, k)
			}
		}
		l.nextSweep = now.Add(l.window)
	}
	c := l.clients[key]
	if c == nil || !c.resetAt.After(now) {
		c = &rlClient{resetAt: now.Add(l.window)}
		l.clients[key] = c
	}
	c.hits++
	return c.hits, c.resetAt
}

// rateKey is ipKeyGenerator: IPv4 as-is, IPv6 grouped by its /56.
func rateKey(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() != nil {
		return ip
	}
	return (&net.IPNet{IP: parsed.Mask(net.CIDRMask(56, 128)), Mask: net.CIDRMask(56, 128)}).String()
}
