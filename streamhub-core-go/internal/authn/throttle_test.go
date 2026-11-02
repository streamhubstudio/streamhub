package authn_test

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authn"
)

// Security 3.3.4 M3: password and TOTP guessing had no brake of its own —
// only the AUTH_RATE_LIMIT_* window per IP in front of the login routes
// (operator-tunable, not on the 2FA routes) and the opt-in autoban. A botnet
// spreading guesses over many IPs, or a stolen magic link reused against
// its 2FA code, ran unbounded.

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func (s *stack) expectThrottled(r resp, retryAfter int) {
	s.t.Helper()
	s.expect(r, 429, `"statusCode":429`, `"error":"Too Many Requests"`, `"message":"Too many attempts. Please retry later."`,
		fmt.Sprintf(`"retryAfterSeconds":%d`, retryAfter))
	if got := r.hdr.Get("Retry-After"); got != fmt.Sprint(retryAfter) {
		s.t.Fatalf("Retry-After %q, want %d", got, retryAfter)
	}
}

// Per account: 5 consecutive failures (from any IPs) lock it for 30s,
// doubling per further failure; the right password is refused meanwhile and
// a success clears the count.
func TestLoginThrottlePerAccount(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)}
	s := newStackThrottled(t, authn.NewThrottle(authn.ThrottleConfig{IPMax: 1000, FailMax: 5}, clk.now))
	s.signup("alice@x.io", "longenough")
	s.signup("bob@x.io", "longenough")
	ok := `{"user":"alice@x.io","password":"longenough"}`
	bad := `{"user":"Alice@X.io","password":"guess"}`

	for i := 1; i <= 5; i++ {
		s.expect(s.call("POST", "/auth/login", "", bad, fmt.Sprintf("203.0.113.%d", i)), 401, `"Invalid username or password"`)
	}
	s.expectThrottled(s.call("POST", "/auth/login", "", ok, "198.51.100.77"), 30)
	s.expectThrottled(s.call("POST", "/auth/login", "", bad, "198.51.100.78"), 30) // not even checked
	s.expect(s.call("POST", "/auth/login", "", `{"user":"bob@x.io","password":"longenough"}`), 200)

	clk.advance(31 * time.Second)
	s.expect(s.call("POST", "/auth/login", "", ok), 200) // clears the count
	for i := 0; i < 4; i++ {
		s.expect(s.call("POST", "/auth/login", "", bad), 401)
	}
	s.expect(s.call("POST", "/auth/login", "", ok), 200) // 4 failures don't lock

	for i := 0; i < 5; i++ {
		s.expect(s.call("POST", "/auth/login", "", bad), 401)
	}
	clk.advance(31 * time.Second)
	s.expect(s.call("POST", "/auth/login", "", bad), 401) // 6th failure → 60s
	s.expectThrottled(s.call("POST", "/auth/login", "", ok), 60)
	clk.advance(61 * time.Second)
	s.expect(s.call("POST", "/auth/login", "", bad), 401) // 7th → 120s
	clk.advance(119 * time.Second)
	s.expectThrottled(s.call("POST", "/auth/login", "", ok), 1)
	clk.advance(time.Second)
	s.expect(s.call("POST", "/auth/login", "", ok), 200)

	// The break-glass admin is throttled per (account, IP): an attacker locks
	// out only their own address, never the platform owner.
	adminOK := `{"user":"` + adminUser + `","password":"` + adminPass + `"}`
	for i := 0; i < 5; i++ {
		s.expect(s.call("POST", "/auth/login", "", `{"user":"`+adminUser+`","password":"guess"}`, "203.0.113.66"), 401)
	}
	s.expectThrottled(s.call("POST", "/auth/login", "", adminOK, "203.0.113.66"), 30)
	s.expect(s.call("POST", "/auth/login", "", adminOK, "198.51.100.5"), 200)

	// Unknown accounts are throttled the same (no existence oracle), and the
	// security module's autoban is off throughout: this is independent of it.
	for i := 0; i < 5; i++ {
		s.expect(s.call("POST", "/auth/login", "", `{"user":"ghost@x.io","password":"guess"}`), 401)
	}
	s.expectThrottled(s.call("POST", "/auth/login", "", `{"user":"ghost@x.io","password":"guess"}`), 30)
	s.expect(s.call("GET", "/security/status", s.adminToken(), ""), 200, `"autoban":{"enabled":false`)
}

