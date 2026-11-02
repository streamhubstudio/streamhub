package authn

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// Throttle is the auth plane's own brute-force brake (security 3.3.4, M3) on
// everything that checks a password or a TOTP code: /auth/login,
// /auth/magic/verify (its 2FA code) and /account/2fa/{enable,disable}. In
// memory, per process, and independent of the security module's autoban
// (which is opt-in) and of the env-tunable AUTH_RATE_LIMIT_* window in front
// of the login routes:
//   - per client IP: at most IPMax attempts per minute;
//   - per account: after FailMax consecutive failures the account is locked
//     for BaseDelay, doubling on every further failure up to MaxDelay; a
//     success clears it. A locked account is refused even with the right
//     password, without checking it.
//
// Refusals are 429 with Retry-After (seconds) and retryAfterSeconds.
type Throttle struct {
	ipMax     int
	failMax   int
	window    time.Duration
	baseDelay time.Duration
	maxDelay  time.Duration
	now       func() time.Time

	mu        sync.Mutex
	ips       map[string]*ipHits
	accounts  map[string]*accountFails
	nextSweep time.Time
}

type ipHits struct {
	hits    int
	resetAt time.Time
}

type accountFails struct {
	fails       int
	lockedUntil time.Time
	last        time.Time
}

// ThrottleConfig: a zero IPMax / FailMax turns that dimension off.
type ThrottleConfig struct {
	IPMax     int           // attempts per IP per Window
	FailMax   int           // consecutive failures before the backoff starts
	Window    time.Duration // default 1 min
	BaseDelay time.Duration // first lockout, default 30s
	MaxDelay  time.Duration // cap, default 15 min
}

// Throttle defaults (env STREAMHUB_AUTH_IP_LIMIT / STREAMHUB_AUTH_ACCOUNT_FAILS).
const (
	defaultAuthIPLimit      = 10
	defaultAuthAccountFails = 5
)

// ThrottleConfigFromEnv reads STREAMHUB_AUTH_IP_LIMIT (attempts per IP per
// minute, default 10) and STREAMHUB_AUTH_ACCOUNT_FAILS (failures before the
// lockout, default 5); 0 disables that dimension, garbage → default.
func ThrottleConfigFromEnv(env func(string) string) ThrottleConfig {
	read := func(name string, def int) int {
		raw := strings.TrimSpace(env(name))
		if raw == "" {
			return def
		}
		n, ok := config.ParseIntPrefix(raw)
		if !ok || n < 0 {
			return def
		}
		return n
	}
	return ThrottleConfig{
		IPMax:   read("STREAMHUB_AUTH_IP_LIMIT", defaultAuthIPLimit),
		FailMax: read("STREAMHUB_AUTH_ACCOUNT_FAILS", defaultAuthAccountFails),
	}
}

// NewThrottle builds a throttle on the given clock (nil = time.Now).
func NewThrottle(c ThrottleConfig, now func() time.Time) *Throttle {
	if c.Window <= 0 {
		c.Window = time.Minute
	}
	if c.BaseDelay <= 0 {
		c.BaseDelay = 30 * time.Second
	}
	if c.MaxDelay <= 0 {
		c.MaxDelay = 15 * time.Minute
	}
	if now == nil {
		now = time.Now
	}
	return &Throttle{
		ipMax: c.IPMax, failMax: c.FailMax, window: c.Window, baseDelay: c.BaseDelay, maxDelay: c.MaxDelay, now: now,
		ips: map[string]*ipHits{}, accounts: map[string]*accountFails{},
	}
}

// Attempt counts one attempt from ip; an error once it is over its limit.
func (t *Throttle) Attempt(ip *string) error {
	if t == nil || t.ipMax <= 0 || ip == nil || *ip == "" {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	t.sweep(now)
	h := t.ips[*ip]
	if h == nil || !h.resetAt.After(now) {
		h = &ipHits{resetAt: now.Add(t.window)}
		t.ips[*ip] = h
	}
	h.hits++
	if h.hits > t.ipMax {
		return throttled(h.resetAt.Sub(now))
	}
	return nil
}

// Locked is an error while the account is in its backoff.
func (t *Throttle) Locked(account string) error {
	if t == nil || t.failMax <= 0 || account == "" {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if a := t.accounts[account]; a != nil && a.lockedUntil.After(now) {
		return throttled(a.lockedUntil.Sub(now))
	}
	return nil
}

// Fail records a failed password/code for the account; from the FailMax-th
// consecutive one it is locked for BaseDelay·2^(fails-FailMax), capped.
func (t *Throttle) Fail(account string) {
	if t == nil || t.failMax <= 0 || account == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	t.sweep(now)
	a := t.accounts[account]
	if a == nil {
		a = &accountFails{}
		t.accounts[account] = a
	}
	a.fails++
	a.last = now
	if a.fails >= t.failMax {
		delay := t.maxDelay
		if exp := a.fails - t.failMax; exp < 32 {
			delay = min(t.maxDelay, t.baseDelay*time.Duration(1<<exp))
		}
		a.lockedUntil = now.Add(delay)
	}
}

// Succeed clears the account's failures.
func (t *Throttle) Succeed(account string) {
	if t == nil || account == "" {
		return
	}
	t.mu.Lock()
	delete(t.accounts, account)
	t.mu.Unlock()
}

// sweep drops expired IP windows and accounts idle for 2·MaxDelay (caller
// holds mu), at most once per window.
func (t *Throttle) sweep(now time.Time) {
	if now.Before(t.nextSweep) {
		return
	}
	t.nextSweep = now.Add(t.window)
	for k, h := range t.ips {
		if !h.resetAt.After(now) {
			delete(t.ips, k)
		}
	}
	for k, a := range t.accounts {
		if !a.lockedUntil.After(now) && now.Sub(a.last) > 2*t.maxDelay {
			delete(t.accounts, k)
		}
	}
}

const throttledMessage = "Too many attempts. Please retry later."

// throttled is the 429: Nest-style body with retryAfterSeconds (like the
// magic-link cooldown) plus a Retry-After header.
func throttled(wait time.Duration) error {
	secs := max(1, int(math.Ceil(wait.Seconds())))
	return huma.ErrorWithHeaders(&httpx.Error{Status: http.StatusTooManyRequests, Body: cooldownBody{
		http.StatusTooManyRequests, throttledMessage, "Too Many Requests", secs,
	}}, http.Header{"Retry-After": {strconv.Itoa(secs)}})
}

// accountKey names an account for the throttle: its email (lower-cased, the
// identifier /auth/login takes), else its id.
func accountKey(email *string, id string) string {
	if email != nil && *email != "" {
		return strings.ToLower(strings.TrimSpace(*email))
	}
	return "id:" + id
}
