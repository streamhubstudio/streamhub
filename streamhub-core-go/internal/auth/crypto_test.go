package auth

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// testdata/node_vectors.json is produced by the Node core (password.util.ts +
// jwt.util.ts) — these tests lock cross-runtime compatibility.
type nodeVectors struct {
	Password  string `json:"password"`
	Hash      string `json:"hash"`
	JWTSecret string `json:"jwtSecret"`
	JWT       string `json:"jwt"`
}

func loadVectors(t *testing.T) nodeVectors {
	t.Helper()
	b, err := os.ReadFile("testdata/node_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v nodeVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestVerifyPasswordAcceptsNodeHash(t *testing.T) {
	v := loadVectors(t)
	if !VerifyPassword(v.Password, v.Hash) {
		t.Fatal("node scrypt hash did not verify")
	}
	if VerifyPassword(v.Password+"x", v.Hash) {
		t.Fatal("wrong password verified")
	}
}

func TestHashPasswordRoundTrip(t *testing.T) {
	h, err := HashPassword("pw")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("pw", h) || VerifyPassword("nope", h) {
		t.Fatal("round trip failed")
	}
}

func TestVerifyPasswordRejectsMalformed(t *testing.T) {
	for _, s := range []string{"", "scrypt$1$2", "bcrypt$a$b$c$d$e", "scrypt$0$8$1$00$00", "scrypt$32768$8$1$zz$00"} {
		if VerifyPassword("pw", s) {
			t.Fatalf("malformed %q verified", s)
		}
	}
}

func TestVerifyJWTAcceptsNodeToken(t *testing.T) {
	v := loadVectors(t)
	c, err := VerifyJWT(v.JWT, v.JWTSecret)
	if err != nil {
		t.Fatal(err)
	}
	if c.Sub() != "admin" || c.String("role") != "superadmin" {
		t.Fatalf("claims = %v", c)
	}
	if _, err := VerifyJWT(v.JWT, "other"); err == nil {
		t.Fatal("wrong secret accepted")
	}
}

func TestJWTRoundTripAndExpiry(t *testing.T) {
	tok, err := SignJWT(map[string]any{"sub": "u1"}, "k", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if c, err := VerifyJWT(tok, "k"); err != nil || c.Sub() != "u1" {
		t.Fatalf("verify: %v %v", c, err)
	}
	expired, _ := SignJWT(map[string]any{"sub": "u1", "exp": time.Now().Add(-time.Second).Unix()}, "k", time.Hour)
	if _, err := VerifyJWT(expired, "k"); err == nil {
		t.Fatal("expired token accepted")
	}
	if _, err := SignJWT(nil, "", time.Hour); err == nil {
		t.Fatal("empty secret accepted")
	}
}