// Per IP: at most 10 attempts a minute over every throttled route, whatever
// the account, independent of the (here lifted) AUTH_RATE_LIMIT_* window.
func TestAuthThrottlePerIP(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)}
	s := newStackThrottled(t, authn.NewThrottle(authn.ThrottleConfig{IPMax: 10}, clk.now))
	const ip = "203.0.113.9"
	for i := 0; i < 8; i++ {
		s.expect(s.call("POST", "/auth/login", "", fmt.Sprintf(`{"user":"u%d@x.io","password":"guess"}`, i), ip), 401)
	}
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"not-a-real-token-1"}`, ip), 401)
	s.expect(s.call("POST", "/auth/magic/verify", "", `{"token":"not-a-real-token-2"}`, ip), 401)
	clk.advance(15 * time.Second)
	s.expectThrottled(s.call("POST", "/auth/login", "", `{"user":"x@x.io","password":"guess"}`, ip), 45)
	s.expectThrottled(s.call("POST", "/auth/magic/verify", "", `{"token":"not-a-real-token-3"}`, ip), 45)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"x@x.io","password":"guess"}`, "203.0.113.10"), 401)

	clk.advance(45 * time.Second)
	s.expect(s.call("POST", "/auth/login", "", `{"user":"x@x.io","password":"guess"}`, ip), 401)
}

// TOTP codes: wrong codes on /account/2fa/* and on the magic-link verify
// count against the account; a missing code (the 2FA prompt) doesn't.
func TestTotpCodeThrottle(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)}
	s := newStackThrottled(t, authn.NewThrottle(authn.ThrottleConfig{IPMax: 1000, FailMax: 5}, clk.now))
	tok := s.signup("me@x.io", "longenough")
	secret := s.call("POST", "/account/2fa/setup", tok, "").str("data.secret")
	for i := 0; i < 5; i++ {
		s.expect(s.call("POST", "/account/2fa/enable", tok, `{"code":"000000"}`), 400, `"invalid verification code"`)
	}
	s.expectThrottled(s.call("POST", "/account/2fa/enable", tok, `{"code":"`+auth.TOTPCode(secret, time.Now())+`"}`), 30)
	clk.advance(30 * time.Second)
	s.expect(s.call("POST", "/account/2fa/enable", tok, `{"code":"`+auth.TOTPCode(secret, time.Now())+`"}`), 200)

	// One magic link, many code guesses: the link survives a wrong code.
	s.call("POST", "/auth/magic-link", "", `{"email":"me@x.io"}`)
	link := s.mail.lastToken(t)
	verify := func(code string) resp {
		return s.call("POST", "/auth/magic/verify", "", `{"token":"`+link+`"`+code+`}`)
	}
	for i := 0; i < 3; i++ {
		s.expect(verify(""), 401, `"totp_required"`)
	}
	for i := 0; i < 5; i++ {
		s.expect(verify(`,"code":"000000"`), 401, `"totp_invalid"`)
	}
	r := verify(`,"code":"` + auth.TOTPCode(secret, time.Now()) + `"`)
	s.expectThrottled(r, 30)
	// The lock is the account's: password login is refused too.
	s.expectThrottled(s.call("POST", "/auth/login", "", `{"user":"me@x.io","password":"longenough"}`), 30)
	clk.advance(30 * time.Second)
	s.expect(verify(`,"code":"`+auth.TOTPCode(secret, time.Now())+`"`), 200)
	if strings.Contains(r.raw, "token") {
		t.Fatal("a throttled verify must not mint a session")
	}
}

// Env knobs: STREAMHUB_AUTH_IP_LIMIT / STREAMHUB_AUTH_ACCOUNT_FAILS, 0 = off.
func TestThrottleConfigFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if c := authn.ThrottleConfigFromEnv(env(nil)); c.IPMax != 10 || c.FailMax != 5 {
		t.Fatalf("defaults %+v", c)
	}
	c := authn.ThrottleConfigFromEnv(env(map[string]string{"STREAMHUB_AUTH_IP_LIMIT": "0", "STREAMHUB_AUTH_ACCOUNT_FAILS": "junk"}))
	if c.IPMax != 0 || c.FailMax != 5 {
		t.Fatalf("%+v", c)
	}
	th := authn.NewThrottle(authn.ThrottleConfig{}, nil) // both off
	ip := "203.0.113.1"
	for i := 0; i < 100; i++ {
		th.Fail("a@x.io")
		if th.Attempt(&ip) != nil || th.Locked("a@x.io") != nil {
			t.Fatal("a disabled throttle never refuses")
		}
	}
}
