package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

const (
	maxSessionsPerUser = 32
	maxSessionsTotal   = 10000
)

type session struct {
	user     string
	created  time.Time
	lastSeen time.Time
}

// sessionStore keeps web UI sessions in memory (a restart logs everyone out,
// by design). Sessions are keyed by the SHA-256 of the cookie value so the
// map never holds a usable credential and lookups do not leak timing about
// valid ids.
type sessionStore struct {
	mu        sync.Mutex
	m         map[string]*session
	idle, max time.Duration
	now       func() time.Time
	lastSweep time.Time
}

func newSessionStore(idle, max time.Duration, now func() time.Time) *sessionStore {
	return &sessionStore{m: map[string]*session{}, idle: idle, max: max, now: now}
}

func sessionKey(id string) string {
	h := sha256.Sum256([]byte(id))
	return hex.EncodeToString(h[:])
}

func (s *sessionStore) expired(x *session, now time.Time) bool {
	return now.Sub(x.lastSeen) > s.idle || now.Sub(x.created) > s.max
}

// create returns a fresh 32-byte random session id for user.
func (s *sessionStore) create(user string) string {
	id := randomString(32)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(s.lastSweep) > time.Minute || len(s.m) >= maxSessionsTotal {
		s.sweepLocked(now)
	}
	// Per-user and global caps: evict the least recently used.
	s.evictLocked(func(x *session) bool { return x.user == user }, maxSessionsPerUser)
	s.evictLocked(func(*session) bool { return true }, maxSessionsTotal)
	s.m[sessionKey(id)] = &session{user: user, created: now, lastSeen: now}
	return id
}

func (s *sessionStore) evictLocked(match func(*session) bool, limit int) {
	for {
		n, oldestK := 0, ""
		var oldest time.Time
		for k, x := range s.m {
			if !match(x) {
				continue
			}
			n++
			if oldestK == "" || x.lastSeen.Before(oldest) {
				oldestK, oldest = k, x.lastSeen
			}
		}
		if n < limit {
			return
		}
		delete(s.m, oldestK)
	}
}

func (s *sessionStore) sweepLocked(now time.Time) {
	for k, x := range s.m {
		if s.expired(x, now) {
			delete(s.m, k)
		}
	}
	s.lastSweep = now
}

// get resolves a cookie value to its user and refreshes the idle timer.
func (s *sessionStore) get(id string) (string, bool) {
	if id == "" {
		return "", false
	}
	k := sessionKey(id)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	x, ok := s.m[k]
	if !ok {
		return "", false
	}
	if s.expired(x, now) {
		delete(s.m, k)
		return "", false
	}
	x.lastSeen = now
	return x.user, true
}

func (s *sessionStore) delete(id string) {
	s.mu.Lock()
	delete(s.m, sessionKey(id))
	s.mu.Unlock()
}

// deleteUser ends every session of user except keepID (if non-empty).
func (s *sessionStore) deleteUser(user, keepID string) {
	keep := ""
	if keepID != "" {
		keep = sessionKey(keepID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, x := range s.m {
		if x.user == user && k != keep {
			delete(s.m, k)
		}
	}
}

func (s *sessionStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
