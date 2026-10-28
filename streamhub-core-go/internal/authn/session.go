package authn

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// SessionContext is the client fingerprint captured when a JWT is minted.
type SessionContext struct {
	IP        *string
	UserAgent *string
}

// SessionContextFrom builds the fingerprint of r (proxy-validated IP, UA
// capped at 400 chars).
func SessionContextFrom(r *http.Request) SessionContext {
	var sc SessionContext
	if ip := httpx.ClientIP(r); ip != "" {
		sc.IP = &ip
	}
	if ua := r.Header.Get("User-Agent"); ua != "" {
		ua = jsx.UTF16Slice(ua, 400)
		sc.UserAgent = &ua
	}
	return sc
}

// SessionSummary is one of the caller's live sessions (GET /auth/sessions).
type SessionSummary struct {
	ID        string  `json:"id"`
	IP        *string `json:"ip"`
	UserAgent *string `json:"userAgent"`
	CreatedAt string  `json:"createdAt"`
	LastSeen  *string `json:"lastSeen"`
	Current   bool    `json:"current"`
}

const (
	activeCacheTTL = 10 * time.Second
	touchInterval  = time.Minute
)

// Sessions is session.service.ts: every human JWT mints a sessions row whose
// id rides in the token as `sid`; the validator rejects a revoked/missing
// sid. isActive is the hot path, fronted by a 10s in-memory cache that every
// revoke clears.
type Sessions struct {
	db  *sql.DB
	log *slog.Logger
	now func() time.Time

	mu        sync.Mutex
	active    map[string]time.Time // sid → known-active until
	lastTouch map[string]time.Time
}

// NewSessions builds the service over the global DB.
func NewSessions(global *sql.DB, log *slog.Logger) *Sessions {
	return &Sessions{db: global, log: log, now: time.Now, active: map[string]time.Time{}, lastTouch: map[string]time.Time{}}
}

// Init creates the sessions table (never fatal).
func (s *Sessions) Init(ctx context.Context) {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         email TEXT,
         ip TEXT,
         user_agent TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         last_seen TEXT,
         revoked_at TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`)
	if err != nil {
		s.log.Error("sessions bootstrap failed (continuing)", "err", err)
	}
}

// Create inserts a session row and returns its id (the JWT `sid`).
func (s *Sessions) Create(ctx context.Context, userID string, email *string, sc SessionContext) (string, error) {
	id := auth.RandomToken(18)
	now := jsx.ISO(s.now())
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (id, user_id, email, ip, user_agent, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, id, userID, email, sc.IP, sc.UserAgent, now, now)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.active[id] = s.now().Add(activeCacheTTL)
	s.mu.Unlock()
	return id, nil
}

// IsActive reports whether sid maps to a live session.
func (s *Sessions) IsActive(ctx context.Context, sid string) bool {
	if sid == "" {
		return false
	}
	s.mu.Lock()
	until, ok := s.active[sid]
	s.mu.Unlock()
	if ok && until.After(s.now()) {
		return true
	}
	var revoked sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT revoked_at FROM sessions WHERE id = ? LIMIT 1`, sid).Scan(&revoked)
	live := err == nil && !revoked.Valid
	s.mu.Lock()
	if live {
		s.active[sid] = s.now().Add(activeCacheTTL)
	} else {
		delete(s.active, sid)
	}
	s.mu.Unlock()
	return live
}

// Touch bumps last_seen at most once a minute per sid (best effort).
func (s *Sessions) Touch(ctx context.Context, sid string) {
	if sid == "" {
		return
	}
	now := s.now()
	s.mu.Lock()
	if now.Sub(s.lastTouch[sid]) < touchInterval {
		s.mu.Unlock()
		return
	}
	s.lastTouch[sid] = now
	s.mu.Unlock()
	if _, err := s.db.ExecContext(ctx, `UPDATE sessions SET last_seen = datetime('now')
            WHERE id = ? AND revoked_at IS NULL`, sid); err != nil {
		s.log.Debug("failed to touch session "+sid, "err", err)
	}
}

// ListForUser returns the user's live sessions, newest first.
func (s *Sessions) ListForUser(ctx context.Context, userID, currentSID string) ([]SessionSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, ip, user_agent, created_at, last_seen
           FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionSummary{}
	for rows.Next() {
		var (
			x            SessionSummary
			ip, ua, seen sql.NullString
		)
		if err := rows.Scan(&x.ID, &ip, &ua, &x.CreatedAt, &seen); err != nil {
			return nil, err
		}
		x.IP, x.UserAgent, x.LastSeen = nullable(ip), nullable(ua), nullable(seen)
		x.Current = x.ID == currentSID
		out = append(out, x)
	}
	return out, rows.Err()
}

// Revoke ends one of the user's own live sessions (false: unknown, already
// revoked, or someone else's).
func (s *Sessions) Revoke(ctx context.Context, userID, sid string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE sessions SET revoked_at = datetime('now')
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, sid, userID)
	s.mu.Lock()
	delete(s.active, sid)
	s.mu.Unlock()
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RevokeOthers ends every other live session of the user.
func (s *Sessions) RevokeOthers(ctx context.Context, userID, exceptSID string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE sessions SET revoked_at = datetime('now')
          WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`, userID, exceptSID)
	s.mu.Lock()
	s.active = map[string]time.Time{}
	if exceptSID != "" {
		s.active[exceptSID] = s.now().Add(activeCacheTTL)
	}
	s.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func nullable(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}
