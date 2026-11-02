package auth

import (
	"sync"
	"time"
)

const (
	loginWindow      = 15 * time.Minute
	maxFailsUserIP   = 5  // per user+IP per window
	maxFailsIP       = 20 // per IP across all user names (password spraying)
	maxLimiterKeys   = 50000
	limiterKeyUserIP = "u|"
	limiterKeyIP     = "i|"
)

// limiter counts failed logins in a sliding window. While a key is over its
// limit every attempt — even with the right password — gets 429, so the
// limiter can not be used as an oracle.
type limiter struct {
	mu        sync.Mutex
	fails     map[string][]time.Time
	now       func() time.Time
	lastSweep time.Time
}

func newLimiter(now func() time.Time) *limiter {
	return &limiter{fails: map[string][]time.Time{}, now: now}
}

func limiterKeys(user, ip string) (string, string) {
	return limiterKeyUserIP + user + "|" + ip, limiterKeyIP + ip
}

// recent drops expired entries of key and returns the live ones (locked).
func (l *limiter) recent(key string, now time.Time) []time.Time {
	ts := l.fails[key]
	i := 0
	for i < len(ts) && now.Sub(ts[i]) >= loginWindow {
		i++
	}
	ts = ts[i:]
	if len(ts) == 0 {
		delete(l.fails, key)
		return nil
	}
	l.fails[key] = ts
	return ts
}

// blocked reports whether user@ip is locked out and for how long.
func (l *limiter) blocked(user, ip string) (time.Duration, bool) {
	now := l.now()
	ku, ki := limiterKeys(user, ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	var wait time.Duration
	for _, k := range []struct {
		key   string
		limit int
	}{{ku, maxFailsUserIP}, {ki, maxFailsIP}} {
		ts := l.recent(k.key, now)
		if len(ts) >= k.limit {
			// Unblocked once the oldest failure that keeps it over the limit expires.
			if w := loginWindow - now.Sub(ts[len(ts)-k.limit]); w > wait {
				wait = w
			}
		}
	}
	return wait, wait > 0
}

// fail records a failed attempt.
func (l *limiter) fail(user, ip string) {
	now := l.now()
	ku, ki := limiterKeys(user, ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) > time.Minute || len(l.fails) >= maxLimiterKeys {
		for k := range l.fails {
			l.recent(k, now)
		}
		l.lastSweep = now
		if len(l.fails) >= maxLimiterKeys {
			// Under a distributed flood keep memory bounded; IP keys survive
			// longest because they are checked for every user name.
			for k := range l.fails {
				if len(l.fails) < maxLimiterKeys/2 {
					break
				}
				if k[:2] == limiterKeyUserIP {
					delete(l.fails, k)
				}
			}
		}
	}
	for _, k := range []struct {
		key string
		cap int
	}{{ku, maxFailsUserIP}, {ki, maxFailsIP}} {
		ts := append(l.recent(k.key, now), now)
		if len(ts) > k.cap {
			ts = ts[len(ts)-k.cap:]
		}
		l.fails[k.key] = ts
	}
}

// success clears the user+IP counter (the per-IP counter keeps counting).
func (l *limiter) success(user, ip string) {
	ku, _ := limiterKeys(user, ip)
	l.mu.Lock()
	delete(l.fails, ku)
	l.mu.Unlock()
}
