package authn_test

import (
	"context"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authn"
)

// Security 3.3.3: every session JWT must carry a live `sid`. A token signed
// with a leaked STREAMHUB_JWT_SECRET but minted outside the session table
// (no sid) is a 401, even for sub=admin / sub=ADMIN_USER.
func TestJWTWithoutSidRejected(t *testing.T) {
	s := newStack(t)
	ctx := context.Background()
	tok := s.signup("u@x.io", "longenough")
	uid := s.ten.GetUserByEmail(ctx, "u@x.io").ID

	for _, claims := range []map[string]any{
		{"sub": uid},
		{"sub": "admin"},
		{"sub": adminUser},
		{"sub": "admin", "sid": ""},
		{"sub": "admin", "sid": 42},
		{"sub": "admin", "sid": "nope"},
		{"sub": uid, "sid": "nope"},
	} {
		forged, err := auth.SignJWT(claims, jwtSecret, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		s.expect(s.call("GET", "/auth/me", forged, ""), 401)
	}

	// Every issuer stamps a sid: signup, login (user + break-glass admin).
	for name, issued := range map[string]string{
		"signup":      tok,
		"login":       s.call("POST", "/auth/login", "", `{"user":"u@x.io","password":"longenough"}`).str("data.token"),
		"break-glass": s.adminToken(),
	} {
		c, err := auth.VerifyJWT(issued, jwtSecret)
		if err != nil || c.String("sid") == "" {
			t.Errorf("%s token has no sid: %v", name, err)
		}
		s.expect(s.call("GET", "/auth/me", issued, ""), 200)
	}

	// A sid minted by the session table is accepted.
	sid, err := s.svc.Sessions.Create(ctx, "admin", nil, authn.SessionContext{})
	if err != nil {
		t.Fatal(err)
	}
	withSid, _ := auth.SignJWT(map[string]any{"sub": "admin", "sid": sid}, jwtSecret, time.Hour)
	s.expect(s.call("GET", "/auth/me", withSid, ""), 200, `"via":"admin_jwt"`)
}
